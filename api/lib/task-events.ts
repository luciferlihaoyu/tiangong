/**
 * task_messages 事件记录共享 helper（p2.5-a 抽壳副产物）。
 *
 * 原先是 api/a2a-router.ts 的模块内私有函数；验收过程体抽到
 * api/lib/task-review.ts 后，tRPC 与 MCP 两面共用同一 recordTaskEvent——
 * 逐字节搬入，行为不变（同 taskId/eventType/content/metadata 落库形状一致，
 * metadata 仍 JSON.stringify）。
 */
import { getDb } from "../queries/connection";
import { taskMessages } from "@db/schema";

/** 记录 task_message 事件 */
export async function recordTaskEvent(
  input: {
    taskId: number;
    fromAgentId?: number;
    toAgentId?: number;
    eventType: typeof taskMessages.$inferInsert["eventType"];
    content?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const db = getDb();
  await db.insert(taskMessages).values({
    taskId: input.taskId,
    fromAgentId: input.fromAgentId ?? null,
    toAgentId: input.toAgentId ?? null,
    eventType: input.eventType,
    content: input.content ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });
}
