import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents, messages, taskDependencies, tasks } from "@db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { wsManager } from "./ws-manager";
import { buildCollabSummary, unblockReadyCollabTasks } from "./lib/collaboration-events";

const taskStatusEnum = z.enum(["pending", "queued", "running", "done", "failed"]);

const subtaskInput = z.object({
  title: z.string().min(1).max(255),
  description: z.string().optional(),
  assigneeAgentId: z.number(),
  priority: z.number().int().min(0).max(100).default(0),
  input: z.string().optional(),
  dependencies: z.array(z.number()).default([]),
});

type TaskRow = typeof tasks.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

type TaskStatus = z.infer<typeof taskStatusEnum>;

function makeCorrelationId(parentTaskId: number, key?: string) {
  return key || `mission-${parentTaskId}`;
}

function makeTaskId(parentTaskId: number, index: number) {
  const parentKey = parentTaskId.toString(36).toUpperCase();
  const childKey = (index + 1).toString(36).toUpperCase().padStart(2, "0");
  return `C${parentKey}-${childKey}`;
}

function makeIdempotencyKey(parentTaskId: number, index: number, title: string) {
  const normalized = title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-").slice(0, 40);
  return `collab:${parentTaskId}:${index}:${normalized}`.slice(0, 128);
}

function buildCommand(parent: TaskRow, child: TaskRow, correlationId: string) {
  return [
    `你被天宫协作编排分配了一个子任务。`,
    `协作关联: ${correlationId}`,
    `父任务: ${parent.taskId} / ${parent.name}`,
    `子任务: ${child.taskId} / ${child.name}`,
    `优先级: ${child.priority ?? 0}`,
    `说明: ${child.description || "(无)"}`,
    child.input ? `输入: ${child.input}` : null,
    `完成后请通过任务状态接口回写 done/failed、output/error。`,
  ].filter(Boolean).join("\n");
}

async function depsCompleted(dependencyIds: number[]) {
  if (dependencyIds.length === 0) return true;
  const db = getDb();
  const depRows = await db
    .select({ id: tasks.id, status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.id, dependencyIds));
  return depRows.length === dependencyIds.length && depRows.every((task) => task.status === "done");
}

async function sendDelegationMessage(input: {
  fromAgent: number;
  toAgent: number;
  parentTask: TaskRow;
  childTask: TaskRow;
  correlationId: string;
  idempotencyKey: string;
  priority: number;
}) {
  const db = getDb();
  const existing = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.fromAgent, input.fromAgent),
        eq(messages.idempotencyKey, input.idempotencyKey)
      )
    )
    .then((rows) => rows[0]);

  if (existing) {
    return { messageId: existing.id, idempotent: true };
  }

  const result = await db.insert(messages).values({
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    content: buildCommand(input.parentTask, input.childTask, input.correlationId),
    type: "command",
    status: "sent",
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
    taskId: input.childTask.id,
    priority: input.priority,
  });
  const messageId = (result as any).insertId as number | undefined;

  if (messageId && wsManager.isOnline(input.toAgent)) {
    const pushed = await db.select().from(messages).where(eq(messages.id, messageId)).then((rows) => rows[0]);
    await wsManager.sendToAgent(input.toAgent, {
      type: "message",
      message: pushed,
    });
    await db.update(messages).set({ status: "delivered", deliveredAt: new Date() }).where(eq(messages.id, messageId));
  }

  wsManager.broadcastToDashboard({
    type: "collab_delegation_message",
    parentTaskId: input.parentTask.id,
    childTaskId: input.childTask.id,
    messageId,
    toAgent: input.toAgent,
    timestamp: new Date().toISOString(),
  });

  return { messageId: messageId ?? null, idempotent: false };
}

async function getMissionRows(parentTaskId: number) {
  const db = getDb();
  const parent = await db.select().from(tasks).where(eq(tasks.id, parentTaskId)).then((rows) => rows[0]);
  if (!parent) throw new Error("Parent task not found");

  const childRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(asc(tasks.createdAt));

  const childIds = childRows.map((task) => task.id);
  const agentIds = Array.from(new Set(childRows.map((task) => task.agentId).filter((id): id is number => id !== null)));

  const messageRows = childIds.length > 0
    ? await db.select().from(messages).where(inArray(messages.taskId, childIds))
    : [];
  const dependencyRows = childIds.length > 0
    ? await db.select().from(taskDependencies).where(inArray(taskDependencies.taskId, childIds))
    : [];
  const agentRows = agentIds.length > 0
    ? await db.select().from(agents).where(inArray(agents.id, agentIds))
    : [];

  const agentById = new Map(agentRows.map((agent) => [agent.id, agent]));
  const messagesByTaskId = new Map<number, MessageRow[]>();
  for (const message of messageRows) {
    if (!message.taskId) continue;
    const group = messagesByTaskId.get(message.taskId) || [];
    group.push(message);
    messagesByTaskId.set(message.taskId, group);
  }

  const depsByTaskId = new Map<number, number[]>();
  for (const dep of dependencyRows) {
    const group = depsByTaskId.get(dep.taskId) || [];
    group.push(dep.dependsOnTaskId);
    depsByTaskId.set(dep.taskId, group);
  }

  return { parent, childRows, agentById, messagesByTaskId, depsByTaskId };
}

function statusCounts(taskRows: TaskRow[]) {
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

export const collaborationRouter = createRouter({
  delegate: publicQuery
    .input(z.object({
      parentTaskId: z.number(),
      coordinatorAgentId: z.number(),
      correlationId: z.string().max(64).optional(),
      subtasks: z.array(subtaskInput).min(1).max(50),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const parent = await db.select().from(tasks).where(eq(tasks.id, input.parentTaskId)).then((rows) => rows[0]);
      if (!parent) throw new Error("Parent task not found");

      const coordinator = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, input.coordinatorAgentId)).then((rows) => rows[0]);
      if (!coordinator) throw new Error("Coordinator agent not found");

      const assigneeIds = Array.from(new Set(input.subtasks.map((subtask) => subtask.assigneeAgentId)));
      const assignees = await db.select({ id: agents.id }).from(agents).where(inArray(agents.id, assigneeIds));
      const foundAssignees = new Set(assignees.map((agent) => agent.id));
      const missing = assigneeIds.filter((id) => !foundAssignees.has(id));
      if (missing.length > 0) throw new Error(`Assignee agent not found: ${missing.join(",")}`);

      const correlationId = makeCorrelationId(parent.id, input.correlationId);
      const results: Array<{ index: number; taskId: number; taskKey: string; messageId: number | null; idempotent: boolean; status: string }> = [];

      for (const [index, subtask] of input.subtasks.entries()) {
        const idempotencyKey = makeIdempotencyKey(parent.id, index, subtask.title);
        const taskKey = makeTaskId(parent.id, index);
        const existingMessage = await db
          .select({ taskId: messages.taskId, messageId: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.fromAgent, input.coordinatorAgentId),
              eq(messages.idempotencyKey, idempotencyKey)
            )
          )
          .then((rows) => rows[0]);

        let child = existingMessage?.taskId
          ? await db.select().from(tasks).where(eq(tasks.id, existingMessage.taskId)).then((rows) => rows[0])
          : await db.select().from(tasks).where(eq(tasks.taskId, taskKey)).then((rows) => rows[0]);

        const canQueue = await depsCompleted(subtask.dependencies);
        const status = canQueue ? "queued" : "pending";

        if (!child) {
          await db.insert(tasks).values({
            taskId: taskKey,
            name: subtask.title,
            agentId: subtask.assigneeAgentId,
            description: subtask.description ?? null,
            priority: subtask.priority,
            input: subtask.input ?? null,
            status,
            parentTaskId: parent.id,
          });
          child = await db.select().from(tasks).where(eq(tasks.taskId, taskKey)).then((rows) => rows[0]);
          if (!child) throw new Error(`Failed to create subtask ${taskKey}`);

          for (const depId of subtask.dependencies) {
            await db.insert(taskDependencies).values({ taskId: child.id, dependsOnTaskId: depId });
          }

          wsManager.broadcastToDashboard({
            type: "task_update",
            action: "created",
            id: child.id,
            taskId: child.taskId,
            name: child.name,
            status,
            agentId: child.agentId,
            parentTaskId: parent.id,
            timestamp: new Date().toISOString(),
          });
        }

        const sent = await sendDelegationMessage({
          fromAgent: input.coordinatorAgentId,
          toAgent: subtask.assigneeAgentId,
          parentTask: parent,
          childTask: child,
          correlationId,
          idempotencyKey,
          priority: subtask.priority,
        });

        results.push({
          index,
          taskId: child.id,
          taskKey: child.taskId,
          messageId: sent.messageId,
          idempotent: Boolean(existingMessage || sent.idempotent),
          status: child.status,
        });
      }

      return { success: true, parentTaskId: parent.id, correlationId, subtasks: results };
    }),

  status: publicQuery
    .input(z.object({ parentTaskId: z.number() }))
    .query(async ({ input }) => {
      const { parent, childRows, agentById, messagesByTaskId, depsByTaskId } = await getMissionRows(input.parentTaskId);
      return {
        parent,
        counts: statusCounts(childRows),
        subtasks: childRows.map((task) => {
          const taskMessages = messagesByTaskId.get(task.id) || [];
          const delegationMessage = taskMessages.find((message) => message.type === "command") || taskMessages[0] || null;
          return {
            task,
            agent: task.agentId ? agentById.get(task.agentId) ?? null : null,
            dependencies: depsByTaskId.get(task.id) || [],
            message: delegationMessage,
            messageStatus: delegationMessage?.status ?? null,
            ackedAt: delegationMessage?.ackedAt ?? null,
            deliveredAt: delegationMessage?.deliveredAt ?? null,
          };
        }),
      };
    }),

  summary: publicQuery
    .input(z.object({ parentTaskId: z.number() }))
    .query(async ({ input }) => buildCollabSummary(input.parentTaskId)),

  unblockReady: publicQuery
    .input(z.object({ parentTaskId: z.number() }))
    .mutation(async ({ input }) => {
      const changed = await unblockReadyCollabTasks(input.parentTaskId);

      return { success: true, queuedTaskIds: changed.map((task) => task.id) };
    }),
});
