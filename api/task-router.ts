import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks } from "@db/schema";
import { eq, desc } from "drizzle-orm";

export const taskRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(tasks).orderBy(desc(tasks.createdAt));
  }),

  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(tasks).where(eq(tasks.id, input.id));
      return rows[0] ?? null;
    }),

  create: publicQuery
    .input(
      z.object({
        taskId: z.string().min(1).max(20),
        name: z.string().min(1).max(255),
        agentId: z.number().optional(),
        description: z.string().optional(),
        priority: z.number().optional(),
        input: z.string().optional(),
        maxRetries: z.number().optional(),
        timeoutMs: z.number().optional(),
        parentTaskId: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(tasks).values({
        taskId: input.taskId,
        name: input.name,
        agentId: input.agentId ?? null,
        description: input.description ?? null,
        priority: input.priority ?? 0,
        input: input.input ?? null,
        maxRetries: input.maxRetries ?? 3,
        timeoutMs: input.timeoutMs ?? 300000,
        parentTaskId: input.parentTaskId ?? null,
      });
      return { success: true };
    }),

  updateProgress: publicQuery
    .input(
      z.object({
        id: z.number(),
        progress: z.number().min(0).max(100),
        status: z.enum(["running", "pending", "done", "failed", "queued"]).optional(),
        output: z.string().optional(),
        error: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const update: Record<string, unknown> = { progress: input.progress };
      if (input.status) update.status = input.status;
      if (input.output !== undefined) update.output = input.output;
      if (input.error !== undefined) update.error = input.error;
      await db.update(tasks).set(update).where(eq(tasks.id, input.id));
      return { success: true };
    }),

  delete: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(tasks).where(eq(tasks.id, input.id));
      return { success: true };
    }),
});
