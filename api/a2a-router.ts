import { z } from "zod";
import { createRouter, publicQuery, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, agents, taskMessages, taskArtifacts, taskThreads } from "@db/schema";
import { eq, desc, asc, and } from "drizzle-orm";
import { wsManager } from "./ws-manager";

// ─── A2A-lite v0.1: 多助手任务通信 ───
// 核心语义：
//   dispatch → 任务投递给目标助手
//   ack      → 助手确认收到
//   result   → 助手提交最终结果
//   started  ≠ done/completed（投递成功不代表执行成功）

const LIFECYCLE_STATUSES = [
  "created",
  "queued",
  "claimed",
  "dispatched",
  "accepted",
  "working",
  "awaiting_result",
  "submitted",
  "reviewing",
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;

const lifecycleStatusEnum = z.enum(LIFECYCLE_STATUSES);

/** 记录 task_message 事件 */
async function recordTaskEvent(
  input: {
    taskId: number;
    fromAgentId?: number;
    toAgentId?: number;
    eventType: typeof taskMessages.$inferInsert["eventType"];
    content?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const db = getDb();
  await db.insert(taskMessages).values({
    taskId: input.taskId,
    fromAgentId: input.fromAgentId ?? null,
    toAgentId: input.toAgentId ?? null,
    eventType: input.eventType,
    content: input.content ?? null,
    metadata: input.metadata ? JSON.stringify(input.metadata) : null,
  });
}

/** 记录 task_artifact */
async function recordArtifact(
  input: {
    taskId: number;
    agentId?: number;
    type: string;
    name?: string;
    content?: string;
    jsonPayload?: Record<string, unknown>;
    mimeType?: string;
  }
) {
  const db = getDb();
  const result = await db.insert(taskArtifacts).values({
    taskId: input.taskId,
    agentId: input.agentId ?? null,
    type: input.type,
    name: input.name ?? null,
    content: input.content ?? null,
    jsonPayload: input.jsonPayload ? JSON.stringify(input.jsonPayload) : null,
    mimeType: input.mimeType ?? null,
  });
  return { artifactId: (result as any).insertId as number };
}

/** 安全地更新 lifecycleStatus（严格向前流转，禁止非法回退和跳跃） */
function isValidLifecycleTransition(from: string, to: string): boolean {
  // terminal states 不可逆
  if (["completed", "failed", "timeout", "cancelled"].includes(from)) {
    return false;
  }
  // 已到达 submitted 后不能回退到 working/dispatched/accepted/claimed 等
  if (from === "submitted" && !["reviewing", "completed", "failed", "timeout", "cancelled"].includes(to)) {
    return false;
  }
  if (from === "reviewing" && !["completed", "failed", "timeout", "cancelled"].includes(to)) {
    return false;
  }
  // completed 只能从 submitted 或 reviewing 进入
  if (to === "completed" && !["submitted", "reviewing"].includes(from)) {
    return false;
  }
  // submitted 只能从 awaiting_result、working、dispatched、accepted、claimed 或 created/queued 进入
  if (to === "submitted" && !["awaiting_result", "working", "dispatched", "accepted", "claimed", "queued", "created"].includes(from)) {
    return false;
  }
  // reviewing 只能从 submitted 进入
  if (to === "reviewing" && from !== "submitted") {
    return false;
  }
  return true;
}

export const a2aRouter = createRouter({
  // ─── 1. AgentCard 查询/更新 ───
  getAgentCard: publicQuery
    .input(z.object({ agentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const row = await db.select().from(agents).where(eq(agents.id, input.agentId)).then((r) => r[0]);
      if (!row) return null;
      let card: Record<string, unknown> | null = null;
      if (row.agentCard) {
        try { card = JSON.parse(row.agentCard); } catch { /* ignore */ }
      }
      return {
        id: row.id,
        agentId: row.agentId,
        name: row.name,
        displayName: row.name,
        openclawAgent: row.openclawAgent,
        capabilities: row.capabilities,
        agentCard: card,
        canModifyTiangongCore: row.canModifyTiangongCore === "true",
        canSendExternalMessage: row.canSendExternalMessage === "true",
      };
    }),

  updateAgentCard: authedQuery
    .input(z.object({
      agentId: z.number(),
      agentCard: z.record(z.string(), z.any()).optional(),
      openclawAgent: z.string().optional(),
      canModifyTiangongCore: z.boolean().optional(),
      canSendExternalMessage: z.boolean().optional(),
      capabilities: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const updates: Record<string, unknown> = {};
      if (input.agentCard !== undefined) updates.agentCard = JSON.stringify(input.agentCard);
      if (input.openclawAgent !== undefined) updates.openclawAgent = input.openclawAgent;
      if (input.canModifyTiangongCore !== undefined) updates.canModifyTiangongCore = input.canModifyTiangongCore ? "true" : "false";
      if (input.canSendExternalMessage !== undefined) updates.canSendExternalMessage = input.canSendExternalMessage ? "true" : "false";
      if (input.capabilities !== undefined) updates.capabilities = input.capabilities;
      if (Object.keys(updates).length > 0) {
        await db.update(agents).set(updates).where(eq(agents.id, input.agentId));
      }
      return { success: true };
    }),

  // ─── 2. Dispatch: 任务投递给目标助手 ───
  dispatch: authedQuery
    .input(z.object({
      taskId: z.number(),
      targetAgentId: z.number(),
      dispatcherAgentId: z.number().optional(),
      payload: z.string().optional(), // dispatch 附加内容
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      const agent = await db.select().from(agents).where(eq(agents.id, input.targetAgentId)).then((r) => r[0]);
      if (!agent) throw new Error("Target agent not found");

      // dispatcher 权限检查
      if (ctx.apiKeyAgentId !== null) {
        if (!(ctx.apiKeyAgentId > 0 || ctx.apiKeyAgentId === -1)) {
          throw new Error("Dispatcher not authorized");
        }
      }

      // 更新 lifecycle 到 dispatched（或 awaiting_result 如果直接投递到外部 runner）
      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "dispatched";
      if (!isValidLifecycleTransition(task.lifecycleStatus ?? "created", nextStatus)) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      await db.update(tasks).set({
        lifecycleStatus: nextStatus,
        status: "running", // 保持 backward compat
        agentId: input.targetAgentId,
        dispatcherAgentId: input.dispatcherAgentId ?? null,
        dispatchedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(tasks.id, input.taskId));

      // 记录 dispatch event
      await recordTaskEvent({
        taskId: input.taskId,
        fromAgentId: input.dispatcherAgentId,
        toAgentId: input.targetAgentId,
        eventType: "dispatch",
        content: input.payload ?? `Task dispatched to Agent#${input.targetAgentId} (${agent.name})`,
        metadata: { targetAgentId: input.targetAgentId, dispatcherAgentId: input.dispatcherAgentId, lifecycleStatus: nextStatus },
      });

      // 广播
      wsManager.broadcastToDashboard({
        type: "a2a_dispatch",
        taskId: task.taskId,
        taskDbId: input.taskId,
        targetAgentId: input.targetAgentId,
        targetAgentName: agent.name,
        lifecycleStatus: nextStatus,
        timestamp: new Date().toISOString(),
      });

      return { success: true, lifecycleStatus: nextStatus };
    }),

  // ─── 3. ACK: 助手确认收到任务 ───
  ack: authedQuery
    .input(z.object({
      taskId: z.number(),
      agentId: z.number(),
      note: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      if (task.agentId !== input.agentId) {
        return { success: false, error: "Agent is not the assigned executor of this task" };
      }

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "accepted";
      if (!isValidLifecycleTransition(task.lifecycleStatus ?? "created", nextStatus)) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      await db.update(tasks).set({
        lifecycleStatus: nextStatus,
        acceptedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(tasks.id, input.taskId));

      await recordTaskEvent({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "ack",
        content: input.note ?? "Agent acknowledged task receipt",
        metadata: { lifecycleStatus: nextStatus },
      });

      wsManager.broadcastToDashboard({
        type: "a2a_ack",
        taskId: task.taskId,
        taskDbId: input.taskId,
        agentId: input.agentId,
        lifecycleStatus: nextStatus,
        timestamp: new Date().toISOString(),
      });

      return { success: true, lifecycleStatus: nextStatus };
    }),

  // ─── 4. Progress/Working: 助手报告执行中 ───
  reportWorking: authedQuery
    .input(z.object({
      taskId: z.number(),
      agentId: z.number(),
      progress: z.number().min(0).max(100).optional(),
      note: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "working";
      await db.update(tasks).set({
        lifecycleStatus: nextStatus,
        progress: input.progress ?? task.progress ?? 0,
        updatedAt: new Date(),
      }).where(eq(tasks.id, input.taskId));

      await recordTaskEvent({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "working",
        content: input.note ?? "Agent reports working on task",
        metadata: { progress: input.progress, lifecycleStatus: nextStatus },
      });

      return { success: true, lifecycleStatus: nextStatus };
    }),

  // ─── 5. AwaitingResult: 投递后等待最终结果 ───
  markAwaitingResult: authedQuery
    .input(z.object({
      taskId: z.number(),
      agentId: z.number().optional(),
      note: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "awaiting_result";
      await db.update(tasks).set({
        lifecycleStatus: nextStatus,
        updatedAt: new Date(),
      }).where(eq(tasks.id, input.taskId));

      await recordTaskEvent({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "system",
        content: input.note ?? "Task is awaiting final result from agent",
        metadata: { previousStatus: task.lifecycleStatus, lifecycleStatus: nextStatus },
      });

      return { success: true, lifecycleStatus: nextStatus };
    }),

  // ─── 6. SubmitResult: 助手提交最终结果 ───
  submitResult: authedQuery
    .input(z.object({
      taskId: z.number(),
      agentId: z.number(),
      output: z.string().optional(),
      artifactType: z.string().default("result"),
      artifactName: z.string().optional(),
      artifactJson: z.record(z.string(), z.any()).optional(),
      mimeType: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      if (task.agentId !== input.agentId) {
        return { success: false, error: "Agent is not the assigned executor of this task" };
      }

      // 权限检查：API Key 认证时，提交者必须是任务执行者
      if (ctx.apiKeyAgentId !== null && ctx.apiKeyAgentId > 0 && ctx.apiKeyAgentId !== input.agentId) {
        throw new Error("Agent is not the assigned executor of this task");
      }

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "submitted";
      if (!isValidLifecycleTransition(task.lifecycleStatus ?? "created", nextStatus)) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      await db.update(tasks).set({
        lifecycleStatus: nextStatus,
        status: "running",
        progress: Math.max(task.progress ?? 0, 95),
        output: input.output ?? task.output,
        updatedAt: new Date(),
      }).where(eq(tasks.id, input.taskId));

      // 记录 submit event
      await recordTaskEvent({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "result",
        content: input.output ?? "Agent submitted result",
        metadata: { artifactType: input.artifactType, lifecycleStatus: nextStatus },
      });

      // 保存 artifact
      const { artifactId } = await recordArtifact({
        taskId: input.taskId,
        agentId: input.agentId,
        type: input.artifactType,
        name: input.artifactName ?? `result-${task.taskId}`,
        content: input.output ?? undefined,
        jsonPayload: input.artifactJson,
        mimeType: input.mimeType,
      });

      wsManager.broadcastToDashboard({
        type: "a2a_submit",
        taskId: task.taskId,
        taskDbId: input.taskId,
        agentId: input.agentId,
        lifecycleStatus: nextStatus,
        artifactId,
        timestamp: new Date().toISOString(),
      });

      return { success: true, lifecycleStatus: nextStatus, artifactId };
    }),

  // ─── 7. Review / Complete / Fail / Timeout / Cancel ───
  review: adminQuery
    .input(z.object({ taskId: z.number(), approved: z.boolean(), note: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      // 权限检查：API Key 认证时，Agent 必须有 admin 角色
      if (ctx.apiKeyAgentId !== null && ctx.apiKeyAgentId > 0) {
        const agent = await db.select().from(agents).where(eq(agents.id, ctx.apiKeyAgentId)).then((r) => r[0]);
        if (!agent || agent.role !== "admin") {
          throw new Error("需要管理员权限");
        }
      }

      // 只能从 submitted 或 reviewing 进入 review
      if (!["submitted", "reviewing"].includes(task.lifecycleStatus ?? "")) {
        return { success: false, error: `Cannot review task from status ${task.lifecycleStatus}. Must be submitted or reviewing.` };
      }

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = input.approved ? "completed" : "reviewing";
      if (!isValidLifecycleTransition(task.lifecycleStatus ?? "created", nextStatus)) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      await db.update(tasks).set({
        lifecycleStatus: nextStatus,
        status: input.approved ? "done" : task.status,
        progress: input.approved ? 100 : task.progress,
        completedAt: input.approved ? new Date() : task.completedAt,
        updatedAt: new Date(),
      }).where(eq(tasks.id, input.taskId));

      await recordTaskEvent({
        taskId: input.taskId,
        eventType: input.approved ? "result" : "system",
        content: input.note ?? (input.approved ? "Task reviewed and approved" : "Task under review"),
        metadata: { approved: input.approved, previousStatus: task.lifecycleStatus, lifecycleStatus: nextStatus },
      });

      if (input.approved) {
        wsManager.broadcastToDashboard({
          type: "a2a_complete",
          taskId: task.taskId,
          taskDbId: input.taskId,
          lifecycleStatus: nextStatus,
          timestamp: new Date().toISOString(),
        });
      }

      return { success: true, lifecycleStatus: nextStatus };
    }),

  fail: authedQuery
    .input(z.object({ taskId: z.number(), error: z.string().optional(), agentId: z.number().optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "failed";
      if (!isValidLifecycleTransition(task.lifecycleStatus ?? "created", nextStatus)) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      await db.update(tasks).set({
        lifecycleStatus: nextStatus,
        status: "failed",
        error: input.error ?? task.error,
        failedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(tasks.id, input.taskId));

      await recordTaskEvent({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "error",
        content: input.error ?? "Task marked as failed",
        metadata: { lifecycleStatus: nextStatus },
      });

      wsManager.broadcastToDashboard({
        type: "a2a_fail",
        taskId: task.taskId,
        taskDbId: input.taskId,
        lifecycleStatus: nextStatus,
        timestamp: new Date().toISOString(),
      });

      return { success: true, lifecycleStatus: nextStatus };
    }),

  timeout: authedQuery
    .input(z.object({ taskId: z.number(), note: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "timeout";
      if (!isValidLifecycleTransition(task.lifecycleStatus ?? "created", nextStatus)) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      await db.update(tasks).set({
        lifecycleStatus: nextStatus,
        status: "failed",
        timeoutAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(tasks.id, input.taskId));

      await recordTaskEvent({
        taskId: input.taskId,
        eventType: "timeout",
        content: input.note ?? "Task timed out",
        metadata: { lifecycleStatus: nextStatus },
      });

      return { success: true, lifecycleStatus: nextStatus };
    }),

  cancel: adminQuery
    .input(z.object({ taskId: z.number(), note: z.string().optional() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "cancelled";
      if (!isValidLifecycleTransition(task.lifecycleStatus ?? "created", nextStatus)) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      await db.update(tasks).set({
        lifecycleStatus: nextStatus,
        updatedAt: new Date(),
      }).where(eq(tasks.id, input.taskId));

      await recordTaskEvent({
        taskId: input.taskId,
        eventType: "cancel",
        content: input.note ?? "Task cancelled",
        metadata: { lifecycleStatus: nextStatus },
      });

      return { success: true, lifecycleStatus: nextStatus };
    }),

  // ─── 8. Thread / Messages / Artifacts 查询 ───
  getThread: publicQuery
    .input(z.object({ taskId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) return null;

      const threads = await db.select().from(taskThreads).where(eq(taskThreads.taskId, input.taskId));
      const messages = await db.select().from(taskMessages).where(eq(taskMessages.taskId, input.taskId)).orderBy(asc(taskMessages.createdAt));
      const artifacts = await db.select().from(taskArtifacts).where(eq(taskArtifacts.taskId, input.taskId)).orderBy(desc(taskArtifacts.createdAt));

      return {
        task: {
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          lifecycleStatus: task.lifecycleStatus,
          status: task.status,
          progress: task.progress,
          agentId: task.agentId,
          dispatcherAgentId: task.dispatcherAgentId,
          claimedAt: task.claimedAt,
          dispatchedAt: task.dispatchedAt,
          acceptedAt: task.acceptedAt,
          completedAt: task.completedAt,
          failedAt: task.failedAt,
          timeoutAt: task.timeoutAt,
        },
        threads: threads.map((t) => ({
          ...t,
          createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
        })),
        messages: messages.map((m) => ({
          ...m,
          metadata: m.metadata ? (() => { try { return JSON.parse(m.metadata); } catch { return null; } })() : null,
          createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
        })),
        artifacts: artifacts.map((a) => ({
          ...a,
          jsonPayload: a.jsonPayload ? (() => { try { return JSON.parse(a.jsonPayload); } catch { return null; } })() : null,
          createdAt: a.createdAt instanceof Date ? a.createdAt.toISOString() : a.createdAt,
        })),
      };
    }),

  addArtifact: authedQuery
    .input(z.object({
      taskId: z.number(),
      agentId: z.number().optional(),
      type: z.string().min(1).max(50),
      name: z.string().optional(),
      content: z.string().optional(),
      jsonPayload: z.record(z.string(), z.any()).optional(),
      mimeType: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const { artifactId } = await recordArtifact(input);
      return { success: true, artifactId };
    }),

  listArtifacts: publicQuery
    .input(z.object({ taskId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(taskArtifacts).where(eq(taskArtifacts.taskId, input.taskId)).orderBy(desc(taskArtifacts.createdAt));
    }),
});
