/**
 * 协作任务 ↔ 共享会话（会话中心）自动接线
 *
 * 背景：会话中心（/sessions）API/前端齐全但没有生产者——没有任何系统会自动
 * 往 sharedSessions 写消息，是「造好了房间没人开会」的死功能。本模块把协作
 * 任务流（collaboration.delegate 派发 → 子任务执行/回写 → 父任务汇总）自动
 * 镜像成一个 collaboration 类型的共享会话，会话中心由此变成「协作任务实时
 * 战况室」。
 *
 * 关联方式：sessionKey = `collab-task-${parentTaskId}`（唯一、可直接查询），
 * context 里冗余 parentTaskId 便于反查；幂等——ensure 只建一次。
 *
 * 所有写操作尽力而为：任何失败只记 warn，绝不影响任务执行主流程。
 */
import { eq } from "drizzle-orm";
import { sharedSessions, sessionMessages, tasks, agents } from "@db/schema";
import type { Db } from "./xuanji-sync";
import { wsManager } from "../ws-manager";
import { getInsertId } from "./insert-id";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionKeyFor(parentTaskId: number): string {
  return `collab-task-${parentTaskId}`;
}

/**
 * 找或建某协作父任务对应的共享会话。
 * participants = 全部子任务的执行 agent + 可选协调者。
 */
export async function ensureCollabSession(
  db: Db,
  parentTaskId: number,
  opts?: { coordinatorAgentId?: number | null }
): Promise<number | null> {
  try {
    const key = sessionKeyFor(parentTaskId);
    const existing = await db
      .select({ id: sharedSessions.id })
      .from(sharedSessions)
      .where(eq(sharedSessions.sessionKey, key))
      .then((rows) => rows[0]);
    if (existing) return existing.id;

    const parent = await db
      .select({ id: tasks.id, name: tasks.name, agentId: tasks.agentId })
      .from(tasks)
      .where(eq(tasks.id, parentTaskId))
      .then((rows) => rows[0]);
    if (!parent) return null;

    const childRows = await db
      .select({ agentId: tasks.agentId })
      .from(tasks)
      .where(eq(tasks.parentTaskId, parentTaskId));
    const participants = Array.from(
      new Set(
        [parent.agentId, opts?.coordinatorAgentId, ...childRows.map((c) => c.agentId)].filter(
          (id): id is number => typeof id === "number" && id > 0
        )
      )
    );

    const result = await db.insert(sharedSessions).values({
      title: `协作：${parent.name}`.slice(0, 255),
      sessionKey: key,
      type: "collaboration",
      participants: participants.length > 0 ? JSON.stringify(participants) : null,
      context: JSON.stringify({ parentTaskId }),
      createdBy: opts?.coordinatorAgentId ?? parent.agentId ?? null,
    });
    const id = getInsertId(result) || null;
    if (id) {
      wsManager.broadcastToDashboard({
        type: "session_created",
        sessionId: id,
        sessionKey: key,
        title: `协作：${parent.name}`.slice(0, 255),
        timestamp: new Date().toISOString(),
      });
    }
    return id;
  } catch (error) {
    console.warn(`[collab-session] ensureCollabSession failed for task ${parentTaskId}: ${describeError(error)}`);
    return null;
  }
}

/**
 * 往协作会话追加一条消息（自动建会话）。返回是否成功。
 * role: system=流程事件（派发/汇总），assistant=agent 的工作汇报/结果。
 */
export async function postCollabSessionMessage(
  db: Db,
  parentTaskId: number,
  msg: {
    fromAgentId?: number | null;
    role: "user" | "assistant" | "system";
    content: string;
    metadata?: Record<string, unknown>;
  }
): Promise<boolean> {
  try {
    const sessionId = await ensureCollabSession(db, parentTaskId);
    if (!sessionId) return false;

    const content = msg.content.slice(0, 5000);
    const result = await db.insert(sessionMessages).values({
      sessionId,
      fromAgentId: msg.fromAgentId ?? null,
      toAgentId: null,
      role: msg.role,
      content,
      metadata: msg.metadata ? JSON.stringify(msg.metadata) : null,
    });
    const msgId = getInsertId(result) || null;

    await db.update(sharedSessions).set({ updatedAt: new Date() }).where(eq(sharedSessions.id, sessionId));

    wsManager.broadcastToDashboard({
      type: "session_message",
      sessionId,
      messageId: msgId,
      fromAgentId: msg.fromAgentId ?? null,
      role: msg.role,
      content: content.slice(0, 200),
      timestamp: new Date().toISOString(),
    });
    return true;
  } catch (error) {
    console.warn(`[collab-session] postCollabSessionMessage failed for task ${parentTaskId}: ${describeError(error)}`);
    return false;
  }
}

/** 取 agent 显示名（消息前缀用），查不到返回 null。 */
export async function agentDisplayName(db: Db, agentId: number | null | undefined): Promise<string | null> {
  if (!agentId) return null;
  try {
    const row = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]);
    return row?.name ?? null;
  } catch {
    return null;
  }
}
