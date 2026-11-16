import { z } from "zod";
import { createRouter, publicQuery, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, agents, taskMessages, taskArtifacts, taskThreads } from "@db/schema";
import { eq, desc, asc, and } from "drizzle-orm";
import { wsManager } from "./ws-manager";
import { enqueueTaskFinalize } from "./lib/finalize-actions";
import { reviewTask } from "./lib/task-review";
import { recordTaskEvent } from "./lib/task-events";
import { LIFECYCLE_STATUSES, isValidLifecycleTransition, applyTaskTransition } from "./lib/task-transition";
import { getInsertId } from "./lib/insert-id";

// ─── A2A-lite v0.1: 多助手任务通信 ───
// 核心语义：
//   dispatch → 任务投递给目标助手
//   ack      → 助手确认收到
//   result   → 助手提交最终结果
//   started  ≠ done/completed（投递成功不代表执行成功）


const lifecycleStatusEnum = z.enum(LIFECYCLE_STATUSES);

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
  return { artifactId: getInsertId(result) };
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

      const dispatchedAt = new Date();
      const transition = await applyTaskTransition(db, {
        taskId: input.taskId,
        lifecycleStatus: nextStatus,
        status: "running", // 保持 backward compat
        at: dispatchedAt,
        expectedRevision: task.stateRevision,
        extra: {
          agentId: input.targetAgentId,
          dispatcherAgentId: input.dispatcherAgentId ?? null,
          dispatchedAt,
        },
      });
      if (!transition.ok) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

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

      const acceptedAt = new Date();
      const transition = await applyTaskTransition(db, {
        taskId: input.taskId,
        lifecycleStatus: nextStatus,
        at: acceptedAt,
        expectedRevision: task.stateRevision,
        extra: { acceptedAt },
      });
      if (!transition.ok) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

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
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");
      if (task.agentId !== input.agentId || (ctx.apiKeyAgentId !== null && ctx.apiKeyAgentId > 0 && ctx.apiKeyAgentId !== input.agentId)) {
        return { success: false, error: "Agent is not the assigned executor of this task" };
      }
      if (["completed", "failed", "timeout", "cancelled"].includes(task.lifecycleStatus ?? "")) {
        return { success: false, error: "Terminal task state is immutable" };
      }

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "working";
      const transition = await applyTaskTransition(db, {
        taskId: input.taskId,
        lifecycleStatus: nextStatus,
        at: new Date(),
        expectedRevision: task.stateRevision,
        // 2026-11-09 碧霄修复：进度上报必须续租——此前 reportWorking 不动
        // workerLeaseExpiresAt，长任务即使一直在报进度也会被清扫器 requeue
        // 空耗 retry（#130 父任务、#133 薇子子任务实证）。
        extra: {
          progress: input.progress ?? task.progress ?? 0,
          workerLeaseExpiresAt: new Date(Date.now() + (task.timeoutMs ?? 300_000)),
        },
      });
      if (!transition.ok) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

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
      // 原先这条没有任何校验，终态任务也能被改成 awaiting_result；现在与兄弟路径一致，
      // 由转移服务的状态机拒绝终态回退。
      const transition = await applyTaskTransition(db, {
        taskId: input.taskId,
        lifecycleStatus: nextStatus,
        at: new Date(),
        expectedRevision: task.stateRevision,
      });
      if (!transition.ok) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

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

      const transition = await applyTaskTransition(db, {
        taskId: input.taskId,
        lifecycleStatus: nextStatus,
        status: "running",
        at: new Date(),
        expectedRevision: task.stateRevision,
        extra: {
          progress: Math.max(task.progress ?? 0, 95),
          output: input.output ?? task.output,
        },
      });
      if (!transition.ok) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

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
  review: authedQuery
    .input(z.object({ taskId: z.number(), approved: z.boolean(), note: z.string().optional() }))
    .mutation(async ({ input, ctx }) => {
      // p2.5-a 抽壳：过程体逐字节搬入 api/lib/task-review.ts（reviewTask），
      // 与 MCP 工具面 review_task 共享同一事实源——鉴权判定、高风险 self-approve
      // 防线、转移、审计事件、completed 归档 finalize 触发全部同源，本薄壳零逻辑。
      // actor 三字段语义与旧过程体内联判定完全一致（ctx.user?.role ?? null 等）。
      const db = getDb();
      return reviewTask(
        db,
        { userRole: ctx.user?.role ?? null, userId: ctx.user?.id ?? null, apiKeyAgentId: ctx.apiKeyAgentId },
        input
      );
    }),

  fail: authedQuery
    .input(z.object({ taskId: z.number(), error: z.string().optional(), agentId: z.number().optional() }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");
      if (task.agentId !== input.agentId || (ctx.apiKeyAgentId !== null && ctx.apiKeyAgentId > 0 && ctx.apiKeyAgentId !== input.agentId)) {
        return { success: false, error: "Agent is not the assigned executor of this task" };
      }

      const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "failed";
      if (!isValidLifecycleTransition(task.lifecycleStatus ?? "created", nextStatus)) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      // status 与 failedAt 由服务从 lifecycleStatus=failed 推导，保证三个维度一致。
      const transition = await applyTaskTransition(db, {
        taskId: input.taskId,
        lifecycleStatus: nextStatus,
        at: new Date(),
        error: input.error ?? task.error,
        expectedRevision: task.stateRevision,
      });
      if (!transition.ok) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      await recordTaskEvent({
        taskId: input.taskId,
        fromAgentId: input.agentId,
        eventType: "error",
        content: input.error ?? "Task marked as failed",
        metadata: { lifecycleStatus: nextStatus },
      });

      // Phase B §3-2：终态动作统一走 finalizeFailedTask（教训 + 产物归档 + 协作父任务汇总
      // 归档 + 失败教训通知）。原先这里内联"教训 + 通知"，漏了产物归档与协作汇总归档。
      // 语义保留：errorChannel 仍标 a2a.fail，检索方仍能按"通道 + 终态"维度过滤。
      try {
        await enqueueTaskFinalize(db, {
          taskId: task.id,
          taskPublicId: task.taskId,
          outcome: "failed",
          errorChannel: "a2a.fail",
          errorText: input.error ?? task.error ?? null,
        });
      } catch (error) {
        console.warn(`[a2a] terminal archive failed for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }

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

      const timeoutText = input.note ? `a2a timeout：${input.note}` : "a2a timeout";
      const timeoutAt = new Date();
      const transition = await applyTaskTransition(db, {
        taskId: input.taskId,
        lifecycleStatus: nextStatus,
        at: timeoutAt,
        expectedRevision: task.stateRevision,
        extra: { timeoutAt },
      });
      if (!transition.ok) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

      await recordTaskEvent({
        taskId: input.taskId,
        eventType: "timeout",
        content: input.note ?? "Task timed out",
        metadata: { lifecycleStatus: nextStatus },
      });

      // Phase B §3-2：同 fail 路径，统一走 finalizeFailedTask。语义保留：errorChannel 仍标
      // a2a.timeout，失败文案仍带 "a2a timeout" 通道来源。
      try {
        await enqueueTaskFinalize(db, {
          taskId: task.id,
          taskPublicId: task.taskId,
          outcome: "failed",
          errorChannel: "a2a.timeout",
          errorText: timeoutText,
        });
      } catch (error) {
        console.warn(`[a2a] terminal archive failed for task ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }

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

      // 取消同样要落粗粒度 status（服务从 cancelled 推导 failed）与 failedAt；
      // 原先这里只改 lifecycleStatus，留下同一行上互相矛盾的两个维度。
      const transition = await applyTaskTransition(db, {
        taskId: input.taskId,
        lifecycleStatus: nextStatus,
        at: new Date(),
        expectedRevision: task.stateRevision,
      });
      if (!transition.ok) {
        return { success: false, error: `Invalid lifecycle transition: ${task.lifecycleStatus} → ${nextStatus}` };
      }

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
