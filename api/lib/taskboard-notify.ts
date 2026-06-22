import { eq, and, inArray, ne } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { tasks, taskMessages, mailboxMessages, agents } from "@db/schema";
import { wsManager } from "../ws-manager";

function stringifyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export async function sendMailboxNotification({
  fromAgentId,
  toAgentId,
  taskId,
  type,
  subject,
  body,
}: {
  fromAgentId: number | null;
  toAgentId: number;
  taskId: number;
  type: "review_request" | "result_notice";
  subject: string;
  body: string;
}) {
  const db = getDb();

  const fromAgent = fromAgentId
    ? await db.select().from(agents).where(eq(agents.id, fromAgentId)).then((r) => r[0] ?? null)
    : null;
  const toAgent = await db.select().from(agents).where(eq(agents.id, toAgentId)).then((r) => r[0] ?? null);
  if (!toAgent) return;

  const fromMailboxId = fromAgent?.agentId ?? "system";

  await db.insert(mailboxMessages).values({
    taskId,
    fromAgentId: fromAgent?.id ?? null,
    fromMailboxId,
    toAgentId: toAgent.id,
    toMailboxId: toAgent.agentId,
    type,
    status: "unread",
    subject,
    body,
  });

  wsManager.sendToAgent(toAgent.id, {
    type: "mailbox_message",
    message: {
      fromMailboxId,
      toMailboxId: toAgent.agentId,
      type,
      subject,
      body,
      taskId,
      timestamp: new Date().toISOString(),
    },
  });

  wsManager.broadcastToDashboard({
    type: "mailbox_message_sent",
    fromMailboxId,
    toMailboxId: toAgent.agentId,
    taskId,
    messageType: type,
    timestamp: new Date().toISOString(),
  });
}

export async function broadcastTaskNotification({
  taskId,
  taskName,
  fromStatus,
  toStatus,
  changedBy,
}: {
  taskId: number;
  taskName: string;
  fromStatus: string;
  toStatus: string;
  changedBy: number;
}) {
  wsManager.broadcastToDashboard({
    type: "task_notification",
    taskId,
    taskName,
    fromStatus,
    toStatus,
    changedBy,
    timestamp: new Date().toISOString(),
  });
}

export async function autoPromoteParentTask(taskId: number) {
  const db = getDb();
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((r) => r[0]);
  if (!task || !task.parentTaskId) return null;

  const parent = await db.select().from(tasks).where(eq(tasks.id, task.parentTaskId)).then((r) => r[0]);
  if (!parent) return null;

  const siblings = await db.select().from(tasks).where(eq(tasks.parentTaskId, parent.id));

  const allDone = siblings.length > 0 && siblings.every((t) => t.boardStatus === "done" || t.boardStatus === "cancelled");
  const anyFailed = siblings.some((t) => t.boardStatus === "failed");

  if (allDone && parent.boardStatus === "running") {
    await db
      .update(tasks)
      .set({
        boardStatus: "review",
        status: "running",
        reviewAt: new Date(),
      })
      .where(eq(tasks.id, parent.id));

    await db.insert(taskMessages).values({
      taskId: parent.id,
      fromAgentId: null,
      eventType: "system",
      content: "All subtasks completed. Parent task auto-promoted to review.",
      metadata: stringifyJson({ action: "auto_promote", fromStatus: "running", toStatus: "review" }),
    });

    wsManager.broadcastToDashboard({
      type: "task_update",
      action: "auto_promoted",
      id: parent.id,
      taskId: parent.taskId,
      name: parent.name,
      status: "review",
      timestamp: new Date().toISOString(),
    });

    await broadcastTaskNotification({
      taskId: parent.id,
      taskName: parent.name,
      fromStatus: "running",
      toStatus: "review",
      changedBy: 0,
    });

    return { parentId: parent.id, action: "promoted" as const };
  }

  if (anyFailed && parent.boardStatus !== "blocked" && !["done", "failed", "cancelled"].includes(parent.boardStatus || "")) {
    await db
      .update(tasks)
      .set({
        boardStatus: "blocked",
        blockedAt: new Date(),
      })
      .where(eq(tasks.id, parent.id));

    await db.insert(taskMessages).values({
      taskId: parent.id,
      fromAgentId: null,
      eventType: "system",
      content: "A subtask failed. Parent task auto-blocked.",
      metadata: stringifyJson({ action: "auto_block", fromStatus: parent.boardStatus, toStatus: "blocked" }),
    });

    wsManager.broadcastToDashboard({
      type: "task_update",
      action: "auto_blocked",
      id: parent.id,
      taskId: parent.taskId,
      name: parent.name,
      status: "blocked",
      timestamp: new Date().toISOString(),
    });

    await broadcastTaskNotification({
      taskId: parent.id,
      taskName: parent.name,
      fromStatus: parent.boardStatus || "running",
      toStatus: "blocked",
      changedBy: 0,
    });

    return { parentId: parent.id, action: "blocked" as const };
  }

  return null;
}

export async function checkAndUnblockDependencies(taskId: number) {
  const db = getDb();
  const { taskDependencies } = await import("@db/schema");

  const deps = await db
    .select()
    .from(taskDependencies)
    .where(eq(taskDependencies.dependsOnTaskId, taskId));

  for (const dep of deps) {
    const dependentTask = await db.select().from(tasks).where(eq(tasks.id, dep.taskId)).then((r) => r[0]);
    if (!dependentTask || dependentTask.boardStatus !== "blocked") continue;

    const allDeps = await db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, dep.taskId));

    const depIds = allDeps.map((d) => d.dependsOnTaskId);
    if (depIds.length === 0) continue;

    const depTasks = await db
      .select({ id: tasks.id, boardStatus: tasks.boardStatus })
      .from(tasks)
      .where(inArray(tasks.id, depIds));

    const allDepsDone = depTasks.every((t) => t.boardStatus === "done" || t.boardStatus === "cancelled");
    if (allDepsDone) {
      await db
        .update(tasks)
        .set({ boardStatus: "todo" })
        .where(eq(tasks.id, dep.taskId));

      await db.insert(taskMessages).values({
        taskId: dep.taskId,
        fromAgentId: null,
        eventType: "system",
        content: `All dependencies resolved. Task unblocked from blocked to todo.`,
        metadata: stringifyJson({ action: "auto_unblock", previousBoardStatus: "blocked", restoredBoardStatus: "todo" }),
      });

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "auto_unblocked",
        id: dep.taskId,
        taskId: dependentTask.taskId,
        name: dependentTask.name,
        status: "todo",
        timestamp: new Date().toISOString(),
      });
    }
  }
}
