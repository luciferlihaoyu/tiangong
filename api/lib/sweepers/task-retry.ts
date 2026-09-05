/**
 * Task retry sweeper: 执行失败任务的自动重试（有限次）。
 *
 * 背景：超时路径（sweepTaskTimeouts）对 stale running 有 requeue + retryCount
 * 重试语义，但 agent 主动报错（a2a.fail / taskboard updateStatus → failed）是
 * 一次终态——瞬时故障（网络抖动、网关 502、上游限流）没有第二次机会。
 *
 * 本 sweeper 对「failed 且 retryCount < maxRetries 且 failedAt 超过退避窗口」的
 * 任务自动回队列重试（status=queued, lifecycleStatus=queued, retryCount+1,
 * error=null），与 MCP update_task_status 的 failed→queued 自动重试同一套计数。
 *
 * 退避策略：线性退避 retryCount * RETRY_BACKOFF_BASE_MS（默认 5 分钟/次），
 * 避免上游持续故障时的紧密重试风暴。已触发 retry_storm 断路器的场景由
 * sweepTaskTimeouts 的审计覆盖，这里不重复。
 *
 * 排除项：
 *  - cancelled / done 不重试（非 failed 终态）；
 *  - boardStatus=cancelled/done 的任务不重试（用户明确放弃的不能复活）。
 *
 * 阈值：TIANGONG_TASK_RETRY_ENABLED（默认 true），
 *       TIANGONG_TASK_RETRY_BACKOFF_MS（默认 300000 = 5 分钟）。
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { tasks, taskMessages } from "@db/schema";

import { emitSweeperAudit } from "./notify";
import { notifyAgentMailbox } from "./notify";
import { sweeperConfig } from "./config";
import type { Db } from "./db";

const RETRY_BACKOFF_BASE_MS = Number(process.env.TIANGONG_TASK_RETRY_BACKOFF_MS ?? 300_000);
const RETRY_ENABLED = (process.env.TIANGONG_TASK_RETRY_ENABLED ?? "true").toLowerCase() !== "false";
const DEFAULT_MAX_RETRIES = 3;

export async function sweepTaskRetry(db: Db, now: Date): Promise<void> {
  if (!RETRY_ENABLED) return;

  const failedTasks = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, "failed"), isNotNull(tasks.failedAt)))
    .limit(50);

  let retried = 0;
  for (const task of failedTasks) {
    const retryCount = task.retryCount ?? 0;
    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (retryCount >= maxRetries) continue;

    // 用户在任务板明确放弃（cancelled）的不复活
    if (task.boardStatus === "cancelled" || task.boardStatus === "done") continue;

    // 线性退避：第 n 次重试等 n * base
    const backoffMs = RETRY_BACKOFF_BASE_MS * (retryCount + 1);
    const failedAt = task.failedAt ? new Date(task.failedAt) : null;
    if (!failedAt || Number.isNaN(failedAt.getTime())) continue;
    if (now.getTime() - failedAt.getTime() < backoffMs) continue;

    await db
      .update(tasks)
      .set({
        status: "queued",
        lifecycleStatus: "queued",
        retryCount: retryCount + 1,
        error: null,
        workerLeaseToken: null,
        workerLeaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(tasks.id, task.id));

    retried += 1;

    try {
      await db.insert(taskMessages).values({
        taskId: task.id,
        eventType: "system",
        content: `执行失败自动重试（第 ${retryCount + 1}/${maxRetries} 次，退避 ${Math.round(backoffMs / 1000)}s）`,
        metadata: JSON.stringify({
          action: "auto_retry",
          previousStatus: "failed",
          restoredStatus: "queued",
          retryCount: retryCount + 1,
          lastError: task.error?.slice(0, 500) ?? null,
        }),
      });
    } catch {
      // 事件记录失败不影响重试主流程
    }

    emitSweeperAudit({
      event: "task:auto_retried",
      entityType: "task",
      entityId: task.id,
      metadata: { taskId: task.taskId, count: retryCount + 1 },
    });

    if (task.agentId !== null) {
      try {
        await notifyAgentMailbox({
          toAgentId: task.agentId,
          taskId: task.id,
          subject: `任务 ${task.taskId} 失败后自动重试（第 ${retryCount + 1} 次）`,
          body: `任务「${task.name}」上次失败原因：${task.error?.slice(0, 300) || "未知"}。\n已自动重新排队（${retryCount + 1}/${maxRetries}），请关注下次执行结果。`,
        });
      } catch {
        // 通知失败不影响重试主流程
      }
    }
  }

  if (retried > 0) {
    console.log(`[sweepTaskRetry] auto-retried ${retried} failed task(s)`);
  }
}
