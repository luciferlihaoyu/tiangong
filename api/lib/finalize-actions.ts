// §3-4 可靠投递：任务终态后内部归档/通知动作的持久队列。
//
// 目标架构「执行完成与归档完成分开」：终态写入路径只负责 enqueueTaskFinalize
// （同 (task_id, state_revision) 去重——每次终态写入修订号必然 +1，天然一对一）；
// 实际的归档/通知由 runDueFinalizeActions 用**有期限租约**领取执行：
//   - 全部步骤到位 → done_at 收档；
//   - 有可重试步骤 → attempts+1、退避重试（60s × attempts，上限 5 次 / 24h 窗口）；
//   - 重试耗尽 → dead_letter_at + last_error，不再静默丢失（可观测）。
//
// 契约是**至少一次**：worker 在执行后、标记完成前崩溃会重跑同一动作；
// 各接收端自带幂等（璇玑 type 键、AList 重复检查、通知防抖、协作汇总幂等闸），
// 重复执行收敛。租约默认 60s，显著大于单步最坏耗时，避免"还在飞、租约已过期"。

import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import { taskFinalizeActions, tasks, type TaskFinalizeAction } from "@db/schema";
import { performFinalizeSteps, type FinalizeTaskView } from "./task-finalize";
import { getAffectedRows } from "./insert-id";

export const FINALIZE_MAX_ATTEMPTS = 5;
export const FINALIZE_LEASE_MS = 60 * 1000;
export const FINALIZE_BACKOFF_BASE_MS = 60 * 1000;
/** 与外部回调 outbox 同策略：重试窗口外不再自动重试。 */
export const FINALIZE_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

type Database = ReturnType<typeof import("../queries/connection").getDb>;

export interface FinalizeEnqueueInput {
  readonly taskId: number;
  readonly taskPublicId: string;
  readonly outcome: "completed" | "failed";
  readonly errorChannel?: string;
  readonly errorText?: string | null;
  readonly now?: Date;
}

/**
 * 终态路径调用：把归档/通知动作持久入队。
 * 同一任务同一修订号已入队时静默幂等（唯一索引 uq_task_finalize_task_revision）。
 * 入队失败不抛给调用方——终态写入本身已成功，队列缺失由"终态路径至少调用一次"
 * 的调用纪律 + 后续人工补偿兜底；这里记日志保可观测。
 */
export async function enqueueTaskFinalize(db: Database, input: FinalizeEnqueueInput): Promise<{ readonly enqueued: boolean }> {
  const now = input.now ?? new Date();
  try {
    // 修订号在入队时**现读**：终态写入路径只管入队，不带修订号（调用点手里的行
    // 是写前快照，算术推 +1 会与真实推进漂移）。同一终态写入的多次入队读到同一
    // 现值 → 唯一索引去重收敛；极少见的"读值落后于后续写入"由最终终态语义覆盖。
    const current = await db.select({ stateRevision: tasks.stateRevision }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1).then((r) => r[0]);
    if (!current) return { enqueued: false };
    await db.insert(taskFinalizeActions).values({
      taskId: input.taskId,
      taskPublicId: input.taskPublicId,
      outcome: input.outcome,
      errorChannel: input.errorChannel ?? null,
      errorText: input.errorText ?? null,
      stateRevision: current.stateRevision ?? 1,
      attempts: 0,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
    return { enqueued: true };
  } catch (error) {
    console.error(`[finalize-actions] enqueue failed task=${input.taskPublicId}: ${error instanceof Error ? error.message : String(error)}`);
    return { enqueued: false };
  }
}

export interface FinalizeRunSummary {
  claimed: number;
  done: number;
  retried: number;
  deadLettered: number;
}

/** 可用作任务视图终态读取的行类型（tasks 全行即满足 FinalizeTaskView）。 */
type TaskRow = FinalizeTaskView & { readonly stateRevision?: number | null };

/**
 * 领取到期动作并执行。租约 CAS：next_attempt_at 到期 且（无租约 或 租约已过期）
 * 且未完成/未死信，UPDATE 置租约后 re-read 判定领取（与 outbox claimDueEvents 同构）。
 */
export async function runDueFinalizeActions(
  db: Database,
  now: Date,
  options: { readonly limit?: number; readonly executor?: (db: Database, task: TaskRow, action: TaskFinalizeAction) => Promise<{ readonly needsRetry: boolean; readonly reason?: string }> } = {},
): Promise<FinalizeRunSummary> {
  const limit = options.limit ?? 50;
  const leaseUntil = new Date(now.getTime() + FINALIZE_LEASE_MS);
  const summary = { claimed: 0, done: 0, retried: 0, deadLettered: 0 };

  const due = await db
    .select({ id: taskFinalizeActions.id })
    .from(taskFinalizeActions)
    .where(and(
      isNull(taskFinalizeActions.doneAt),
      isNull(taskFinalizeActions.deadLetterAt),
      lte(taskFinalizeActions.nextAttemptAt, now),
      or(isNull(taskFinalizeActions.leaseExpiresAt), lte(taskFinalizeActions.leaseExpiresAt, now)),
    ))
    .orderBy(asc(taskFinalizeActions.nextAttemptAt), asc(taskFinalizeActions.id))
    .limit(limit);

  for (const { id } of due) {
    const claim = await db
      .update(taskFinalizeActions)
      .set({ leaseExpiresAt: leaseUntil, updatedAt: now })
      .where(and(
        eq(taskFinalizeActions.id, id),
        isNull(taskFinalizeActions.doneAt),
        isNull(taskFinalizeActions.deadLetterAt),
        lte(taskFinalizeActions.nextAttemptAt, now),
        or(isNull(taskFinalizeActions.leaseExpiresAt), lte(taskFinalizeActions.leaseExpiresAt, now)),
      ))
      .run();
    if (getAffectedRows(claim) === 0) continue; // 被其它 worker 抢走
    summary.claimed += 1;

    const action = await db.select().from(taskFinalizeActions).where(eq(taskFinalizeActions.id, id)).then((r) => r[0]);
    if (!action) continue;

    try {
      await executeAction(db, action, now, options.executor, summary);
    } catch (error) {
      // executeAction 内部已兜底；这里防御意外抛出（如 DB 抖动）→ 记一次可重试失败
      await markRetry(db, action, now, error instanceof Error ? error.message : String(error), summary);
    }
    await db.update(taskFinalizeActions).set({ leaseExpiresAt: null, updatedAt: now }).where(eq(taskFinalizeActions.id, id));
  }
  return summary;
}

async function executeAction(
  db: Database,
  action: TaskFinalizeAction,
  now: Date,
  executor: undefined | ((db: Database, task: TaskRow, action: TaskFinalizeAction) => Promise<{ readonly needsRetry: boolean; readonly reason?: string }>),
  summary: FinalizeRunSummary,
): Promise<void> {
  const task = await loadTask(db, action);
  if (!task) {
    // 任务行都不在了（被清理）：动作失去意义，直接收档——不是失败。
    await db.update(taskFinalizeActions).set({ doneAt: now, lastError: "task_missing", updatedAt: now }).where(eq(taskFinalizeActions.id, action.id));
    summary.done += 1;
    return;
  }
  if (executor) {
    const result = await executor(db, task, action);
    if (result.needsRetry) await markRetry(db, action, now, result.reason ?? "retryable", summary);
    else await markDone(db, action, now, summary);
    return;
  }
  const report = await performFinalizeSteps(db, task, {
    outcome: action.outcome,
    errorChannel: action.errorChannel ?? undefined,
    errorText: action.errorText,
  });
  if (report.needsRetry) {
    const reason = report.steps.filter((s) => s.verdict === "retry").map((s) => `${s.step}:${s.reason ?? "?"}`).join("; ");
    await markRetry(db, action, now, reason, summary);
  } else {
    await markDone(db, action, now, summary);
  }
}

async function loadTask(db: Database, action: TaskFinalizeAction): Promise<TaskRow | null> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, action.taskId)).limit(1);
  return rows[0] ?? null;
}

async function markDone(db: Database, action: TaskFinalizeAction, now: Date, summary: FinalizeRunSummary): Promise<void> {
  await db.update(taskFinalizeActions).set({ doneAt: now, leaseExpiresAt: null, lastError: null, updatedAt: now }).where(eq(taskFinalizeActions.id, action.id));
  summary.done += 1;
}

async function markRetry(db: Database, action: TaskFinalizeAction, now: Date, reason: string, summary: FinalizeRunSummary): Promise<void> {
  const attempts = action.attempts + 1;
  const ageMs = now.getTime() - new Date(action.createdAt).getTime();
  if (attempts >= FINALIZE_MAX_ATTEMPTS || ageMs > FINALIZE_RETRY_WINDOW_MS) {
    await db.update(taskFinalizeActions)
      .set({ attempts, deadLetterAt: now, leaseExpiresAt: null, lastError: reason.slice(0, 500), updatedAt: now })
      .where(eq(taskFinalizeActions.id, action.id));
    summary.deadLettered += 1;
    console.error(`[finalize-actions] dead letter task=${action.taskPublicId} attempt=${attempts}: ${reason.slice(0, 200)}`);
    return;
  }
  const nextAttemptAt = new Date(now.getTime() + FINALIZE_BACKOFF_BASE_MS * attempts);
  await db.update(taskFinalizeActions)
    .set({ attempts, nextAttemptAt, leaseExpiresAt: null, lastError: reason.slice(0, 500), updatedAt: now })
    .where(eq(taskFinalizeActions.id, action.id));
  summary.retried += 1;
}
