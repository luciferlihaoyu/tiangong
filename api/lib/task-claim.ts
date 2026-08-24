/**
 * 任务认领共享逻辑（单一事实源）
 *
 * 认领序列原生于 api/agent-router.ts（claimTask / updateHeartbeat），任务 2.1 为
 * MCP 执行面工具（claim_task）抽出为共享 lib：tRPC 面与 MCP 工具面必须走同一份
 * 认领决策，防止两份拷贝漂移（本仓库 P0 修复过的"钩子复制漂移"教训）。
 *
 * 序列：查 agent → 预算熔断检查 → 查可认领任务（执行审批闸门）→
 *       置 running/claimed/claimedAt/agentId → agent busy。
 *
 * 注意：MCP Key 与目标 Agent 的匹配校验是 HTTP 层鉴权（agent-router /
 * api/mcp/server.ts 各自持有），不属于本业务核心。
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import { agents, tasks } from "@db/schema";
import { getApprovalState, selectExecutableTask, type Db } from "./execution-gate";
import { notifyBudgetExhausted } from "./notification-hooks";

/** 认领结果中的任务投影（形状对齐 agent.claimTask 既有返回） */
export interface ClaimedTask {
  id: number;
  taskId: string;
  name: string;
  description: string | null;
  input: string | null;
  priority: number | null;
  /** 执行审批闸门当前评估：该任务是否要求人工审批 */
  approvalRequired: boolean;
}

export type ClaimNextReason = "budget_exhausted" | "agent_not_found";

/**
 * 查找该 Agent 可认领的 queued 任务（含通用任务 agentId=null）。
 * 执行审批闸门：高风险且未批准的任务被停放待审批（不会返回），
 * 已批准的高风险任务与低风险任务照常返回。
 */
export async function findClaimableTask(db: Db, agentId: number) {
  const claimableTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, "queued"), eq(tasks.agentId, agentId)))
    .orderBy(desc(tasks.priority))
    .limit(20);
  const genericTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, "queued"), isNull(tasks.agentId)))
    .orderBy(desc(tasks.priority))
    .limit(20);
  return selectExecutableTask(db, [...claimableTasks, ...genericTasks]);
}

/**
 * 预算熔断（任务 1.4）：预算已耗尽的 agent 是否应被暂停认领。
 * budgetCents <= 0 视为不限额。
 */
export function isBudgetExhausted(agent: { budgetCents: number | null; spentCents: number | null }): boolean {
  const budgetCents = agent.budgetCents ?? 0;
  const spentCents = agent.spentCents ?? 0;
  return budgetCents > 0 && spentCents >= budgetCents;
}

/**
 * 完整认领序列（单一事实源）：
 *   1. 查 agent（不存在 → { task: null, reason: "agent_not_found" }）
 *   2. 预算熔断：耗尽 → { task: null, reason: "budget_exhausted" }
 *      （轻量停放：只跳过认领并带原因，不改任务状态；预算恢复后下一轮即可自动认领）
 *   3. findClaimableTask（执行审批闸门拦截高风险任务）→ 无任务 → { task: null }
 *   4. 置 running/lifecycleStatus=claimed/claimedAt/agentId，agent 置 busy
 */
export async function claimNextTask(
  db: Db,
  agentId: number
): Promise<{ task: ClaimedTask | null; reason?: ClaimNextReason }> {
  // 1. 查询 Agent 信息
  const agentRows = await db
    .select()
    .from(agents)
    .where(eq(agents.id, agentId));
  const agent = agentRows[0];
  if (!agent) {
    return { task: null, reason: "agent_not_found" };
  }

  // 2. 任务级预算熔断（任务 1.4）：耗尽预算的 agent 不再认领新任务。
  //    取舍说明：采用"轻量停放"——只跳过认领并返回原因，不把 queued 任务改成
  //    boardStatus=blocked。若停放为 blocked，预算恢复（管理员调高 budgetCents）后
  //    还需一条人工/后台"解锁"路径任务才能重新可认领，容易引入新的死锁路径；
  //    保持 queued 则预算一恢复即自动可认领，代价是任务面板上看不到"因预算停放"的标记。
  if (isBudgetExhausted(agent)) {
    // 预算熔断通知（NC-5）：24h 防抖记一条 budget_exhausted（尽力而为，失败绝不影响认领决策）。
    try {
      await notifyBudgetExhausted(db, agent);
    } catch (error) {
      console.warn(`[task-claim] budget notification failed for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { task: null, reason: "budget_exhausted" };
  }

  // 3. 查找可认领的任务：状态为 queued，且 agentId 匹配此 Agent 或为 null（通用任务）。
  //    执行审批闸门在此拦截高风险任务（停放待审批），只有低风险或已批准的任务才会被认领。
  const task = await findClaimableTask(db, agentId);

  if (!task) {
    return { task: null };
  }

  // 4. 认领任务：更新任务状态为 running，设置 agentId，A2A-lite lifecycle
  await db
    .update(tasks)
    .set({
      status: "running",
      lifecycleStatus: "claimed",
      agentId,
      claimedAt: new Date(),
    })
    .where(eq(tasks.id, task.id));

  // 更新 Agent 状态为 busy
  await db
    .update(agents)
    .set({ status: "busy" })
    .where(eq(agents.id, agentId));

  return {
    task: {
      id: task.id,
      taskId: task.taskId,
      name: task.name,
      description: task.description,
      input: task.input,
      priority: task.priority ?? null,
      approvalRequired: getApprovalState(task.input).required,
    },
  };
}
