/**
 * Blocked recovery sweeper: 非审批类 blocked 任务超时自动恢复。
 *
 * 背景：任务被人工 block（或依赖卡住）后 boardStatus=blocked，唯一出路是
 * 管理员手动 Unblock——长期无人处理就永远卡死。本 sweeper 对「blocked 超过
 * stale 阈值」的任务自动恢复到阻塞前状态（从 task_messages 的 block 事件
 * 推断，默认回 ready）。
 *
 * 排除项：审批闸门停放的任务（input metadata.routing.approvalRequired &&
 * approval.decision=pending）——它们等的是人工批准，不能自动放行，提醒由
 * sweepApprovalNag 负责。
 *
 * 只处理 status="pending" 的任务：running/queued 的执行中任务不碰。
 * 可通过 TIANGONG_BLOCKED_RECOVER_STALE_MS 调整阈值（默认 24h）。
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { desc } from "drizzle-orm";
import { tasks, taskMessages } from "@db/schema";

import { emitSweeperAudit, notifyAgentMailbox } from "./notify";
import { getApprovalState } from "../execution-gate";
import { sweeperConfig } from "./config";
import type { Db } from "./db";

export async function sweepBlockedRecovery(db: Db, now: Date): Promise<void> {
  const staleMs = sweeperConfig.blockedRecoverStaleMs;
  const cutoff = new Date(now.getTime() - staleMs);
  const staleBlocked = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "pending"),
        eq(tasks.boardStatus, "blocked"),
        isNotNull(tasks.blockedAt),
        lt(tasks.blockedAt, cutoff)
      )
    )
    .limit(50);

  for (const task of staleBlocked) {
    // 审批停放的任务不自动恢复——等人工批准（approve 端点负责放行）
    const approval = getApprovalState(task.input);
    if (approval.required && approval.decision === "pending") continue;

    // 从 block 事件推断阻塞前的 boardStatus（与 taskboard.unblock 同一逻辑）
    const messages = await db
      .select()
      .from(taskMessages)
      .where(and(eq(taskMessages.taskId, task.id), eq(taskMessages.eventType, "system")))
      .orderBy(desc(taskMessages.createdAt))
      .limit(20);

    let previousStatus = "ready";
    for (const msg of messages) {
      let meta: Record<string, unknown> | null = null;
      try {
        meta = msg.metadata ? (JSON.parse(msg.metadata) as Record<string, unknown>) : null;
      } catch {
        meta = null;
      }
      if (meta?.action === "block" && typeof meta.previousBoardStatus === "string") {
        previousStatus = meta.previousBoardStatus;
        break;
      }
    }
    // 防御：推断结果是 blocked 自身或终态时回落 ready
    if (!previousStatus || ["blocked", "done", "failed", "cancelled"].includes(previousStatus)) {
      previousStatus = "ready";
    }

    await db
      .update(tasks)
      .set({ boardStatus: previousStatus, blockedAt: null, updatedAt: now })
      .where(eq(tasks.id, task.id));

    try {
      await db.insert(taskMessages).values({
        taskId: task.id,
        eventType: "system",
        content: `Blocked 超过 ${staleMs}ms 未处理，自动恢复到 ${previousStatus}`,
        metadata: JSON.stringify({
          action: "blocked_recovery_sweep",
          previousBoardStatus: "blocked",
          restoredBoardStatus: previousStatus,
        }),
      });
    } catch {
      // 事件记录失败不影响恢复主流程
    }

    emitSweeperAudit({
      event: "task:blocked_recovered",
      entityType: "task",
      entityId: task.id,
      metadata: { taskId: task.taskId, status: previousStatus },
    });

    if (task.agentId !== null) {
      try {
        await notifyAgentMailbox({
          toAgentId: task.agentId,
          taskId: task.id,
          subject: `任务 ${task.taskId} 阻塞超时已自动恢复`,
          body: `任务「${task.name}」blocked 超过 ${staleMs}ms 未处理，已自动恢复到 ${previousStatus} 状态，请关注。`,
        });
      } catch {
        // 通知失败不影响恢复主流程
      }
    }
  }

  if (staleBlocked.length > 0) {
    console.log(`[sweepBlockedRecovery] processed ${staleBlocked.length} stale blocked task(s)`);
  }
}
