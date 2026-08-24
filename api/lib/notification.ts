/**
 * 通知中心——记录一条 notification（NC-2）
 *
 * 设计约束：
 * - 永不抛错（与 memory-compensation/alist-compensation sweeper 同模式）——
 *   通知失败不影响主流程
 * - 同 agentId + type + taskId 在 60s 窗口内的重复调用去重（防抖）
 * - null agentId 跳过（system 通知不归任何 agent）
 * - 60s 阈值常量导出便于测试注入；windowMs 可覆盖（NC-5 预算熔断用 24h 窗口）
 *
 * 后续接入：NC-3 在 6 失败教训挂点统一调 notifyLessonRecorded、NC-5 在
 * task-writeback/taskboard/task-claim 三处直接调 recordNotification。
 */
import { and, eq, gte, sql } from "drizzle-orm";
import { notifications } from "@db/schema";
import type { getDb } from "../queries/connection";
import { wsManager } from "../ws-manager";

/** 默认防抖窗口：同 agentId+type+taskId 在 60s 内的重复调用去重 */
export const NOTIFICATION_DEDUP_WINDOW_MS = 60_000;

export type NotificationType =
  | "task_approved"
  | "task_rejected"
  | "task_completed"
  | "task_failed"
  | "lesson_recorded"
  | "budget_exhausted";

export type Db = ReturnType<typeof getDb>;

export interface RecordNotificationInput {
  agentId: number | null;
  type: NotificationType;
  taskId?: number | null;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  /** 防抖窗口覆盖（缺省 NOTIFICATION_DEDUP_WINDOW_MS=60s）；NC-5 预算熔断传 24h */
  windowMs?: number;
}

/** 内部提取的防抖查询——便于测试直接验证 */
export async function findDuplicateNotification(
  db: Db,
  input: { agentId: number; type: NotificationType; taskId: number | null; windowMs: number; now: Date }
): Promise<boolean> {
  const since = new Date(input.now.getTime() - input.windowMs);
  const rows = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.agentId, input.agentId),
        eq(notifications.type, input.type),
        input.taskId === null
          ? sql`${notifications.taskId} IS NULL`
          : eq(notifications.taskId, input.taskId),
        gte(notifications.createdAt, since)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * 记录一条通知（尽力而为，永不抛错）：
 *   - null agentId → 早退（system 通知不归任何 agent）
 *   - 空 title/body → 跳过 + warn
 *   - 防抖：同 agentId+type+taskId 在 windowMs 内已有 → 跳过 + log
 *   - 落库失败 → warn 吞掉，绝不影响调用方主流程
 */
export async function recordNotification(
  db: Db,
  input: RecordNotificationInput
): Promise<void> {
  try {
    if (input.agentId === null) return;
    if (!input.title || !input.body) {
      console.warn(`[notification] skip empty title/body: type=${input.type} agentId=${input.agentId}`);
      return;
    }
    const isDup = await findDuplicateNotification(db, {
      agentId: input.agentId,
      type: input.type,
      taskId: input.taskId ?? null,
      windowMs: input.windowMs ?? NOTIFICATION_DEDUP_WINDOW_MS,
      now: new Date(),
    });
    if (isDup) {
      console.log(`[notification] dedup: type=${input.type} agentId=${input.agentId} taskId=${input.taskId ?? "null"}`);
      return;
    }
    await db.insert(notifications).values({
      agentId: input.agentId,
      type: input.type,
      taskId: input.taskId ?? null,
      title: input.title,
      body: input.body,
      metadata: input.metadata ?? null,
    });
    // 通知中心实时推送：db.insert 成功后推 dashboard 事件；broadcast 失败不影响主流程
    try {
      wsManager.broadcastToDashboard({
        type: "notification_created",
        notification: {
          type: input.type,
          agentId: input.agentId,
          taskId: input.taskId ?? null,
          title: input.title,
          body: input.body,
          metadata: input.metadata ?? null,
          readAt: null,
          createdAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      console.warn(
        `[notification] broadcast failed: type=${input.type} agentId=${input.agentId} taskId=${input.taskId ?? "null"} error=${e instanceof Error ? e.message : String(e)}`
      );
    }
  } catch (e) {
    console.warn(
      `[notification] failed to record: type=${input.type} agentId=${input.agentId} taskId=${input.taskId ?? "null"} error=${e instanceof Error ? e.message : String(e)}`
    );
  }
}
