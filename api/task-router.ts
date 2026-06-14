import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks } from "@db/schema";
import { eq, desc, and, or, like } from "drizzle-orm";
import { wsManager } from "./ws-manager";
import { emitCollabSummaryForTask } from "./lib/collaboration-events";

export const taskRouter = createRouter({
  list: publicQuery
    .input(
      z.object({
        status: z.enum(["pending", "queued", "running", "done", "failed"]).optional(),
        agentId: z.number().optional(),
        keyword: z.string().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: (ReturnType<typeof eq> | ReturnType<typeof or>)[] = [];
      if (input?.status) conditions.push(eq(tasks.status, input.status));
      if (input?.agentId) conditions.push(eq(tasks.agentId, input.agentId));
      if (input?.keyword && input.keyword.trim()) {
        const kw = `%${input.keyword.trim()}%`;
        const orCond = or(like(tasks.name, kw), like(tasks.description, kw));
        if (orCond) conditions.push(orCond);
      }
      if (conditions.length > 0) {
        return db.select().from(tasks).where(and(...conditions)).orderBy(desc(tasks.createdAt)).limit(200);
      }
      return db.select().from(tasks).orderBy(desc(tasks.createdAt)).limit(200);
    }),

  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(tasks).where(eq(tasks.id, input.id));
      return rows[0] ?? null;
    }),

  /** Auto-generate taskId 避免冲突 */
  nextTaskId: publicQuery.query(async () => {
    const ts = Date.now().toString(36).slice(-5).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
    return { taskId: `TG-${ts}${rand}` };
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
        status: z.enum(["running", "pending", "done", "failed", "queued"]).optional(),
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
        status: input.status ?? "pending",
        maxRetries: input.maxRetries ?? 3,
        timeoutMs: input.timeoutMs ?? 300000,
        parentTaskId: input.parentTaskId ?? null,
      });
      // 通知 Dashboard：新任务创建
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "created",
        taskId: input.taskId,
        name: input.name,
        status: input.status ?? "pending",
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
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
      // 通知 Dashboard：任务状态变更
      const t = await db.select({ taskId: tasks.taskId, name: tasks.name, agentId: tasks.agentId }).from(tasks).where(eq(tasks.id, input.id)).then(r => r[0]);
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "updated",
        id: input.id,
        taskId: t?.taskId,
        name: t?.name,
        status: input.status,
        progress: input.progress,
        agentId: t?.agentId,
        timestamp: new Date().toISOString(),
      });

      if (input.status === "done" || input.status === "failed") {
        await emitCollabSummaryForTask(input.id);
      }

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
