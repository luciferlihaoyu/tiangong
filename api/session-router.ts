import { z } from "zod";
import { createRouter, publicQuery, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { sharedSessions, sessionMessages, agents } from "@db/schema";
import { eq, desc, and, asc, lt } from "drizzle-orm";
import { wsManager } from "./ws-manager";
import { getInsertId } from "./lib/insert-id";

export const sessionRouter = createRouter({
  // ─── 会话 CRUD ───
  list: authedQuery
    .input(z.object({ status: z.enum(["active", "archived"]).optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const where = input.status ? eq(sharedSessions.status, input.status) : undefined;
      return db.select().from(sharedSessions).where(where).orderBy(desc(sharedSessions.updatedAt));
    }),

  getById: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(sharedSessions).where(eq(sharedSessions.id, input.id)).then(r => r[0] || null);
    }),

  create: authedQuery
    .input(z.object({
      title: z.string().min(1).max(255),
      type: z.enum(["collaboration", "handoff", "meeting", "review", "adhoc"]).default("adhoc"),
      participants: z.array(z.number()).optional(),
      context: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const sessionKey = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const result = await db.insert(sharedSessions).values({
        title: input.title,
        sessionKey,
        type: input.type,
        participants: input.participants ? JSON.stringify(input.participants) : null,
        context: input.context ? JSON.stringify(input.context) : null,
        createdBy: ctx.apiKeyAgentId && ctx.apiKeyAgentId > 0 ? ctx.apiKeyAgentId : null,
      });
      const id = getInsertId(result);

      wsManager.broadcastToDashboard({
        type: "session_created",
        sessionId: id,
        sessionKey,
        title: input.title,
        timestamp: new Date().toISOString(),
      });

      return { success: true, id, sessionKey };
    }),

  // ─── 会话消息 ───
  sendMessage: authedQuery
    .input(z.object({
      sessionId: z.number(),
      fromAgentId: z.number().optional(),
      toAgentId: z.number().optional(),
      role: z.enum(["user", "assistant", "system"]).default("assistant"),
      content: z.string().min(1),
      metadata: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const session = await db.select().from(sharedSessions).where(eq(sharedSessions.id, input.sessionId)).then(r => r[0]);
      if (!session) throw new Error("Session not found");

      const result = await db.insert(sessionMessages).values({
        sessionId: input.sessionId,
        fromAgentId: input.fromAgentId ?? (ctx.apiKeyAgentId && ctx.apiKeyAgentId > 0 ? ctx.apiKeyAgentId : null),
        toAgentId: input.toAgentId ?? null,
        role: input.role,
        content: input.content,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      });
      const msgId = getInsertId(result);

      // Update session updatedAt
      await db.update(sharedSessions).set({ updatedAt: new Date() }).where(eq(sharedSessions.id, input.sessionId));

      wsManager.broadcastToDashboard({
        type: "session_message",
        sessionId: input.sessionId,
        messageId: msgId,
        fromAgentId: input.fromAgentId,
        role: input.role,
        content: input.content.slice(0, 200),
        timestamp: new Date().toISOString(),
      });

      return { success: true, messageId: msgId };
    }),

  getMessages: authedQuery
    .input(z.object({ sessionId: z.number(), limit: z.number().default(50), before: z.number().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [eq(sessionMessages.sessionId, input.sessionId)];
      // 分页游标：取 before 之前（不含）的消息；此前用 eq 导致翻页重复返回同一行
      if (input.before) conditions.push(lt(sessionMessages.id, input.before));
      return db.select().from(sessionMessages)
        .where(and(...conditions))
        .orderBy(desc(sessionMessages.createdAt))
        .limit(input.limit);
    }),

  // ─── 会话管理 ───
  update: authedQuery
    .input(z.object({ id: z.number(), title: z.string().optional(), summary: z.string().optional(), context: z.record(z.string(), z.any()).optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.title) updates.title = input.title;
      if (input.summary) updates.summary = input.summary;
      if (input.context) updates.context = JSON.stringify(input.context);
      await db.update(sharedSessions).set(updates).where(eq(sharedSessions.id, input.id));
      return { success: true };
    }),

  archive: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(sharedSessions).set({ status: "archived", updatedAt: new Date() }).where(eq(sharedSessions.id, input.id));
      return { success: true };
    }),
});
