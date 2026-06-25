import { z } from "zod";
import { createRouter, publicQuery, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, taskMessages, taskArtifacts } from "@db/schema";
import { eq, and, or, like, desc, asc, inArray } from "drizzle-orm";
import { validateBoardTransition, isTerminalStatus } from "./lib/taskboard-validator";
import { wsManager } from "./ws-manager";
import { sendMailboxNotification, broadcastTaskNotification, autoPromoteParentTask, checkAndUnblockDependencies } from "./lib/taskboard-notify";

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

  claim: authedQuery
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

  heartbeat: authedQuery
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

  progress: authedQuery
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

  submit: authedQuery
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

      // Determine reviewer: parent task agent > dispatcher > null
      let reviewerId: number | null = null;
      if (row.parentTaskId) {
        const parent = await db.select().from(tasks).where(eq(tasks.id, row.parentTaskId)).then((r) => r[0]);
        if (parent?.agentId) reviewerId = parent.agentId;
      }
      if (!reviewerId && row.dispatcherAgentId) {
        reviewerId = row.dispatcherAgentId;
      }

      const updateFields: Record<string, unknown> = {
        boardStatus: "review",
        reviewAt: new Date(),
        reviewerId,
      };
      if (input.output !== undefined) updateFields.output = input.output;

      await db.update(tasks).set(updateFields).where(eq(tasks.id, input.taskId));

      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: input.output || `Task submitted by agent ${input.agentId}`,
        metadata: stringifyJson({ action: "submit", agentId: input.agentId, previousBoardStatus: row.boardStatus, reviewerId }),
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

      await broadcastTaskNotification({
        taskId: input.taskId,
        taskName: row.name,
        fromStatus: "running",
        toStatus: "review",
        changedBy: input.agentId,
      });

      if (reviewerId) {
        await sendMailboxNotification({
          fromAgentId: input.agentId,
          toAgentId: reviewerId,
          taskId: input.taskId,
          type: "review_request",
          subject: `Review requested: ${row.name}`,
          body: `Task "${row.name}" has been submitted by agent ${input.agentId} and is awaiting review.`,
        });
      }

      return { success: true };
    }),

  block: authedQuery
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

  unblock: authedQuery
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

  updateStatus: authedQuery
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
      await broadcastTaskNotification({
        taskId: input.taskId,
        taskName: row.name,
        fromStatus: from,
        toStatus: to,
        changedBy: input.agentId,
      });
      if (to === "done" || to === "failed") {
        await autoPromoteParentTask(input.taskId);
        await checkAndUnblockDependencies(input.taskId);
      }
      return { success: true };
    }),

  approve: adminQuery
    .input(
      z.object({
        taskId: z.number(),
        agentId: z.number(),
        comment: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (row.boardStatus !== "review") throw new Error(`Task is not in review (current: ${row.boardStatus})`);
      if (row.reviewerId && row.reviewerId !== input.agentId) {
        throw new Error("Only the assigned reviewer can approve this task");
      }
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
        content: input.comment ? `Approved: ${input.comment}` : `Task approved by agent ${input.agentId}`,
        metadata: stringifyJson({ action: "approve", agentId: input.agentId, previousBoardStatus: row.boardStatus, comment: input.comment }),
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
      await broadcastTaskNotification({
        taskId: input.taskId,
        taskName: row.name,
        fromStatus: "review",
        toStatus: "done",
        changedBy: input.agentId,
      });
      if (row.agentId) {
        await sendMailboxNotification({
          fromAgentId: input.agentId,
          toAgentId: row.agentId,
          taskId: input.taskId,
          type: "result_notice",
          subject: `Task approved: ${row.name}`,
          body: input.comment ? `Your task "${row.name}" has been approved. Comment: ${input.comment}` : `Your task "${row.name}" has been approved.`,
        });
      }
      await autoPromoteParentTask(input.taskId);
      await checkAndUnblockDependencies(input.taskId);
      return { success: true };
    }),

  reject: adminQuery
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
      if (row.reviewerId && row.reviewerId !== input.agentId) {
        throw new Error("Only the assigned reviewer can reject this task");
      }
      await db
        .update(tasks)
        .set({
          boardStatus: "failed",
          status: "failed",
          failedAt: new Date(),
          reviewResult: "rejected",
          reviewerId: input.agentId,
        })
        .where(eq(tasks.id, input.taskId));
      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: input.reason ? `Rejected: ${input.reason}` : `Task rejected by agent ${input.agentId}`,
        metadata: stringifyJson({ action: "reject", agentId: input.agentId, previousBoardStatus: row.boardStatus, reason: input.reason }),
      });
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "rejected",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: "failed",
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });
      await broadcastTaskNotification({
        taskId: input.taskId,
        taskName: row.name,
        fromStatus: "review",
        toStatus: "failed",
        changedBy: input.agentId,
      });
      if (row.agentId) {
        await sendMailboxNotification({
          fromAgentId: input.agentId,
          toAgentId: row.agentId,
          taskId: input.taskId,
          type: "result_notice",
          subject: `Task rejected: ${row.name}`,
          body: input.reason ? `Your task "${row.name}" has been rejected. Reason: ${input.reason}` : `Your task "${row.name}" has been rejected.`,
        });
      }
      await autoPromoteParentTask(input.taskId);
      await checkAndUnblockDependencies(input.taskId);
      return { success: true };
    }),

  requestChanges: adminQuery
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
      if (row.reviewerId && row.reviewerId !== input.agentId) {
        throw new Error("Only the assigned reviewer can request changes on this task");
      }
      await db
        .update(tasks)
        .set({
          boardStatus: "running",
          status: "running",
          reviewResult: "changes_requested",
          reviewerId: input.agentId,
        })
        .where(eq(tasks.id, input.taskId));
      await db.insert(taskMessages).values({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: input.reason ? `Changes requested: ${input.reason}` : `Changes requested by agent ${input.agentId}`,
        metadata: stringifyJson({ action: "requestChanges", agentId: input.agentId, previousBoardStatus: row.boardStatus, reason: input.reason }),
      });
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "changes_requested",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: "running",
        agentId: input.agentId,
        timestamp: new Date().toISOString(),
      });
      await broadcastTaskNotification({
        taskId: input.taskId,
        taskName: row.name,
        fromStatus: "review",
        toStatus: "running",
        changedBy: input.agentId,
      });
      if (row.agentId) {
        await sendMailboxNotification({
          fromAgentId: input.agentId,
          toAgentId: row.agentId,
          taskId: input.taskId,
          type: "result_notice",
          subject: `Changes requested: ${row.name}`,
          body: input.reason ? `Changes requested for "${row.name}". Reason: ${input.reason}` : `Changes requested for "${row.name}".`,
        });
      }
      return { success: true };
    }),

  listReviewTasks: publicQuery
    .input(
      z.object({
        agentId: z.number(),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(tasks)
        .where(and(eq(tasks.boardStatus, "review"), eq(tasks.reviewerId, input.agentId)))
        .orderBy(desc(tasks.priority), asc(tasks.createdAt))
        .limit(200);
    }),

  getDependencyChain: publicQuery
    .input(z.object({ taskId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const { taskDependencies } = await import("@db/schema");

      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) return null;

      const blocks = await db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, input.taskId));
      const blockedBy = await db
        .select()
        .from(taskDependencies)
        .where(eq(taskDependencies.dependsOnTaskId, input.taskId));

      const relatedIds = [
        ...blocks.map((b) => b.dependsOnTaskId),
        ...blockedBy.map((b) => b.taskId),
      ];

      const relatedTasks =
        relatedIds.length > 0
          ? await db
              .select({ id: tasks.id, taskId: tasks.taskId, name: tasks.name, boardStatus: tasks.boardStatus })
              .from(tasks)
              .where(inArray(tasks.id, relatedIds))
          : [];

      const taskMap = new Map(relatedTasks.map((t) => [t.id, t]));

      return {
        taskId: input.taskId,
        taskKey: task.taskId,
        name: task.name,
        boardStatus: task.boardStatus,
        blocks: blocks.map((b) => ({
          dependencyId: b.id,
          taskId: b.dependsOnTaskId,
          task: taskMap.get(b.dependsOnTaskId) ?? null,
        })),
        blockedBy: blockedBy.map((b) => ({
          dependencyId: b.id,
          taskId: b.taskId,
          task: taskMap.get(b.taskId) ?? null,
        })),
      };
    }),

  comment: authedQuery
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

  create: authedQuery
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

  dispatch: authedQuery
    .input(z.object({ taskId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!row) throw new Error("Task not found");
      if (row.status !== "pending" && row.status !== "queued") {
        throw new Error(`Task cannot be dispatched (current status: ${row.status})`);
      }

      await db
        .update(tasks)
        .set({
          status: "queued",
          lifecycleStatus: "dispatched",
          dispatchedAt: new Date(),
        })
        .where(eq(tasks.id, input.taskId));

      await db.insert(taskMessages).values({
        taskId: input.taskId,
        eventType: "system",
        content: `Task dispatched`,
        metadata: stringifyJson({ action: "dispatch", previousStatus: row.status }),
      });

      // If agentId is set, send a message to the agent
      if (row.agentId) {
        await db.insert(taskMessages).values({
          taskId: input.taskId,
          fromAgentId: row.agentId,
          eventType: "dispatch",
          content: `Task dispatched to agent ${row.agentId}`,
          metadata: stringifyJson({ action: "dispatch", agentId: row.agentId }),
        });
      }

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "dispatched",
        id: input.taskId,
        taskId: row.taskId,
        name: row.name,
        status: "queued",
        agentId: row.agentId,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    }),
});
