import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, taskDependencies } from "@db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { wsManager } from "./ws-manager";

// ─── Helpers ───

/** Build the DAG subgraph (connected component) for a given root taskId */
async function getDagSubgraph(rootTaskId: number): Promise<{
  taskMap: Map<number, typeof tasks.$inferSelect>;
  deps: Array<{ taskId: number; dependsOnTaskId: number }>;
}> {
  const db = getDb();

  const rootTask = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, rootTaskId))
    .then((r) => r[0]);

  if (!rootTask) {
    return { taskMap: new Map(), deps: [] };
  }

  // Load all dependencies and tasks once for in-memory BFS
  const allDeps = await db.select().from(taskDependencies);
  const allTasks = await db.select().from(tasks);

  const visited = new Set<number>([rootTaskId]);

  // Include parent and siblings via parentTaskId
  if (rootTask.parentTaskId) {
    visited.add(rootTask.parentTaskId);
    for (const t of allTasks) {
      if (t.parentTaskId === rootTask.parentTaskId) {
        visited.add(t.id);
      }
    }
  }

  // Include direct children
  for (const t of allTasks) {
    if (t.parentTaskId === rootTaskId) {
      visited.add(t.id);
    }
  }

  // Bidirectional BFS through taskDependencies
  const queue = Array.from(visited);
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const d of allDeps) {
      if (d.taskId === id && !visited.has(d.dependsOnTaskId)) {
        visited.add(d.dependsOnTaskId);
        queue.push(d.dependsOnTaskId);
      }
      if (d.dependsOnTaskId === id && !visited.has(d.taskId)) {
        visited.add(d.taskId);
        queue.push(d.taskId);
      }
    }
  }

  const taskMap = new Map(
    allTasks.filter((t) => visited.has(t.id)).map((t) => [t.id, t])
  );
  const relevantDeps = allDeps.filter(
    (d) => visited.has(d.taskId) && visited.has(d.dependsOnTaskId)
  );

  return { taskMap, deps: relevantDeps };
}

/** Topological sort for execution: dependencies come before dependents */
function topologicalSort(
  deps: Array<{ taskId: number; dependsOnTaskId: number }>,
  taskIds: number[]
): number[] {
  const taskIdSet = new Set(taskIds);
  const adj = new Map<number, number[]>(); // dependency -> dependents
  const inDeg = new Map<number, number>();

  for (const id of taskIds) {
    adj.set(id, []);
    inDeg.set(id, 0);
  }

  for (const d of deps) {
    if (!taskIdSet.has(d.taskId) || !taskIdSet.has(d.dependsOnTaskId)) continue;
    // Edge: dependsOnTaskId -> taskId (dependency points to dependent)
    adj.get(d.dependsOnTaskId)!.push(d.taskId);
    inDeg.set(d.taskId, (inDeg.get(d.taskId) || 0) + 1);
  }

  const queue: number[] = [];
  for (const [n, deg] of inDeg) {
    if (deg === 0) queue.push(n);
  }

  const sorted: number[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    sorted.push(u);
    for (const v of adj.get(u) || []) {
      inDeg.set(v, inDeg.get(v)! - 1);
      if (inDeg.get(v) === 0) queue.push(v);
    }
  }

  return sorted;
}

/** Dispatch a single task (mirrors taskRouter.dispatch logic) */
async function dispatchSingleTask(taskId: number): Promise<boolean> {
  const db = getDb();
  const now = new Date();

  const row = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .then((r) => r[0]);
  if (!row) return false;
  if (row.status !== "pending") return false;

  // Concurrency check: skip if agent already running a task
  if (row.agentId) {
    const runningTasks = await db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.agentId, row.agentId),
          eq(tasks.status, "running")
        )
      )
      .limit(1);
    if (runningTasks.length > 0) {
      return false;
    }
  }

  await db
    .update(tasks)
    .set({
      status: "queued",
      lifecycleStatus: "dispatched",
      dispatchedAt: now,
    })
    .where(eq(tasks.id, taskId));

  wsManager.broadcastToDashboard({
    type: "task_update",
    action: "dispatched",
    id: taskId,
    taskId: row.taskId,
    name: row.name,
    status: "queued",
    agentId: row.agentId,
    timestamp: now.toISOString(),
  });

  return true;
}

// ─── Router ───

export const dagRouter = createRouter({
  /** Get the full DAG: all tasks + dependency edges */
  getGraph: publicQuery.query(async () => {
    const db = getDb();
    const allTasks = await db.select().from(tasks).orderBy(tasks.createdAt);
    const allDeps = await db.select().from(taskDependencies);

    return {
      nodes: allTasks,
      edges: allDeps.map((d) => ({
        from: d.dependsOnTaskId,
        to: d.taskId,
      })),
    };
  }),

  /** Run a DAG: topologically sort and dispatch tasks in dependency order */
  runDag: authedQuery
    .input(z.object({ taskId: z.number() }))
    .mutation(async ({ input }) => {
      const { taskMap, deps } = await getDagSubgraph(input.taskId);
      const taskIds = Array.from(taskMap.keys());
      const order = topologicalSort(deps, taskIds);

      const dispatched: number[] = [];

      for (const tid of order) {
        const task = taskMap.get(tid);
        if (!task || task.status !== "pending") continue;

        // Check if all dependencies in this subgraph are completed
        const taskDeps = deps.filter((d) => d.taskId === tid);
        const allDepsDone = taskDeps.every((d) => {
          const depTask = taskMap.get(d.dependsOnTaskId);
          return depTask?.status === "done";
        });

        if (allDepsDone) {
          const ok = await dispatchSingleTask(tid);
          if (ok) dispatched.push(tid);
        }
      }

      return { order, dispatched };
    }),

  /** Query DAG execution status for a given root task */
  status: publicQuery
    .input(z.object({ taskId: z.number() }))
    .query(async ({ input }) => {
      const { taskMap } = await getDagSubgraph(input.taskId);
      const taskList = Array.from(taskMap.values());

      const total = taskList.length;
      const completed = taskList.filter((t) => t.status === "done").length;
      const failed = taskList.filter((t) => t.status === "failed").length;
      const queued = taskList.filter((t) => t.status === "queued").length;
      const running = taskList.filter((t) => t.status === "running").length;
      const pending = taskList.filter((t) => t.status === "pending").length;

      return {
        taskId: input.taskId,
        total,
        completed,
        failed,
        queued,
        running,
        pending,
        tasks: taskList.map((t) => ({
          id: t.id,
          taskId: t.taskId,
          name: t.name,
          status: t.status,
          progress: t.progress,
          agentId: t.agentId,
          parentTaskId: t.parentTaskId,
          lifecycleStatus: t.lifecycleStatus,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        })),
      };
    }),
});
