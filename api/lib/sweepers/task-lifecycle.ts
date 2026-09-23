/**
 * Task lifecycle sweeper: reclaim stale "running" tasks and guard against
 * retry storms.
 *
 * - A task stuck in "running" beyond its timeout is requeued when retries
 *   remain (mirroring the MCP update_task_status retry path fields:
 *   status=queued, retryCount+1, error=null), otherwise marked failed
 *   (terminal) with a task:timeout audit event.
 * - If >= 5 tasks failed within the last hour, a single task:retry_storm
 *   audit is emitted with the failure count.
 */
import { and, eq, gt, lte } from "drizzle-orm";
import { tasks, taskExecutionSlots } from "@db/schema";

import { emitSweeperAudit } from "./notify";
import { finalizeFailedTask } from "../task-finalize";
import type { Db } from "./db";

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 3;
const STORM_THRESHOLD = 5;
const STORM_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function sweepTaskTimeouts(db: Db, now: Date): Promise<void> {
  const running = await db.select().from(tasks).where(eq(tasks.status, "running"));

  for (const task of running) {
    const expiresAt = task.workerLeaseExpiresAt ?? new Date((task.claimedAt ?? task.updatedAt).getTime() + (task.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    if (expiresAt.getTime() > now.getTime()) continue;

    const retryCount = task.retryCount ?? 0;
    const maxRetries = task.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (retryCount < maxRetries) {
      // Requeue, keeping the exact retry fields used by the MCP retry path.
       await db
        .update(tasks)
        .set({
          status: "queued",
          lifecycleStatus: "queued",
          retryCount: retryCount + 1,
          error: null,
          agentId: null,
          workerLeaseToken: null,
          workerLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.workerLeaseGeneration, task.workerLeaseGeneration ?? 0)));
    } else {
      const timeoutText = `任务超时未响应（timeout ${task.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`;
      await db
        .update(tasks)
        .set({ status: "failed", lifecycleStatus: "failed", failedAt: now, workerLeaseToken: null, workerLeaseExpiresAt: null, updatedAt: now })
        .where(and(eq(tasks.id, task.id), eq(tasks.workerLeaseGeneration, task.workerLeaseGeneration ?? 0)));
      emitSweeperAudit({
        event: "task:timeout",
        entityType: "task",
        entityId: task.id,
        metadata: { taskId: task.taskId },
      });
      // Phase B §3-2：超时终态动作与取消/执行失败**统一走 finalizeFailedTask**。
      // 原先这里内联"教训 + 通知"，漏了产物归档与协作父任务汇总（父任务汇总会一直等到
      // 其它兄弟完成才发生——功能缺口，不只是少写日志）。超时文案由编排层推断，
      // 任务行的 error 可能为空，所以显式传 errorText。
      // finalizeFailedTask 各步骤已全 catch，绝不抛错打断 sweeper。
      await finalizeFailedTask(db as never, {
        id: task.id,
        taskId: task.taskId,
        name: task.name,
        description: task.description,
        input: task.input,
        output: task.output,
        agentId: task.agentId ?? 0,
        status: "failed",
        lifecycleStatus: "failed",
        error: timeoutText,
        parentTaskId: task.parentTaskId,
      }, { errorChannel: "lifecycle.sweeper", errorText: timeoutText });
    }
  }

  await db.delete(taskExecutionSlots).where(lte(taskExecutionSlots.expiresAt, now));

  // Retry-storm breaker: recent failure count, independent of this tick's actions.
  const stormCutoff = new Date(now.getTime() - STORM_WINDOW_MS);
  const recentFailed = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, "failed"), gt(tasks.updatedAt, stormCutoff)));
  if (recentFailed.length >= STORM_THRESHOLD) {
    emitSweeperAudit({
      event: "task:retry_storm",
      entityType: "task",
      metadata: { count: recentFailed.length },
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
