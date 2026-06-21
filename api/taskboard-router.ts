import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, taskMessages, taskArtifacts } from "@db/schema";
import { eq, and, or, like, desc, asc } from "drizzle-orm";
import { validateBoardTransition, isTerminalStatus } from "./lib/taskboard-validator";
import { wsManager } from "./ws-manager";

function parseJson<T = unknown>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function stringifyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export const taskboardRouter = createRouter({
  list: publicQuery
    .input(
      z
        .object({
          boardStatus: z
            .enum([
              "triage",
              "backlog",
              "todo",
              "ready",
              "running",
              "review",
              "blocked",
              "done",
              "failed",
              "cancelled",
            ])
            .optional(),
          agentId: z.number().optional(),
          keyword: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: (ReturnType<typeof eq> | ReturnType<typeof or> | ReturnType<typeof and>)[] = [];
      if (input?.boardStatus) conditions.push(eq(tasks.boardStatus, input.boardStatus));
      if (input?.agentId) conditions.push(eq(tasks.agentId, input.agentId));
      if (input?.keyword && input.keyword.trim()) {
        const kw = `%${input.keyword.trim()}%`;
        const orCond = or(like(tasks.name, kw), like(tasks.description, kw));
        if (orCond) conditions.push(orCond);
      }
      if (conditions.length > 0) {
        return db
          .select()
          .from(tasks)
          .where(and(...conditions))
          .orderBy(desc(tasks.priority), asc(tasks.createdAt))
          .limit(200);
      }
      return db.select().from(tasks).orderBy(desc(tasks.priority), asc(tasks.createdAt)).limit(200);
    }),

  get: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(tasks).where(eq(tasks.id, input.id));
      const task = rows[0] ?? null;
      if (!task) return null;

      const messages = await db
        .select()
        .from(taskMessages)
        .where(eq(taskMessages.taskId, input.id))
        .orderBy(asc(taskMessages.createdAt));
      const artifacts = await db
        .select()
        .from(taskArtifacts)
        .where(eq(taskArtifacts.taskId, input.id))
        .orderBy(desc(taskArtifacts.createdAt));

      return {
        ...task,
        boardLabels: parseJson<string[]>(task.boardLabels),
        threadMessages: messages.map((m) => ({
          ...m,
          metadata: parseJson(m.metadata),
        })),
        artifacts: artifacts.map((a) => ({
          ...a,
          jsonPayload: parseJson(a.jsonPayload),
        })),
      };
    }),

  claim: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (row.boardStatus !== "ready") throw new Error(`Task is not ready (current: ${row.boardStatus})`);

      await db
        .update(tasks)
        .set({
          boardStatus: "running",
          status: "running",
          agentId: input.agentId,
          claimedAt: new Date(),
          lastHeartbeatAt: new Date(),
        })
        .where(eq(tasks.id, input.taskId));

      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: `Task claimed by agent ${input.agentId}`,
        metadata: stringifyJson({ action: "claim", agentId: input.agentId, previousBoardStatus: row.boardStatus }),
      });

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "claimed",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: "running",
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    }),

  heartbeat: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (row.agentId !== input.agentId) throw new Error("Task is not assigned to this agent");

      await db
        .update(tasks)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(tasks.id, input.taskId));

      return { success: true };
    }),

  progress: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
        progress: z.number().min(0).max(100),
        message: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (row.agentId !== input.agentId) throw new Error("Task is not assigned to this agent");
      if (row.boardStatus !== "running") throw new Error(`Task is not running (current: ${row.boardStatus})`);

      await db
        .update(tasks)
        .set({ progress: input.progress })
        .where(eq(tasks.id, input.taskId));

      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "progress",
        content: input.message || `Progress ${input.progress}%`,
        metadata: stringifyJson({ action: "progress", progress: input.progress }),
      });

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "progress",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        progress: input.progress,
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    }),

  submit: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
        output: z.string().optional(),
        artifactType: z.string().optional(),
        artifactPayload: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (row.agentId !== input.agentId) throw new Error("Task is not assigned to this agent");
      if (row.boardStatus !== "running") throw new Error(`Task is not running (current: ${row.boardStatus})`);

      const updateFields: Record<string, unknown> = {
        boardStatus: "review",
        reviewAt: new Date(),
      };
      if (input.output !== undefined) updateFields.output = input.output;

      await db.update(tasks).set(updateFields).where(eq(tasks.id, input.taskId));

      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: input.output || `Task submitted by agent ${input.agentId}`,
        metadata: stringifyJson({ action: "submit", agentId: input.agentId, previousBoardStatus: row.boardStatus }),
      });

      if (input.artifactType && input.artifactPayload) {
        await db.insert(taskArtifacts).values({
          taskId: input.taskId,
          agentId: input.agentId,
          type: input.artifactType,
          content: input.artifactPayload,
        });
      }

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "submitted",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: "running",
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    }),

  block: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
        reason: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (isTerminalStatus(row.boardStatus || "")) throw new Error("Cannot block a terminal task");

      await db
        .update(tasks)
        .set({
          boardStatus: "blocked",
          blockedAt: new Date(),
          boardNotes: input.reason,
        })
        .where(eq(tasks.id, input.taskId));

      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: `Blocked: ${input.reason}`,
        metadata: stringifyJson({
          action: "block",
          agentId: input.agentId,
          previousBoardStatus: row.boardStatus,
        }),
      });

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "blocked",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: row.status,
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    }),

  unblock: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (row.boardStatus !== "blocked") throw new Error(`Task is not blocked (current: ${row.boardStatus})`);

      // Infer previous boardStatus from task_messages history
      const messages = await db
        .select()
        .from(taskMessages)
        .where(and(eq(taskMessages.taskId, input.taskId), eq(taskMessages.eventType, "system")))
        .orderBy(desc(taskMessages.createdAt))
        .limit(20);

      let previousStatus = "todo";
      for (const msg of messages) {
        const meta = parseJson<Record<string, unknown>>(msg.metadata);
        if (meta?.action === "block" && typeof meta?.previousBoardStatus === "string") {
          previousStatus = meta.previousBoardStatus;
          break;
        }
      }

      await db
        .update(tasks)
        .set({ boardStatus: previousStatus })
        .where(eq(tasks.id, input.taskId));

      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: `Unblocked: returning to ${previousStatus}`,
        metadata: stringifyJson({
          action: "unblock",
          agentId: input.agentId,
          previousBoardStatus: "blocked",
          restoredBoardStatus: previousStatus,
        }),
      });

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "unblocked",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: row.status,
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    }),

  updateStatus: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
        boardStatus: z.enum([
          "triage",
          "backlog",
          "todo",
          "ready",
          "running",
          "review",
          "blocked",
          "done",
          "failed",
          "cancelled",
        ]),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      const from = row.boardStatus || "triage";
      const to = input.boardStatus;
      if (from === to) return { success: true };
      if (!validateBoardTransition(from, to)) {
        throw new Error(`Invalid transition from ${from} to ${to}`);
      }
      const updateFields: Record<string, unknown> = { boardStatus: to };
      if (to === "done") {
        updateFields.completedAt = new Date();
        updateFields.status = "done";
      } else if (to === "failed") {
        updateFields.failedAt = new Date();
        updateFields.status = "failed";
      } else if (to === "running") {
        updateFields.status = "running";
      }
      await db.update(tasks).set(updateFields).where(eq(tasks.id, input.taskId));
      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: `Status changed from ${from} to ${to}`,
        metadata: stringifyJson({ action: "updateStatus", agentId: input.agentId, previousBoardStatus: from, newBoardStatus: to }),
      });
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "status_changed",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: to,
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });
      return { success: true };
    }),

  approve: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (row.boardStatus !== "review") throw new Error(`Task is not in review (current: ${row.boardStatus})`);
      await db
        .update(tasks)
        .set({
          boardStatus: "done",
          status: "done",
          completedAt: new Date(),
          reviewerId: input.agentId,
          reviewResult: "approved",
        })
        .where(eq(tasks.id, input.taskId));
      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: `Task approved by agent ${input.agentId}`,
        metadata: stringifyJson({ action: "approve", agentId: input.agentId, previousBoardStatus: row.boardStatus }),
      });
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "approved",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: "done",
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });
      return { success: true };
    }),

  reject: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
        reason: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (row.boardStatus !== "review") throw new Error(`Task is not in review (current: ${row.boardStatus})`);
      await db
        .update(tasks)
        .set({
          boardStatus: "running",
          status: "running",
          reviewResult: "rejected",
        })
        .where(eq(tasks.id, input.taskId));
      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: input.reason ? `Rejected: ${input.reason}` : `Task rejected by agent ${input.agentId}, returned to running`,
        metadata: stringifyJson({ action: "reject", agentId: input.agentId, previousBoardStatus: row.boardStatus }),
      });
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "rejected",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: "running",
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });
      return { success: true };
    }),

  comment: publicQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
        content: z.string(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");

      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: input.content,
        metadata: stringifyJson({ action: "comment", agentId: input.agentId }),
      });

      return { success: true };
    }),

  create: publicQuery
    .input(
      z.object({
        name: z.string().min(1).max(255),
        description: z.string().optional(),
        agentId: z.number().optional(),
        priority: z.number().optional(),
        parentTaskId: z.number().optional(),
        sourceUrl: z.string().max(500).optional(),
        boardLabels: z.array(z.string()).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const ts = Date.now().toString(36).slice(-5).toUpperCase();
      const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
      const taskId = `TG-${ts}${rand}`;

      const result = await db.insert(tasks).values({
        taskId,
        name: input.name,
        description: input.description ?? null,
        agentId: input.agentId ?? null,
        priority: input.priority ?? 0,
        parentTaskId: input.parentTaskId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        boardLabels: input.boardLabels ? JSON.stringify(input.boardLabels) : null,
        boardStatus: "triage",
        status: "pending",
        lifecycleStatus: "created",
      });

      const insertId = (result as any).insertId as number;

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "created",
        id: insertId,
        taskId,
        name: input.name,
        status: "pending",
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });

      return { success: true, id: insertId, taskId };
    }),
});
