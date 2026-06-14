import { agents, messages, taskDependencies, tasks } from "@db/schema";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { wsManager } from "../ws-manager";

type TaskRow = typeof tasks.$inferSelect;
type TaskStatus = "pending" | "queued" | "running" | "done" | "failed";

function countStatuses(taskRows: TaskRow[]) {
  const counts: Record<TaskStatus, number> = {
    pending: 0,
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
  };
  for (const task of taskRows) counts[task.status as TaskStatus] += 1;
  return counts;
}

async function dependencyIdsForTask(taskId: number) {
  const db = getDb();
  const deps = await db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.taskId, taskId));
  return deps.map((dep) => dep.dependsOnTaskId);
}

async function areDependenciesDone(taskIds: number[]) {
  if (taskIds.length === 0) return true;
  const db = getDb();
  const depTasks = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.id, taskIds));
  return depTasks.length === taskIds.length && depTasks.every((task) => task.status === "done");
}

export async function unblockReadyCollabTasks(parentTaskId: number) {
  const db = getDb();
  const childRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId));
  const changed: TaskRow[] = [];

  for (const child of childRows) {
    if (child.status !== "pending") continue;
    const depIds = await dependencyIdsForTask(child.id);
    if (await areDependenciesDone(depIds)) {
      await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, child.id));
      changed.push({ ...child, status: "queued" });
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "updated",
        id: child.id,
        taskId: child.taskId,
        name: child.name,
        status: "queued",
        progress: child.progress,
        agentId: child.agentId,
        parentTaskId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  if (changed.length > 0) {
    wsManager.broadcastToDashboard({
      type: "collab_unblocked",
      parentTaskId,
      taskIds: changed.map((task) => task.id),
      timestamp: new Date().toISOString(),
    });
  }

  return changed;
}

export async function buildCollabSummary(parentTaskId: number) {
  const db = getDb();
  const parent = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, parentTaskId))
    .then((rows) => rows[0]);
  if (!parent) throw new Error("Parent task not found");

  const childRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId));
  const childIds = childRows.map((task) => task.id);
  const agentIds = Array.from(new Set(childRows.map((task) => task.agentId).filter((id): id is number => id !== null)));
  const messageRows = childIds.length > 0
    ? await db.select().from(messages).where(inArray(messages.taskId, childIds))
    : [];
  const agentRows = agentIds.length > 0
    ? await db.select().from(agents).where(inArray(agents.id, agentIds))
    : [];

  const agentById = new Map(agentRows.map((agent) => [agent.id, agent]));
  const counts = countStatuses(childRows);
  const total = childRows.length;
  const terminal = counts.done + counts.failed;
  const overallStatus = total === 0
    ? "empty"
    : counts.failed > 0
      ? "failed"
      : terminal === total
        ? "done"
        : "running";

  return {
    parentTaskId: parent.id,
    parentTaskKey: parent.taskId,
    name: parent.name,
    overallStatus,
    counts,
    total,
    completed: terminal,
    outputs: childRows
      .filter((task) => task.output)
      .map((task) => ({
        taskId: task.id,
        taskKey: task.taskId,
        agent: task.agentId ? agentById.get(task.agentId)?.name ?? null : null,
        output: task.output,
      })),
    errors: childRows
      .filter((task) => task.error || task.status === "failed")
      .map((task) => ({
        taskId: task.id,
        taskKey: task.taskId,
        agent: task.agentId ? agentById.get(task.agentId)?.name ?? null : null,
        error: task.error,
      })),
    messageCounts: messageRows.reduce((acc, message) => {
      acc[message.status] = (acc[message.status] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };
}

export async function emitCollabSummaryForTask(taskId: number) {
  const db = getDb();
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((rows) => rows[0]);
  if (!task?.parentTaskId) return null;

  const unblocked = await unblockReadyCollabTasks(task.parentTaskId);
  const summary = await buildCollabSummary(task.parentTaskId);

  wsManager.broadcastToDashboard({
    type: "collab_summary",
    parentTaskId: task.parentTaskId,
    completedTaskId: task.id,
    unblockedTaskIds: unblocked.map((item) => item.id),
    summary,
    timestamp: new Date().toISOString(),
  });

  return summary;
}
