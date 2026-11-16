import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, taskDependencies, agents } from "@db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { applyTaskTransition, isTerminalLifecycle } from "./lib/task-transition";
import { wsManager } from "./ws-manager";
import { emitCollabSummaryForTask } from "./lib/collaboration-events";
import { applyRequestedAgentToInput } from "./lib/task-metadata";
import { checkCompletionGate, parkTaskForApproval } from "./lib/execution-gate";
import { isUniqueConstraintViolation } from "./lib/db-error";
import {
  ORIGIN_SYSTEM_TIANGONG,
  assertDeclaredExecutor,
  findTaskByIdempotencyKey,
  toReusedTaskResult,
} from "./lib/create-task-gate";

// ─── Helpers ───

/** Detects cycles in task dependency graph using DFS */
async function hasCycle(taskId: number, newDepsOn: number[]): Promise<boolean> {
  const db = getDb();
  const allDeps = await db.select().from(taskDependencies);
  const allTasks = await db.select({ id: tasks.id, status: tasks.status }).from(tasks);

  const taskIds = new Set(allTasks.map(t => t.id));
  const adj = new Map<number, number[]>();
  for (const d of allDeps) {
    if (!adj.has(d.taskId)) adj.set(d.taskId, []);
    adj.get(d.taskId)!.push(d.dependsOnTaskId);
  }
  // Add new edges
  for (const dep of newDepsOn) {
    if (!adj.has(taskId)) adj.set(taskId, []);
    adj.get(taskId)!.push(dep);
  }

  // DFS cycle detection
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<number, number>();
  for (const id of taskIds) color.set(id, WHITE);

  function dfs(u: number): boolean {
    color.set(u, GRAY);
    const neighbors = adj.get(u) || [];
    for (const v of neighbors) {
      if (!color.has(v)) continue;
      if (color.get(v) === GRAY) return true;
      if (color.get(v) === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  }

  return dfs(taskId);
}

/** Check if all dependencies of a task are completed */
async function allDepsCompleted(taskId: number): Promise<boolean> {
  const db = getDb();
  const deps = await db.select().from(taskDependencies).where(eq(taskDependencies.taskId, taskId));
  if (deps.length === 0) return true;

  const depIds = deps.map(d => d.dependsOnTaskId);
  const depTasks = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(inArray(tasks.id, depIds));
  return depTasks.every(t => t.status === "done");
}

/** Auto-trigger downstream tasks when their dependencies are met */
async function triggerDownstream(completedTaskId: number) {
  const db = getDb();
  // Find all tasks that depend on the completed task
  const downstream = await db
    .select({ taskId: taskDependencies.taskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.dependsOnTaskId, completedTaskId));

  for (const d of downstream) {
    if (await allDepsCompleted(d.taskId)) {
      // Check current status is pending
      const t = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, d.taskId)).then(r => r[0]);
      if (t && t.status === "pending") {
        // §3-3：下游解锁是状态变更，走转移服务递增修订号
        const unlock = await applyTaskTransition(db, { taskId: d.taskId, status: "queued", at: new Date() });
        // 2026-11-09 碧霄修复：解锁失败不再无声（下游会卡 pending 无人知）
        if (!unlock.ok) console.error(`[triggerDownstream] 下游任务 ${d.taskId} 解锁失败: ${unlock.reason}`);
      }
    }
  }
}

/** Topological sort for DAG */
function topologicalSort(deps: { taskId: number; dependsOnTaskId: number }[]): number[] {
  const nodes = new Set<number>();
  for (const d of deps) { nodes.add(d.taskId); nodes.add(d.dependsOnTaskId); }

  const adj = new Map<number, number[]>();
  const inDeg = new Map<number, number>();
  for (const n of nodes) { adj.set(n, []); inDeg.set(n, 0); }

  for (const d of deps) {
    adj.get(d.taskId)!.push(d.dependsOnTaskId);
    inDeg.set(d.dependsOnTaskId, (inDeg.get(d.dependsOnTaskId) || 0) + 1);
  }

  const queue: number[] = [];
  for (const [n, deg] of inDeg) {
    if (deg === 0) queue.push(n);
  }

  const sorted: number[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    sorted.push(u);
    for (const v of (adj.get(u) || [])) {
      inDeg.set(v, inDeg.get(v)! - 1);
      if (inDeg.get(v) === 0) queue.push(v);
    }
  }

  return sorted;
}

// ─── Router ───

const taskStatusEnum = z.enum(["pending", "queued", "running", "done", "failed"]);

export const orchestrationRouter = createRouter({
  // ─── Task CRUD with orchestration ───

  createTask: authedQuery
    .input(z.object({
      taskId: z.string().min(1).max(20),
      name: z.string().min(1).max(255),
      agentId: z.number().optional(),
      description: z.string().optional(),
      priority: z.number().min(0).max(100).optional(),
      input: z.string().optional(),
      maxRetries: z.number().min(0).max(10).optional(),
      timeoutMs: z.number().min(1000).max(3600000).optional(),
      parentTaskId: z.number().optional(),
      status: z.enum(["pending", "queued"]).optional(),
      lifecycleStatus: z.enum([
        "created", "queued", "claimed", "dispatched", "accepted", "working",
        "awaiting_result", "submitted", "reviewing", "completed", "failed", "timeout", "cancelled",
      ]).optional(),
      dependsOn: z.array(z.number()).optional(),
      requestedAgentId: z.string().min(1).max(100).optional(),
      // t2-2：幂等键。同 (origin_system='tiangong', key) 重复建单不报错，
      // 返回已存在任务（reused:true）。列与唯一索引早已存在，本次只是开放使用。
      idempotencyKey: z.string().min(1).max(191).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      // ── t2-2 执行人闸门 ────────────────────────────────────────
      // 无 agentId 又无 requestedAgentId = 通用任务 → 内建 Runner 会以
      // agent_id=NULL 抢单并必然失败（历史 #61/#62/#198），入口直接拒。
      assertDeclaredExecutor(input);

      const { dependsOn, requestedAgentId, idempotencyKey, ...taskData } = input;
      // 归属声明：requestedAgentId 是期望执行者的 agentId 字符串（如 "dsh"），
      // 写入 input metadata routing.selectedAgentId，认领侧据此阻止其他 agent 抢单。
      const routedInput = applyRequestedAgentToInput(taskData.input, requestedAgentId);
      const normalizedKey = idempotencyKey?.trim() || null;
      // ── t2-3 建单者身份 ────────────────────────────────────────
      // MCP Key / API Key 绑定的 agent（ctx.apiKeyAgentId；env-only Key 记 -1）。
      // 纯登录用户建单推导不出 agent 身份 → 留 NULL，绝不因此报错。
      const createdByAgentId =
        typeof ctx.apiKeyAgentId === "number" && ctx.apiKeyAgentId > 0 ? ctx.apiKeyAgentId : null;

      // 幂等前置查重：命中即复用，不再插入（并发竞态另由下方唯一冲突兜底）
      const existing = await findTaskByIdempotencyKey(db, normalizedKey);
      if (existing) return toReusedTaskResult(existing);

      // Cycle detection
      if (dependsOn && dependsOn.length > 0) {
        // Insert task first to get id
        try {
          await db.insert(tasks).values({
            taskId: taskData.taskId,
            name: taskData.name,
            agentId: taskData.agentId ?? null,
            description: taskData.description ?? null,
            priority: taskData.priority ?? 0,
            input: routedInput,
            status: taskData.status ?? "pending",
            lifecycleStatus: taskData.lifecycleStatus ?? "created",
            maxRetries: taskData.maxRetries ?? 3,
            timeoutMs: taskData.timeoutMs ?? 300000,
            parentTaskId: taskData.parentTaskId ?? null,
            createdByAgentId,
            originSystem: normalizedKey ? ORIGIN_SYSTEM_TIANGONG : null,
            idempotencyKey: normalizedKey,
          });
        } catch (error) {
          // 并发竞态：查重之后、插入提交之前，另一请求已用同一 key 建单。
          // 判定精确到 tasks.idempotency_key 列，无关约束错误一律照抛。
          if (!normalizedKey || !isUniqueConstraintViolation(error, { table: "tasks", columns: ["idempotency_key"] })) {
            throw error;
          }
          const raced = await findTaskByIdempotencyKey(db, normalizedKey);
          if (!raced) throw error;
          return toReusedTaskResult(raced);
        }

        const created = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.taskId, taskData.taskId)).then(r => r[0]);
        if (!created) return { success: false, error: "任务创建失败" };

        const taskId = created.id;

        if (await hasCycle(taskId, dependsOn)) {
          await db.delete(tasks).where(eq(tasks.id, taskId));
          return { success: false, error: "检测到循环依赖，已阻止" };
        }

        // Insert dependencies
        for (const dep of dependsOn) {
          await db.insert(taskDependencies).values({ taskId, dependsOnTaskId: dep });
        }

        // 通知 Dashboard
        wsManager.broadcastToDashboard({
          type: "task_update",
          action: "created",
          id: taskId,
          taskId: taskData.taskId,
          name: taskData.name,
          status: taskData.status ?? "pending",
          agentId: taskData.agentId,
          timestamp: new Date().toISOString(),
        });

        return { success: true, id: taskId, taskId: taskData.taskId, reused: false as const };
      }

      try {
        await db.insert(tasks).values({
          taskId: taskData.taskId,
          name: taskData.name,
          agentId: taskData.agentId ?? null,
          description: taskData.description ?? null,
          priority: taskData.priority ?? 0,
          input: routedInput,
          status: taskData.status ?? "pending",
          lifecycleStatus: taskData.lifecycleStatus ?? "created",
          maxRetries: taskData.maxRetries ?? 3,
          timeoutMs: taskData.timeoutMs ?? 300000,
          parentTaskId: taskData.parentTaskId ?? null,
          createdByAgentId,
          originSystem: normalizedKey ? ORIGIN_SYSTEM_TIANGONG : null,
          idempotencyKey: normalizedKey,
        });
      } catch (error) {
        if (!normalizedKey || !isUniqueConstraintViolation(error, { table: "tasks", columns: ["idempotency_key"] })) {
          throw error;
        }
        const raced = await findTaskByIdempotencyKey(db, normalizedKey);
        if (!raced) throw error;
        return toReusedTaskResult(raced);
      }

      const created = await db.select({ id: tasks.id, taskId: tasks.taskId }).from(tasks).where(eq(tasks.taskId, taskData.taskId)).then(r => r[0]);
      // 通知 Dashboard
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "created",
        id: created?.id ?? null,
        taskId: taskData.taskId,
        name: taskData.name,
        status: taskData.status ?? "pending",
        agentId: taskData.agentId,
        timestamp: new Date().toISOString(),
      });
      return { success: true, id: created?.id ?? null, taskId: created?.taskId ?? taskData.taskId, reused: false as const };
    }),

  updateStatus: authedQuery
    .input(z.object({
      id: z.number(),
      status: taskStatusEnum,
      lifecycleStatus: z.enum([
        "created", "queued", "claimed", "dispatched", "accepted", "working",
        "awaiting_result", "submitted", "reviewing", "completed", "failed", "timeout", "cancelled",
      ]).optional(),
      progress: z.number().min(0).max(100).optional(),
      output: z.string().optional(),
      error: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.id)).then(r => r[0]);
      if (!task) return { success: false, error: "任务不存在" };

      // State machine validation
      const validTransitions: Record<string, string[]> = {
        "pending": ["queued", "running", "failed"],
        "queued": ["running", "failed"],
        "running": ["done", "failed"],
        "done": [],
        "failed": ["queued"], // auto-retry
      };

      const allowed = validTransitions[task.status] || [];
      // t2-5 前置守卫（与 mcp/server.ts update_task_status 同一语义）：lifecycle 已是
      // 终态时粗粒度映射表不再放行——否则 failed→queued 走主更新路径绕开重试闸，
      // retryCount 耗尽的任务被原样重派。守卫后此类请求落进 failed→queued 分支受闸。
      if (allowed.includes(input.status) && isTerminalLifecycle(task.lifecycleStatus ?? "")) {
        allowed.length = 0;
      }
      if (!allowed.includes(input.status)) {
        // Check auto-retry: failed → queued
        if (task.status === "failed" && input.status === "queued") {
          const retryCount = task.retryCount ?? 0;
          const maxRetries = task.maxRetries ?? 3;
          if (retryCount >= maxRetries) {
            return { success: false, error: `已达最大重试次数 (${maxRetries})` };
          }
          // 终态 failed → queued 重试语义：restart 例外。
          // t2-5 修正原注释事实断言：本分支**可达**——validTransitions 只查粗粒度 status，
          // lifecycleStatus 已是终态 failed 的行走主更新会被转移服务状态机拒绝、落进本分支；
          // 上方 maxRetries 闸在 retryCount 耗尽时封死重派（结构性失败不再原样重派）。
          const retryTransition = await applyTaskTransition(db, {
            taskId: input.id,
            lifecycleStatus: "queued",
            status: "queued",
            at: new Date(),
            restart: true,
            clearLease: true,
            expectedRevision: task.stateRevision,
            extra: { retryCount: retryCount + 1, error: null },
          });
          // 2026-11-09 碧霄修复：转移失败不得静默 success
          if (!retryTransition.ok) {
            return { success: false, error: `重试转移失败: ${retryTransition.reason}` };
          }
          wsManager.broadcastToDashboard({
            type: "task_update",
            action: "updated",
            id: input.id,
            taskId: task.taskId,
            name: task.name,
            status: "queued",
            progress: input.progress,
            agentId: task.agentId,
            timestamp: new Date().toISOString(),
          });
          return { success: true, retryCount: retryCount + 1 };
        }

        return { success: false, error: `状态转移无效: ${task.status} → ${input.status}` };
      }

      // ── 执行审批闸门（2026-11-12 补齐）──
      // 此前只有 taskboard.updateStatus 过闸，而任务中心/首页走的是本节点：
      // 同一个「标记完成」动作，从任务中心提交就能绕过高风险任务的审批拦截。
      // 与 taskboard.updateStatus 的 to==="done" 分支保持同一判据。
      if (input.status === "done") {
        const gate = checkCompletionGate(task);
        if (gate.status === "blocked") {
          await parkTaskForApproval(db, task, { requiresApproval: true, riskTypes: gate.riskTypes });
          return { success: false, error: gate.reason ?? "该任务需人工审批后才能完成" };
        }
      }

      // status → boardStatus 投影（2026-11-12 补齐）。
      // task-transition.ts 的契约要求「同一行上的多个维度必须是一致投影」，此前本节点只写
      // status，看板卡停在原列：done 是终态，之后连拖拽都会被 taskboard-validator 拒，
      // 任务永久卡在中间态。这里只投影语义明确的三态，其余维度保持不动。
      const BOARD_PROJECTION: Record<string, "running" | "done" | "failed"> = {
        running: "running",
        done: "done",
        failed: "failed",
      };
      const projectedBoardStatus = BOARD_PROJECTION[input.status];

      const updates: Record<string, unknown> = { status: input.status };
      if (input.lifecycleStatus) updates.lifecycleStatus = input.lifecycleStatus;
      if (input.progress !== undefined) updates.progress = input.progress;
      if (input.output !== undefined) updates.output = input.output;
      if (input.error !== undefined) updates.error = input.error;

      // ── t2-4 两段式（第一段，任务中心/首页 updateStatus 面）──
      // 与 reportTaskProgress / MCP update_task_status 同一语义：status="done" 且未显式给
      // lifecycleStatus → 映射 submitted 等验收；不映射的话 #198 形状换这条通道照样
      // 直达 done、绕过验收。completed 只能由验收通道（a2a.review / taskboard.approve）推进。
      // 分支条件收窄到 done-only：显式 lifecycleStatus 照旧透传过状态机；failed 族走终态推导。
      const t2_4Lifecycle =
        input.status === "done" && input.lifecycleStatus === undefined && !isTerminalLifecycle(task.lifecycleStatus ?? "")
          ? ({ lifecycleStatus: "submitted" } as const)
          : {};

      // §3-3：主更新走转移服务；带 lifecycleStatus 时还接受状态机校验（消灭漂移写入），
      // 工具自身的 validTransitions 映射仍是前置契约闸门
      const transition = await applyTaskTransition(db, {
        taskId: input.id,
        status: input.status,
        ...(projectedBoardStatus ? { boardStatus: projectedBoardStatus } : {}),
        ...(input.lifecycleStatus ? { lifecycleStatus: input.lifecycleStatus } : t2_4Lifecycle),
        at: new Date(),
        expectedRevision: task.stateRevision,
        extra: {
          ...(input.progress !== undefined ? { progress: input.progress } : {}),
          ...(input.output !== undefined ? { output: input.output } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        },
      });
      // 2026-11-05 碧霄修复：转移服务校验失败原先被静默吞掉——调用方看到 success:true
      // 但 DB 未变（S2 飞书记账实测踩中：working→completed 非法转换报成功却不落库）。
      // 照 a2a-router.ts 同款 pattern 接住返回值，失败如实上报。
      if (!transition.ok) {
        const reasonText = transition.reason === "invalid_transition"
          ? `状态/生命周期转移非法: ${task.status}/${task.lifecycleStatus ?? "created"} → ${input.status}${input.lifecycleStatus ? "/" + input.lifecycleStatus : ""}`
          : transition.reason === "revision_conflict"
            ? "并发冲突：任务刚被别处修改，请重试"
            : "任务不存在（转移层）";
        return { success: false, error: reasonText };
      }

      // Auto-trigger downstream when task completes
      // t2-4 口径修订：解锁判据从 status==="done" 收紧为 **实际落库的 lifecycle 到达
      // submitted/completed**——done-only 谎报仍会随 submitted 解锁下游（行为与改造前一致）；
      // working 态下被状态机拒绝的转移不再误触发。
      if (input.status === "done" && ["submitted", "completed"].includes(transition.to.lifecycleStatus ?? "")) {
        await triggerDownstream(input.id);
      }
      if (input.status === "done" || input.status === "failed") {
        await emitCollabSummaryForTask(input.id);
      }

      // 通知 Dashboard
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "updated",
        id: input.id,
        taskId: task.taskId,
        name: task.name,
        status: input.status,
        progress: input.progress,
        agentId: task.agentId,
        timestamp: new Date().toISOString(),
      });

      return { success: true };
    }),

  getDag: publicQuery
    .input(z.object({ rootTaskId: z.number().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      let allTasks = await db.select().from(tasks).orderBy(tasks.createdAt);
      const allDeps = await db.select().from(taskDependencies);

      if (input.rootTaskId) {
        // Get subgraph reachable from root
        const visited = new Set<number>();
        const queue = [input.rootTaskId];
        while (queue.length > 0) {
          const id = queue.shift()!;
          if (visited.has(id)) continue;
          visited.add(id);
          const deps = allDeps.filter(d => d.taskId === id);
          for (const d of deps) {
            if (!visited.has(d.dependsOnTaskId)) queue.push(d.dependsOnTaskId);
          }
        }
        allTasks = allTasks.filter(t => visited.has(t.id));
      }

      const sorted = topologicalSort(allDeps);

      return {
        tasks: allTasks,
        dependencies: allDeps,
        sortedIds: sorted.length > 0 ? sorted : allTasks.map(t => t.id),
      };
    }),

  createBatch: authedQuery
    .input(z.object({
      tasks: z.array(z.object({
        taskId: z.string().min(1).max(20),
        name: z.string().min(1).max(255),
        agentId: z.number().optional(),
        description: z.string().optional(),
        priority: z.number().optional(),
        input: z.string().optional(),
        dependsOn: z.array(z.number()).optional(),
        requestedAgentId: z.string().min(1).max(100).optional(),
      })),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const results: { taskId: string; success: boolean; id?: number; error?: string }[] = [];

      for (const t of input.tasks) {
        try {
          const routedInput = applyRequestedAgentToInput(t.input, t.requestedAgentId);
          await db.insert(tasks).values({
            taskId: t.taskId,
            name: t.name,
            agentId: t.agentId ?? null,
            description: t.description ?? null,
            priority: t.priority ?? 0,
            input: routedInput,
          });
          const created = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.taskId, t.taskId)).then(r => r[0]);
          if (created && t.dependsOn && t.dependsOn.length > 0) {
            if (await hasCycle(created.id, t.dependsOn)) {
              await db.delete(tasks).where(eq(tasks.id, created.id));
              results.push({ taskId: t.taskId, success: false, error: "循环依赖" });
              continue;
            }
            for (const dep of t.dependsOn) {
              await db.insert(taskDependencies).values({ taskId: created.id, dependsOnTaskId: dep });
            }
          }
          results.push({ taskId: t.taskId, success: true, id: created?.id });
        } catch (e: any) {
          results.push({ taskId: t.taskId, success: false, error: e.message });
        }
      }

      return results;
    }),

  getOverview: publicQuery.query(async () => {
    const db = getDb();
    const allTasks = await db.select({ status: tasks.status, priority: tasks.priority }).from(tasks);
    const allAgents = await db.select({ status: agents.status }).from(agents);

    const taskStats = {
      total: allTasks.length,
      pending: allTasks.filter(t => t.status === "pending").length,
      queued: allTasks.filter(t => t.status === "queued").length,
      running: allTasks.filter(t => t.status === "running").length,
      done: allTasks.filter(t => t.status === "done").length,
      failed: allTasks.filter(t => t.status === "failed").length,
    };

    const agentStats = {
      total: allAgents.length,
      online: allAgents.filter(a => a.status === "online").length,
      busy: allAgents.filter(a => a.status === "busy").length,
      idle: allAgents.filter(a => a.status === "idle").length,
    };

    return { tasks: taskStats, agents: agentStats };
  }),

  addDependency: authedQuery
    .input(z.object({
      taskId: z.number(),
      dependsOnTaskId: z.number(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();

      // Check for self-dependency
      if (input.taskId === input.dependsOnTaskId) {
        return { success: false, error: "不能依赖自身" };
      }

      // Cycle detection
      if (await hasCycle(input.taskId, [input.dependsOnTaskId])) {
        return { success: false, error: "检测到循环依赖" };
      }

      await db.insert(taskDependencies).values({
        taskId: input.taskId,
        dependsOnTaskId: input.dependsOnTaskId,
      });
      return { success: true };
    }),

  removeDependency: authedQuery
    .input(z.object({
      taskId: z.number(),
      dependsOnTaskId: z.number(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(taskDependencies).where(
        and(
          eq(taskDependencies.taskId, input.taskId),
          eq(taskDependencies.dependsOnTaskId, input.dependsOnTaskId),
        )
      );
      return { success: true };
    }),
});
