import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { taskMessages, tasks } from "@db/schema";
import { eq, desc, and, or, sql } from "drizzle-orm";

export const executionRouter = createRouter({
  list: publicQuery
    .input(
      z.object({
        agentId: z.number().optional(),
        taskId: z.number().optional(),
        limit: z.number().min(1).max(500).default(50),
        status: z.enum([
          "dispatch", "ack", "progress", "working", "result",
          "error", "timeout", "cancel", "system",
        ]).optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: (ReturnType<typeof eq> | ReturnType<typeof and>)[] = [];

      if (input?.agentId) {
        conditions.push(
          or(eq(taskMessages.fromAgentId, input.agentId), eq(taskMessages.toAgentId, input.agentId))
        );
      }
      if (input?.taskId) {
        conditions.push(eq(taskMessages.taskId, input.taskId));
      }
      if (input?.status) {
        conditions.push(eq(taskMessages.eventType, input.status));
      }

      const results = conditions.length > 0
        ? await db.select().from(taskMessages)
            .where(and(...conditions))
            .orderBy(desc(taskMessages.createdAt))
            .limit(input?.limit ?? 50)
        : await db.select().from(taskMessages)
            .orderBy(desc(taskMessages.createdAt))
            .limit(input?.limit ?? 50);

      return results.map((m) => ({
        ...m,
        metadata: m.metadata ? (() => { try { return JSON.parse(m.metadata); } catch { return null; } })() : null,
      }));
    }),

  getByTask: publicQuery
    .input(z.object({ taskId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const messages = await db
        .select()
        .from(taskMessages)
        .where(eq(taskMessages.taskId, input.taskId))
        .orderBy(taskMessages.createdAt);

      // 获取任务基本信息
      const taskRows = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, input.taskId));
      const task = taskRows[0] ?? null;

      return {
        task: task ? {
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          status: task.status,
          lifecycleStatus: task.lifecycleStatus,
          agentId: task.agentId,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        } : null,
        timeline: messages.map((m) => ({
          ...m,
          metadata: m.metadata ? (() => { try { return JSON.parse(m.metadata); } catch { return null; } })() : null,
        })),
        summary: {
          total: messages.length,
          dispatch: messages.filter((m) => m.eventType === "dispatch").length,
          ack: messages.filter((m) => m.eventType === "ack").length,
          progress: messages.filter((m) => m.eventType === "progress").length,
          working: messages.filter((m) => m.eventType === "working").length,
          result: messages.filter((m) => m.eventType === "result").length,
          error: messages.filter((m) => m.eventType === "error").length,
          timeout: messages.filter((m) => m.eventType === "timeout").length,
          cancel: messages.filter((m) => m.eventType === "cancel").length,
          system: messages.filter((m) => m.eventType === "system").length,
        },
      };
    }),
});
