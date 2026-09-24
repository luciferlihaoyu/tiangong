// 单一任务状态转移服务（Phase B §3-3）
//
// 背景：`tasks` 上有三个**互相独立**的状态维度——
//   - `status`（粗粒度：running/pending/done/failed/queued，旧字段）
//   - `lifecycleStatus`（A2A-lite 生命周期机）
//   - `boardStatus`（任务板机）
// 它们描述不同维度，**不能粗暴合成一个枚举**；但同一行上的多个维度必须是**一致投影**。
// 生产实测（2026-09-23 线上库）证明靠各调用点自觉维护会漏：取消一个 `dispatched` 任务后
// `status='failed'` 而 `lifecycle_status` 仍是 `'dispatched'`、`failed_at` 为空。
//
// 更隐蔽的一处：`tasks.state_revision` 全仓只有 `beidou-external-router` 与
// `artifact-sealer` 在递增，其余写状态的地方都不递增。而 `task_outbox_events` 上有唯一索引
// `uq_task_outbox_task_revision(task_id, state_revision)`，`enqueueTaskOutboxEvent` 插入时
// **没有冲突处理** ⇒ 状态变两次而修订号不变时，第二条外部回调事件会直接撞唯一索引抛错。
// 所以"递增修订号"不是记账好看，而是外部投递能否成立的前提。
//
// 契约：
//   1. 命名转移（lifecycleStatus）先过状态机校验，非法即**一个维度都不写**；
//   2. 一次 UPDATE 写齐所有维度 + `stateRevision + 1` + `updatedAt`，避免"改一半"；
//   3. 乐观并发：WHERE 里带上读到的修订号（或调用方给的 expectedRevision），
//      读后被人改过就返回 revision_conflict 而不是覆盖别人的写入；
//   4. 终态由 lifecycleStatus **推导**粗粒度 status（completed→done，失败族→failed）
//      并盖上对应时间戳；非终态转移不动 status、不盖终态戳。

import { and, eq } from "drizzle-orm";
import { tasks } from "@db/schema";
import { getDb } from "../queries/connection";
import { getAffectedRows } from "./insert-id";

export type Db = ReturnType<typeof getDb>;

/** 生命周期取值（原在 api/a2a-router.ts，现由本服务独占，避免两处各维护一套）。 */
export const LIFECYCLE_STATUSES = [
  "created",
  "queued",
  "claimed",
  "dispatched",
  "accepted",
  "working",
  "awaiting_result",
  "submitted",
  "reviewing",
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/** 不可逆的终态。 */
export const TERMINAL_LIFECYCLE_STATUSES = ["completed", "failed", "timeout", "cancelled"] as const;

export function isTerminalLifecycle(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && (TERMINAL_LIFECYCLE_STATUSES as readonly string[]).includes(status);
}

/**
 * 严格向前流转的校验（原 `api/a2a-router.ts` 的同名函数，逐字搬入本服务）。
 * 禁止非法回退和跳跃。
 */
export function isValidLifecycleTransition(from: string, to: string): boolean {
  // terminal states 不可逆
  if (isTerminalLifecycle(from)) {
    return false;
  }
  // 已到达 submitted 后不能回退到 working/dispatched/accepted/claimed 等
  if (from === "submitted" && !["reviewing", "completed", "failed", "timeout", "cancelled"].includes(to)) {
    return false;
  }
  if (from === "reviewing" && !["completed", "failed", "timeout", "cancelled"].includes(to)) {
    return false;
  }
  // completed 只能从 submitted 或 reviewing 进入
  if (to === "completed" && !["submitted", "reviewing"].includes(from)) {
    return false;
  }
  // submitted 只能从 awaiting_result、working、dispatched、accepted、claimed 或 created/queued 进入
  if (to === "submitted" && !["awaiting_result", "working", "dispatched", "accepted", "claimed", "queued", "created"].includes(from)) {
    return false;
  }
  // reviewing 只能从 submitted 进入
  if (to === "reviewing" && from !== "submitted") {
    return false;
  }
  return true;
}

/** 终态生命周期 → 粗粒度 `status` 的投影。非终态返回 null 表示"不改动 status"。 */
export function projectStatusFor(lifecycle: string): "done" | "failed" | null {
  if (lifecycle === "completed") return "done";
  if (lifecycle === "failed" || lifecycle === "timeout" || lifecycle === "cancelled") return "failed";
  return null;
}

export interface TaskTransitionRequest {
  /** 任务行主键（tasks.id）。 */
  readonly taskId: number;
  /** 本次转移的发生时间，同时作为 `updatedAt` 与终态时间戳。 */
  readonly at: Date;
  /** 目标生命周期状态；给了就过状态机校验。 */
  readonly lifecycleStatus?: LifecycleStatus;
  /** 显式指定粗粒度 status（缺省时由 lifecycleStatus 推导，推导不出则不动）。 */
  readonly status?: "running" | "pending" | "done" | "failed" | "queued";
  /** 目标任务板状态（板机取值由各调用点自持，这里只保证与其它维度同一次写入）。 */
  readonly boardStatus?: string;
  /** 失败族转移写入的 `error` 列（如 `[cancelled] 原因`）。 */
  readonly error?: string | null;
  /** 乐观并发：读到的修订号不是这个值就拒绝。 */
  readonly expectedRevision?: number;
  /** 是否清理执行租约（终态通常要清，避免陈旧 worker 继续推进）。 */
  readonly clearLease?: boolean;
}

export interface TaskTransitionSnapshot {
  readonly status: string | null;
  readonly lifecycleStatus: string | null;
  readonly boardStatus: string | null;
  readonly revision: number;
}

export type TaskTransitionOutcome =
  | { readonly ok: true; readonly revision: number; readonly from: TaskTransitionSnapshot; readonly to: TaskTransitionSnapshot }
  | { readonly ok: false; readonly reason: "not_found" | "invalid_transition" | "revision_conflict" };

/**
 * 应用一次状态转移：一次 UPDATE 写齐所有维度 + 修订号，非法转移一个字段都不写。
 *
 * WHERE 里带上修订号做 CAS：即使调用方没传 `expectedRevision`，也用它读到的那一版，
 * 因此"读—改—写"之间若被别的写者插进来，这里返回 revision_conflict 而不是静默覆盖。
 */
export async function applyTaskTransition(db: Db, request: TaskTransitionRequest): Promise<TaskTransitionOutcome> {
  const current = await db.select().from(tasks).where(eq(tasks.id, request.taskId)).then((rows) => rows[0]);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }

  const currentLifecycle = current.lifecycleStatus ?? "created";
  if (request.lifecycleStatus !== undefined && !isValidLifecycleTransition(currentLifecycle, request.lifecycleStatus)) {
    return { ok: false, reason: "invalid_transition" };
  }

  const nextLifecycle = request.lifecycleStatus ?? currentLifecycle;
  const projectedStatus = request.lifecycleStatus !== undefined ? projectStatusFor(request.lifecycleStatus) : null;
  const nextStatus = request.status ?? projectedStatus ?? current.status;

  const terminalStamp = request.lifecycleStatus !== undefined && isTerminalLifecycle(request.lifecycleStatus);
  const isCompleted = request.lifecycleStatus === "completed";

  const patch: Record<string, unknown> = {
    status: nextStatus,
    lifecycleStatus: nextLifecycle,
    stateRevision: current.stateRevision + 1,
    updatedAt: request.at,
  };
  if (request.boardStatus !== undefined) patch.boardStatus = request.boardStatus;
  if (request.error !== undefined) patch.error = request.error;
  if (isCompleted) patch.completedAt = request.at;
  if (terminalStamp && !isCompleted) patch.failedAt = request.at;
  if (request.clearLease) {
    patch.workerLeaseToken = null;
    patch.workerLeaseExpiresAt = null;
    patch.claimedAt = null;
  }

  const expected = request.expectedRevision ?? current.stateRevision;
  const result = await db
    .update(tasks)
    .set(patch)
    .where(and(eq(tasks.id, request.taskId), eq(tasks.stateRevision, expected)));
  if (getAffectedRows(result) !== 1) {
    return { ok: false, reason: "revision_conflict" };
  }

  return {
    ok: true,
    revision: current.stateRevision + 1,
    from: {
      status: current.status,
      lifecycleStatus: current.lifecycleStatus,
      boardStatus: current.boardStatus,
      revision: current.stateRevision,
    },
    to: {
      status: nextStatus,
      lifecycleStatus: nextLifecycle,
      boardStatus: request.boardStatus ?? current.boardStatus,
      revision: current.stateRevision + 1,
    },
  };
}
