import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, taskMessages, taskArtifacts } from "@db/schema";
import { eq, desc, asc, and, or, like, sql } from "drizzle-orm";
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
        return db.select().from(tasks).where(and(...conditions)).orderBy(desc(tasks.priority), asc(tasks.createdAt)).limit(200);
      }
      return db.select().from(tasks).orderBy(desc(tasks.priority), asc(tasks.createdAt)).limit(200);
    }),

  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(tasks).where(eq(tasks.id, input.id));
      const task = rows[0] ?? null;
      if (!task) return null;

      // A2A-lite v0.1: fetch thread messages and artifacts
      const messages = await db.select().from(taskMessages).where(eq(taskMessages.taskId, input.id)).orderBy(asc(taskMessages.createdAt));
      const artifacts = await db.select().from(taskArtifacts).where(eq(taskArtifacts.taskId, input.id)).orderBy(desc(taskArtifacts.createdAt));

      return {
        ...task,
        threadMessages: messages.map((m) => ({
          ...m,
          metadata: m.metadata ? (() => { try { return JSON.parse(m.metadata); } catch { return null; } })() : null,
        })),
        artifacts: artifacts.map((a) => ({
          ...a,
          jsonPayload: a.jsonPayload ? (() => { try { return JSON.parse(a.jsonPayload); } catch { return null; } })() : null,
        })),
      };
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
        lifecycleStatus: z.enum([
          "created", "queued", "claimed", "dispatched", "accepted", "working",
          "awaiting_result", "submitted", "reviewing", "completed", "failed", "timeout", "cancelled",
        ]).optional(),
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
        lifecycleStatus: input.lifecycleStatus ?? "created",
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
        lifecycleStatus: z.enum([
          "created", "queued", "claimed", "dispatched", "accepted", "working",
          "awaiting_result", "submitted", "reviewing", "completed", "failed", "timeout", "cancelled",
        ]).optional(),
        output: z.string().optional(),
        error: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const update: Record<string, unknown> = { progress: input.progress };
      if (input.status) update.status = input.status;
      if (input.lifecycleStatus) update.lifecycleStatus = input.lifecycleStatus;
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

  /**
   * P9: 提升/降低任务优先级
   * delta 为正提升，为负降低（最低 0）
   */
  promote: publicQuery
    .input(
      z.object({
        id: z.number(),
        delta: z.number().int().default(1),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db
        .select({ id: tasks.id, priority: tasks.priority, taskId: tasks.taskId, name: tasks.name })
        .from(tasks)
        .where(eq(tasks.id, input.id))
        .then((r) => r[0]);

      if (!row) throw new Error("Task not found");

      const oldPriority = row.priority ?? 0;
      const newPriority = Math.max(0, oldPriority + (input.delta ?? 1));

      await db
        .update(tasks)
        .set({ priority: newPriority })
        .where(eq(tasks.id, input.id));

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "promoted",
        id: input.id,
        taskId: row.taskId,
        name: row.name,
        oldPriority,
        newPriority,
        timestamp: new Date().toISOString(),
      });

      return { success: true, oldPriority, newPriority };
    }),

  delete: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(tasks).where(eq(tasks.id, input.id));
      return { success: true };
    }),
});
