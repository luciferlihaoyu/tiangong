import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { conversations, messages } from "@db/schema";
import { eq, desc, asc, sql } from "drizzle-orm";

export const conversationRouter = createRouter({
  list: publicQuery
    .input(z.object({ status: z.enum(["active", "archived"]).default("active") }).optional())
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(conversations)
        .where(eq(conversations.status, input?.status ?? "active"))
        .orderBy(desc(conversations.updatedAt)).limit(50);
    }),
  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const conv = await db.select().from(conversations).where(eq(conversations.id, input.id)).limit(1);
      if (!conv[0]) return null;
      const msgs = await db.select().from(messages)
        .where(eq(messages.conversationId, input.id))
        .orderBy(asc(messages.createdAt)).limit(500);
      return { ...conv[0], messages: msgs };
    }),
  create: authedQuery
    .input(z.object({
      title: z.string().min(1).max(255),
      type: z.enum(["mission", "meeting", "test", "ad_hoc"]).default("ad_hoc"),
      participants: z.array(z.number()).optional(),
      summary: z.string().optional(),
      createdBy: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(conversations).values({
        title: input.title, type: input.type, status: "active",
        participants: input.participants ? JSON.stringify(input.participants) : null,
        summary: input.summary ?? null, createdBy: input.createdBy ?? null,
      });
      const latest = await db.select({ id: conversations.id }).from(conversations).orderBy(desc(conversations.id)).limit(1);
      return { id: latest[0]?.id ?? null };
    }),
  update: authedQuery
    .input(z.object({ id: z.number(), title: z.string().optional(), summary: z.string().optional(), participants: z.array(z.number()).optional() }))
    .mutation(async ({ input }) => {
      const db = getDb(); const { id, ...data } = input;
      const setData: Record<string, unknown> = {};
      if (data.title !== undefined) setData.title = data.title;
      if (data.summary !== undefined) setData.summary = data.summary;
      if (data.participants !== undefined) setData.participants = JSON.stringify(data.participants);
      await db.update(conversations).set(setData).where(eq(conversations.id, id));
      return { success: true };
    }),
  archive: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(conversations).set({ status: "archived", archivedAt: new Date() }).where(eq(conversations.id, input.id));
      return { success: true };
    }),
  unarchive: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(conversations).set({ status: "active", archivedAt: null }).where(eq(conversations.id, input.id));
      return { success: true };
    }),
  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(conversations).where(eq(conversations.id, input.id));
      return { success: true };
    }),
  stats: publicQuery.query(async () => {
    const db = getDb();
    const [active, archived] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(conversations).where(eq(conversations.status, "active")),
      db.select({ count: sql<number>`count(*)` }).from(conversations).where(eq(conversations.status, "archived")),
    ]);
    return { active: active[0]?.count ?? 0, archived: archived[0]?.count ?? 0 };
  }),

  /** 将任务输出追加到记事板 */
  appendTaskOutput: authedQuery
    .input(z.object({
      conversationId: z.number(),
      fromAgentId: z.number(),
      taskName: z.string(),
      taskId: z.string(),
      output: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const content = `📋 **${input.taskName}** (${input.taskId}) 执行完成\\n\\n${input.output}`;
      await db.insert(messages).values({
        fromAgent: input.fromAgentId,
        toAgent: input.fromAgentId,
        content,
        type: "system",
        status: "sent",
        conversationId: input.conversationId,
      });
      await db.update(conversations)
        .set({ updatedAt: new Date() })
        .where(eq(conversations.id, input.conversationId));
      return { success: true };
    }),
});
