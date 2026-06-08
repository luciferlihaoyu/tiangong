import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, taskDependencies, agents } from "@db/schema";
import { eq, and, inArray, sql, desc } from "drizzle-orm";

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
        await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, d.taskId));
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

  createTask: publicQuery
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
      dependsOn: z.array(z.number()).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { dependsOn, ...taskData } = input;

      // Cycle detection
      if (dependsOn && dependsOn.length > 0) {
        // Insert task first to get id
        const result = await db.insert(tasks).values({
          taskId: taskData.taskId,
          name: taskData.name,
          agentId: taskData.agentId ?? null,
          description: taskData.description ?? null,
          priority: taskData.priority ?? 0,
          input: taskData.input ?? null,
          maxRetries: taskData.maxRetries ?? 3,
          timeoutMs: taskData.timeoutMs ?? 300000,
          parentTaskId: taskData.parentTaskId ?? null,
        });

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

        return { success: true, id: taskId };
      }

      await db.insert(tasks).values({
        taskId: taskData.taskId,
        name: taskData.name,
        agentId: taskData.agentId ?? null,
        description: taskData.description ?? null,
        priority: taskData.priority ?? 0,
        input: taskData.input ?? null,
        maxRetries: taskData.maxRetries ?? 3,
        timeoutMs: taskData.timeoutMs ?? 300000,
        parentTaskId: taskData.parentTaskId ?? null,
      });

      const created = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.taskId, taskData.taskId)).then(r => r[0]);
      return { success: true, id: created?.id ?? null };
    }),

  updateStatus: publicQuery
    .input(z.object({
      id: z.number(),
      status: taskStatusEnum,
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
      if (!allowed.includes(input.status)) {
        // Check auto-retry: failed → queued
        if (task.status === "failed" && input.status === "queued") {
          if (task.retryCount >= task.maxRetries) {
            return { success: false, error: `已达最大重试次数 (${task.maxRetries})` };
          }
          await db.update(tasks).set({
            status: "queued",
            retryCount: task.retryCount + 1,
            error: null,
          }).where(eq(tasks.id, input.id));
          return { success: true, retryCount: task.retryCount + 1 };
        }

        return { success: false, error: `状态转移无效: ${task.status} → ${input.status}` };
      }

      const updates: Record<string, unknown> = { status: input.status };
      if (input.progress !== undefined) updates.progress = input.progress;
      if (input.output !== undefined) updates.output = input.output;
      if (input.error !== undefined) updates.error = input.error;

      await db.update(tasks).set(updates).where(eq(tasks.id, input.id));

      // Auto-trigger downstream when task completes
      if (input.status === "done") {
        await triggerDownstream(input.id);
      }

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

  createBatch: publicQuery
    .input(z.object({
      tasks: z.array(z.object({
        taskId: z.string().min(1).max(20),
        name: z.string().min(1).max(255),
        agentId: z.number().optional(),
        description: z.string().optional(),
        priority: z.number().optional(),
        input: z.string().optional(),
        dependsOn: z.array(z.number()).optional(),
      })),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const results: { taskId: string; success: boolean; id?: number; error?: string }[] = [];

      for (const t of input.tasks) {
        try {
          await db.insert(tasks).values({
            taskId: t.taskId,
            name: t.name,
            agentId: t.agentId ?? null,
            description: t.description ?? null,
            priority: t.priority ?? 0,
            input: t.input ?? null,
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

  addDependency: publicQuery
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

  removeDependency: publicQuery
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
