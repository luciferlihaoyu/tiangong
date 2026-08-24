/**
 * 任务进度回写共享逻辑（单一事实源）
 *
 * updateProgress 的业务核心原生于 api/task-router.ts，任务 2.1 为 MCP 执行面工具
 * （report_progress）抽出为共享 lib：tRPC 面与 MCP 工具面必须走同一份回写决策
 * （beidou 拒绝 / 终态不可变 / 越权防护 / 完成闸门 / 长产物通道 / 用量记账 /
 * 统一归档入口），防止两份拷贝漂移（本仓库 P0 修复过的"钩子复制漂移"教训）。
 *
 * 入参 zod 定义（UpdateProgressInputSchema）在此导出，task-router 与 MCP
 * report_progress 工具共用同一套校验。
 *
 * TRPCError 从本 lib 抛出会正常穿透 tRPC 错误处理（行为与原先一致）；
 * MCP 工具面捕获后转 failResult。
 *
 * 依赖方向：本模块只依赖叶子（ws-manager / collaboration-events / execution-gate /
 * task-finalize / external-usage），无环。
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { tasks, taskArtifacts } from "@db/schema";
import { wsManager } from "../ws-manager";
import { emitCollabSummaryForTask } from "./collaboration-events";
import { checkCompletionGate, parkTaskForApproval, type Db } from "./execution-gate";
import { finalizeCompletedTask } from "./task-finalize";
import { recordExternalUsage } from "./external-usage";
import { syncTaskLessonToXuanji } from "./xuanji-sync";
import { notifyLessonRecorded } from "./notification-hooks";
import { checkTaskWriteAuthorized, getArtifactContentTooLargeError, assertTaskWriteAuthorizedOrThrow } from "./task-authz";

/** updateProgress 入参（task-router 与 MCP report_progress 共用） */
export const UpdateProgressInputSchema = z.object({
  id: z.number(),
  progress: z.number().min(0).max(100),
  status: z.enum(["running", "pending", "done", "failed", "queued"]).optional(),
  lifecycleStatus: z
    .enum([
      "created", "queued", "claimed", "dispatched", "accepted", "working",
      "awaiting_result", "submitted", "reviewing", "completed", "failed", "timeout", "cancelled",
    ])
    .optional(),
  output: z.string().optional(),
  error: z.string().optional(),
  // 任务 1.4：外部执行体上报的本次任务模型用量（完成时入账，尽力而为）
  usage: z
    .object({
      model: z.string().min(1).max(100),
      promptTokens: z.number().int().min(0).max(10_000_000),
      completionTokens: z.number().int().min(0).max(10_000_000),
      cachedPromptTokens: z.number().int().min(0).max(10_000_000).optional(),
    })
    .optional(),
  // 任务 1.5：长产物通道——逐条写 task_artifacts 后由 alist-sync 的遍历逻辑
  // 自动上传（它会上传所有 content 非空且 type 非 alist_sync/xuanji_memory 的行）
  artifacts: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        content: z.string().min(1).max(50_000),
        mimeType: z.string().max(50).optional(),
      })
    )
    .max(5)
    .optional(),
});

export type UpdateProgressInput = z.infer<typeof UpdateProgressInputSchema>;

/** 调用方身份：tRPC 的 ctx.apiKeyAgentId（null=登录用户；-1=管理型 Key；>0=Key 绑定的 agent） */
export interface ReportTaskProgressActor {
  apiKeyAgentId: number | null;
}

/**
 * updateProgress 业务核心（单一事实源）：
 *   beidou 拒绝 → 终态不可变 → 越权 FORBIDDEN → 完成闸门停放 → update →
 *   artifacts 逐条插入 → 完成时 recordExternalUsage + finalizeCompletedTask →
 *   wsManager 广播 → 协作汇总。
 * 返回形状与原 task.updateProgress mutation 完全一致。
 */
export async function reportTaskProgress(
  db: Db,
  input: UpdateProgressInput,
  actor: ReportTaskProgressActor
): Promise<{ success: true } | { success: false; error: string }> {
  const taskRow = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, input.id))
    .then((r) => r[0]);

  // 任务不存在（评审 minor ⑦）：此前回写不存在任务静默 success（no-op），调用方（dsh 机器）
  // 误以为已生效；补"任务不存在"业务失败，MCP 面据此置 isError。
  if (!taskRow) {
    return { success: false, error: "任务不存在" };
  }

  if (taskRow.originSystem === "beidou") {
    return { success: false, error: "External tasks reject weak updateProgress mutations" };
  }
  if (taskRow && (taskRow.status === "done" || taskRow.status === "failed" || ["completed", "failed", "timeout", "cancelled"].includes(taskRow.lifecycleStatus ?? ""))) {
    return { success: false, error: "Terminal task state is immutable" };
  }

  // 越权防护（任务 1.4/1.5）：MCP Key 绑定的 agent 与任务认领人不符时，
  // 禁止借他人任务提交 usage/artifacts（防止 A 的 Key 给 B 的任务灌假账/产物）。
  // 登录用户（apiKeyAgentId=null）与管理型 Key（-1，未绑定 agent，同 claimTask 权限模型）放行。
  // 逻辑已抽到 task-authz.ts（2.1+2.2 评审 minor 单一事实源），此处与 submit_artifact 共用。
  if (taskRow && (input.usage !== undefined || input.artifacts !== undefined)) {
    // 越权封装（评审 minor ⑥）：拒绝时抛 FORBIDDEN TRPCError，放行无副作用
    assertTaskWriteAuthorizedOrThrow(checkTaskWriteAuthorized(actor.apiKeyAgentId, taskRow));
  }

  // 字节上限校验（评审 minor ③）：长产物通道逐条写 task_artifacts 前先整体校验，
  // 任何一条超限即整体拒绝（PAYLOAD_TOO_LARGE），避免任务状态已更新后才发现产物超限
  // 造成半更新（不截断，让调用方看到失败而非静默数据丢失）。
  if (taskRow && input.artifacts?.length) {
    for (const artifact of input.artifacts) {
      const tooLargeError = getArtifactContentTooLargeError(artifact.content);
      if (tooLargeError) {
        throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: tooLargeError });
      }
    }
  }

  // 执行审批闸门：高风险任务不得通过 updateProgress 强制完成（connector 不得 self-approve）
  if (taskRow && (input.status === "done" || input.lifecycleStatus === "completed")) {
    const gate = checkCompletionGate(taskRow);
    if (gate.status === "blocked") {
      await parkTaskForApproval(db, taskRow, { requiresApproval: true, riskTypes: gate.riskTypes });
      return { success: false, error: gate.reason };
    }
  }

  const update: Record<string, unknown> = { progress: input.progress };
  if (input.status) update.status = input.status;
  if (input.lifecycleStatus) update.lifecycleStatus = input.lifecycleStatus;
  if (input.output !== undefined) update.output = input.output;
  if (input.error !== undefined) update.error = input.error;
  await db.update(tasks).set(update).where(eq(tasks.id, input.id));

  // 长产物通道（任务 1.5）：逐条写 task_artifacts。必须在 finalizeCompletedTask 之前落库，
  // 这样完成时的 alist-sync 遍历才会把它们一并上传网盘。
  if (taskRow && input.artifacts?.length) {
    for (const artifact of input.artifacts) {
      await db.insert(taskArtifacts).values({
        taskId: taskRow.id,
        agentId: taskRow.agentId ?? null,
        type: "external_output",
        name: artifact.name,
        content: artifact.content,
        mimeType: artifact.mimeType ?? null,
      });
    }
  }

  // 完成任务（通过审批闸门后）→ 统一归档入口：写璇玑记忆 + 上传 AList 产物（尽力而为，失败不影响完成）
  if (taskRow && (input.status === "done" || input.lifecycleStatus === "completed")) {
    // 外部用量记账（任务 1.4）：完成时把执行体上报的 token 用量折算入账
    // （写 token_usage + 原子递增 agents.spentCents，尽力而为，失败不影响完成）
    if (input.usage) {
      await recordExternalUsage(db, {
        taskId: taskRow.id,
        agentId: taskRow.agentId,
        model: input.usage.model,
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens,
        cachedPromptTokens: input.usage.cachedPromptTokens,
        source: "external",
      });
    }
    await finalizeCompletedTask(db, {
      id: taskRow.id,
      taskId: taskRow.taskId,
      name: taskRow.name,
      description: taskRow.description,
      input: taskRow.input,
      output: input.output ?? taskRow.output,
      agentId: taskRow.agentId,
      status: "done",
      lifecycleStatus: input.lifecycleStatus ?? "completed",
    });
  }
  // 失败教训写璇玑（任务 3.1 质量反哺）：外部执行体回写 status=failed 即视为终态失败——
  // 重试由外部自主决定（failed→queued 的重派不经过天宫），天宫不代管重试轮次，
  // 因此与内部 Runner 的"重试耗尽才写"判定不同，此处每次失败回写都归档教训
  // （幂等标记 xuanji_lesson 保证同一任务至多一条）。落库后尽力而为，失败绝不影响回写主流程。
  if (taskRow && (input.status === "failed" || input.lifecycleStatus === "failed")) {
    try {
      await syncTaskLessonToXuanji(db, {
        id: taskRow.id,
        taskId: taskRow.taskId,
        name: taskRow.name,
        description: taskRow.description,
        input: taskRow.input,
        output: input.output ?? taskRow.output,
        agentId: taskRow.agentId,
        status: "failed",
        lifecycleStatus: input.lifecycleStatus ?? "failed",
        // 失败原因优先取本次回写附带的 error，缺省回退 tasks 行已存的 error 列
        error: input.error ?? taskRow.error,
      });
    } catch (error) {
      // syncTaskLessonToXuanji 自身已全 catch；此处兜底防御未来行为变化破坏回写主流程
      console.warn(`[task-writeback] xuanji lesson sync failed for task ${taskRow.taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 失败教训通知（NC-3）：外部失败回写是终态失败，落库后记一条 lesson_recorded 通知
    // （尽力而为，失败绝不影响回写主流程；60s 防抖防同一任务的 lesson/task-failed 路径重复）。
    try {
      await notifyLessonRecorded(
        db,
        {
          id: taskRow.id,
          taskId: taskRow.taskId,
          name: taskRow.name,
          agentId: taskRow.agentId,
          error: input.error ?? taskRow.error ?? null,
        },
        "task-writeback"
      );
    } catch (error) {
      // notifyLessonRecorded 自身已全 catch；此处兜底防御未来行为变化破坏回写主流程
      console.warn(`[task-writeback] notification failed for task ${taskRow.taskId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 通知 Dashboard：任务状态变更
  const t = await db.select({ taskId: tasks.taskId, name: tasks.name, agentId: tasks.agentId }).from(tasks).where(eq(tasks.id, input.id)).then(r => r[0]);
  wsManager.broadcastToDashboard({
    type: "task_update",
    action: "updated",
    id: input.id,
    taskId: t?.taskId,
    name: t?.name,
    status: input.status,
    progress: input.progress,
    agentId: t?.agentId,
    timestamp: new Date().toISOString(),
  });

  if (input.status === "done" || input.status === "failed") {
    await emitCollabSummaryForTask(input.id);
  }

  return { success: true };
}
