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
import { syncTaskLessonToXuanji } from "../xuanji-sync";
import { notifyLessonRecorded } from "../notification-hooks";
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
      // 失败教训写璇玑（3.1 质量反哺）：lifecycle sweeper 的超时是 orchestration 路径的终态
      // （任务真的超时无响应、重试耗尽），非执行失败，但同样归档教训供同类任务检索规避。
      // 错误文案带超时上下文；agentId 归任务行（无执行代理时归 0）；xuanji_lesson 幂等标记
      // 兜底去重（sweeper 周期性运行，同一任务至多归档一次）。尽力而为，失败绝不影响 sweeper。
      try {
        await syncTaskLessonToXuanji(db, {
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          description: task.description,
          input: task.input,
          output: task.output,
          agentId: task.agentId ?? 0,
          status: "failed",
          lifecycleStatus: "failed",
          error: `任务超时未响应（timeout ${(task.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms）`,
        });
      } catch (error) {
        console.warn(`[task-lifecycle] xuanji lesson sync failed for task ${task.taskId}: ${describeError(error)}`);
      }
      // 失败教训通知（NC-3）：lifecycle sweeper 的超时终态是失败教训挂点之一，
      // 落库后记一条 lesson_recorded 通知（尽力而为，失败绝不影响 sweeper）。
      try {
        await notifyLessonRecorded(
          db,
          {
            id: task.id,
            taskId: task.taskId,
            name: task.name,
            agentId: task.agentId ?? 0,
            error: `任务超时未响应（timeout ${(task.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms）`,
          },
          "lifecycle.sweeper"
        );
      } catch (error) {
        console.warn(`[task-lifecycle] notification failed for task ${task.taskId}: ${describeError(error)}`);
      }
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
