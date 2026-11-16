/**
 * 验收收尾（review）共享过程体 —— a2a.review（tRPC）与 review_task（MCP）单一事实源。
 *
 * 抽出动机（p2.5-a，#211 教材）：api/mcp/server.ts 的口径注释写明「completed 只能由
 * 验收通道（a2a.review / taskboard.approve）推进」，但 MCP 工具面没有 review 入口——
 * 外部验收方（走 MCP Key 接入的 L1 闸）永远无法收尾 submitted 单。新增工具若另写一份
 * 过程体，与本文件构成"钩子复制漂移"（本仓库 P0 修复过的教训同源），故把 a2a-router
 * review 的过程体**逐字节搬入**本 lib，tRPC 面改为薄壳调用；MCP 工具面复用同一函数、
 * 同一 canReviewTask 判定、同一 checkCompletionGate 防线。
 *
 * ⚠️ 行为契约（tests/api/mcp-review-task.test.ts 钉死，改动前先读）：
 *   - 鉴权不放宽：actor 语义与 tRPC ctx.apiKeyAgentId 完全同口径
 *     （null=登录用户；-1=管理型 Key；>0=Key 绑定 agent），userRole 缺省规则一致
 *     （有 user 取其 role，无 user 为 null——绝不把"身份不明"当管理位放行）。
 *   - 高风险 self-approve 防线（c27138f）原样保留：approved=true 必过
 *     checkCompletionGate，blocked 即 parkTaskForApproval 停放、绝不落 completed。
 *   - completed 的归档 finalize 恰好一次由本过程体触发（t2-4 两段式第二段）。
 *   - 返回形状与旧 a2a.review 过程体逐字段一致；"任务不存在"仍抛 Error("Task not found")
 *     （tRPC 面既有异常形状；MCP 工具面在 handler 层 catch 转 errorResult，不抛穿协议层）。
 */
import { eq } from "drizzle-orm";
import { tasks, agents } from "@db/schema";
import type { Db } from "./task-transition";
import { wsManager } from "../ws-manager";
import { checkCompletionGate, parkTaskForApproval } from "./execution-gate";
import { canReviewTask } from "./task-authz";
import { enqueueTaskFinalize } from "./finalize-actions";
import { LIFECYCLE_STATUSES, isValidLifecycleTransition, applyTaskTransition } from "./task-transition";
import { recordTaskEvent } from "./task-events";

export interface ReviewTaskInput {
  taskId: number;
  approved: boolean;
  note?: string;
}

/** 与旧 a2a.review 过程体返回形状一致（gate blocked 分支额外带 lifecycleStatus，同为存量形状）。 */
export type ReviewTaskResult = { success: true; lifecycleStatus: string } | {
  success: false;
  error: string;
  lifecycleStatus?: string | null;
};

/**
 * 执行一次验收收尾。过程体自 a2a-router.review 逐字节搬入（仅把 ctx 拆成显式的
 * actor 三字段，其余判断顺序、错误文案、副作用一概不动）。
 */
export async function reviewTask(
  db: Db,
  actor: { userRole: string | null; userId: number | null; apiKeyAgentId: number | null },
  input: ReviewTaskInput
): Promise<ReviewTaskResult> {
  const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
  if (!task) throw new Error("Task not found");

  // 验收身份判定（2026-11 缺陷修复 + A2A 编排闭环补全）：此前挂 adminQuery，API Key 在中间件即 401，
  // connector 自动收尾永远进不了过程体（"Task reviewed and approved" 审计长期缺失、
  // 下方旧的 admin-agent 检查成为死代码）。现改 authedQuery + canReviewTask：
  // admin 登录用户 / 管理型 Key / 任务执行者本人 / admin 角色 agent / **被指派的验收方
  // （task.reviewerId，submit 时按父任务 agentId > dispatcherAgentId 落库）**可验收；
  // 普通登录用户与非执行者且非验收方的 agent Key 拒绝。
  // ⚠️ 高风险 self-approve 防线仍在下方 checkCompletionGate——本判定不放宽闸门，
  //    reviewer 验收高风险任务同样被拦停，绝不落 completed。
  let actorAgentRole: string | null = null;
  if (actor.apiKeyAgentId !== null && actor.apiKeyAgentId > 0) {
    const actorAgent = await db.select().from(agents).where(eq(agents.id, actor.apiKeyAgentId)).then((r) => r[0]);
    actorAgentRole = actorAgent?.role ?? null;
  }
  const authz = canReviewTask(
    { userRole: actor.userRole ?? null, userId: actor.userId ?? null, apiKeyAgentId: actor.apiKeyAgentId },
    { agentId: task.agentId, reviewerId: task.reviewerId ?? null },
    actorAgentRole
  );
  if (!authz.ok) {
    return { success: false, error: authz.reason };
  }
  const actorLabel = authz.actorLabel;

  // 只能从 submitted 或 reviewing 进入 review
  if (!["submitted", "reviewing"].includes(task.lifecycleStatus ?? "")) {
    return { success: false, error: `Cannot review task from status ${task.lifecycleStatus}. Must be submitted or reviewing.` };
  }

  // 执行审批闸门：高风险任务不得被无条件批准完成（connector 不得 self-approve）
  if (input.approved) {
    const gate = checkCompletionGate(task);
    if (gate.status === "blocked") {
      await parkTaskForApproval(db, task, { requiresApproval: true, riskTypes: gate.riskTypes });
      return { success: false, error: gate.reason, lifecycleStatus: task.lifecycleStatus };
    }
  }

  const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = input.approved ? "completed" : "reviewing";
  if (!isValidLifecycleTransition(task.lifecycleStatus ?? "created", nextStatus)) {
    return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
  }

  // completedAt 由服务在 approved 时按同一个 at 写入（非 approved 分支原先只是把
  // task.completedAt 原值再写一遍，等价于不动，故不再显式传）。
  const transition = await applyTaskTransition(db, {
    taskId: input.taskId,
    lifecycleStatus: nextStatus,
    status: input.approved ? "done" : task.status,
    at: new Date(),
    expectedRevision: task.stateRevision,
    extra: { progress: input.approved ? 100 : task.progress },
  });
  if (!transition.ok) {
    return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
  }

  await recordTaskEvent({
    taskId: input.taskId,
    eventType: input.approved ? "result" : "system",
    // 验收记录写明"谁验收的"：actorLabel 同时进内容（人可读）与 metadata（机器可查）。
    content: `${input.note ?? (input.approved ? "Task reviewed and approved" : "Task under review")} [by ${actorLabel}]`,
    metadata: { approved: input.approved, previousStatus: task.lifecycleStatus, lifecycleStatus: nextStatus, actorLabel },
  });

  if (input.approved) {
    // 审批通过 → 统一归档入口。§3-4 可靠投递：改为持久入队。
    await enqueueTaskFinalize(db, {
      taskId: task.id,
      taskPublicId: task.taskId,
      outcome: "completed",
    });
    wsManager.broadcastToDashboard({
      type: "a2a_complete",
      taskId: task.taskId,
      taskDbId: input.taskId,
      lifecycleStatus: nextStatus,
      timestamp: new Date().toISOString(),
    });
  }

  return { success: true, lifecycleStatus: nextStatus };
}
