import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { messages, agents } from "@db/schema";
import { eq, desc, sql } from "drizzle-orm";

export const messageRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    const allMessages = await db
      .select()
      .from(messages)
      .orderBy(desc(messages.createdAt))
      .limit(100);
    return allMessages;
  }),

  listByAgent: publicQuery
    .input(z.object({ agentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(messages)
        .where(
          sql`${messages.fromAgent} = ${input.agentId} OR ${messages.toAgent} = ${input.agentId}`
        )
        .orderBy(desc(messages.createdAt))
        .limit(50);
    }),

  send: publicQuery
    .input(
      z.object({
        fromAgent: z.number(),
        toAgent: z.number(),
        content: z.string().min(1).max(5000),
        type: z.enum(["command", "response", "broadcast", "system"]).default("command"),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(messages).values({
        fromAgent: input.fromAgent,
        toAgent: input.toAgent,
        content: input.content,
        type: input.type,
      });
      // Increment sender's message count
      await db
        .update(agents)
        .set({ messagesCount: sql`${agents.messagesCount} + 1` })
        .where(eq(agents.id, input.fromAgent));
      return { success: true };
    }),

  stats: publicQuery.query(async () => {
    const db = getDb();
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages);
    return { total: result[0]?.count ?? 0 };
  }),
});
