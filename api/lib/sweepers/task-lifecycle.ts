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
import { enqueueTaskFinalize } from "../finalize-actions";
import { applyTaskTransition } from "../task-transition";
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
       // §3-3：超时重派改走转移服务。租约代数守卫用 alsoWhere 原样保留（它是这处的
      // 精确并发判据），修订号随写入递增；清租约 + 归还认领人同一次写齐。
      const requeued = await applyTaskTransition(db as never, {
        taskId: task.id,
        lifecycleStatus: "queued",
        status: "queued",
        at: now,
        clearLease: true,
        alsoWhere: eq(tasks.workerLeaseGeneration, task.workerLeaseGeneration ?? 0),
        // 2026-10-09（#103 教训）：不再清空 agentId——重派必须保住路由归属；清空后
        // 任务变"通用任务"，TaskRunner 会越过 externalClaimSources 隔离抢走并假完成。
        // 保留 agentId 则任务回到原 agent 的 connector（真身重试）。
        extra: { retryCount: retryCount + 1, error: null },
      });
      if (!requeued.ok) continue;
    } else {
      const timeoutText = `任务超时未响应（timeout ${task.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）`;
      // Phase B §3-3：状态转移改由单一服务写——一次写齐 status/lifecycleStatus/failedAt
      // 并**递增 stateRevision**（原先这里不递增，而 task_outbox_events 上有
      // (task_id, state_revision) 唯一索引且入队无冲突处理 ⇒ 同一修订号下第二条外部回调事件
      // 会撞唯一索引抛错）。expectedRevision 用扫到的这一版做 CAS：租约过期后若已被别人推进，
      // 这里返回 revision_conflict 而不是覆盖别人的写入，也不再触发归档。
      const transition = await applyTaskTransition(db as never, {
        taskId: task.id,
        lifecycleStatus: "failed",
        at: now,
        error: timeoutText,
        clearLease: true,
        expectedRevision: task.stateRevision,
      });
      if (!transition.ok) continue;
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
      // §3-4 可靠投递：终态动作改为持久入队（finalize-actions sweeper 带租约执行，
      // 失败退避重试、耗尽进死信）。原先内联尽力而为，失败即丢。
      await enqueueTaskFinalize(db as never, {
        taskId: task.id,
        taskPublicId: task.taskId,
        outcome: "failed",
        errorChannel: "lifecycle.sweeper",
        errorText: timeoutText,
      });
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
