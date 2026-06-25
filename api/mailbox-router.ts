import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents, mailboxMessages, taskMessages, tasks } from "@db/schema";
import { and, asc, desc, eq } from "drizzle-orm";
import { wsManager } from "./ws-manager";

const mailboxTypeEnum = z.enum([
  "direct",
  "mention",
  "question",
  "review_request",
  "subtask",
  "handoff",
  "result_notice",
]);

const mailboxStatusEnum = z.enum([
  "unread",
  "acknowledged",
  "working",
  "replied",
  "resolved",
  "failed",
]);

type AgentRow = typeof agents.$inferSelect;
type MailboxMessageRow = typeof mailboxMessages.$inferSelect;
type MailboxType = typeof mailboxMessages.$inferInsert["type"];

function normalizeMailboxId(mailboxId: string) {
  return mailboxId.trim();
}

async function resolveMailbox(mailboxId: string): Promise<AgentRow> {
  const normalized = normalizeMailboxId(mailboxId);
  if (!normalized) throw new Error("Mailbox id is required");

  const db = getDb();
  const rows = await db.select().from(agents).where(eq(agents.agentId, normalized));
  if (rows.length === 0) throw new Error(`Mailbox not found: ${normalized}`);
  if (rows.length > 1) throw new Error(`Mailbox is ambiguous: ${normalized}`);
  return rows[0];
}

async function resolveOptionalSender(input: { fromMailboxId?: string; fromAgentId?: number }) {
  const db = getDb();
  if (input.fromMailboxId) {
    return resolveMailbox(input.fromMailboxId);
  }
  if (input.fromAgentId !== undefined) {
    const row = await db.select().from(agents).where(eq(agents.id, input.fromAgentId)).then((r) => r[0]);
    if (!row) throw new Error(`Sender agent not found: ${input.fromAgentId}`);
    return row;
  }
  return null;
}

async function loadMessage(messageId: number): Promise<MailboxMessageRow> {
  const db = getDb();
  const row = await db.select().from(mailboxMessages).where(eq(mailboxMessages.id, messageId)).then((r) => r[0]);
  if (!row) throw new Error("Mailbox message not found");
  return row;
}

function assertRecipient(message: MailboxMessageRow, mailboxId: string) {
  const normalized = normalizeMailboxId(mailboxId);
  if (message.toMailboxId !== normalized) {
    throw new Error("Mailbox is not the recipient of this message");
  }
}

function assertParticipant(message: MailboxMessageRow, mailboxId: string) {
  const normalized = normalizeMailboxId(mailboxId);
  if (message.toMailboxId !== normalized && message.fromMailboxId !== normalized) {
    throw new Error("Mailbox is not a participant of this message");
  }
}

async function recordMailboxEvent(input: {
  taskId?: number | null;
  threadId?: number | null;
  fromAgentId?: number | null;
  toAgentId?: number | null;
  action: string;
  mailboxMessageId: number;
  content?: string | null;
  metadata?: Record<string, unknown>;
}) {
  if (!input.taskId) return;
  const db = getDb();
  await db.insert(taskMessages).values({
    taskId: input.taskId,
    threadId: input.threadId ?? null,
    fromAgentId: input.fromAgentId ?? null,
    toAgentId: input.toAgentId ?? null,
    eventType: "system",
    content: input.content ?? `Mailbox ${input.action}`,
    metadata: JSON.stringify({
      channel: "mailbox",
      action: input.action,
      mailboxMessageId: input.mailboxMessageId,
      ...input.metadata,
    }),
  });
}

function parsePayload(payloadJson: string | null) {
  if (!payloadJson) return null;
  try {
    return JSON.parse(payloadJson);
  } catch {
    return null;
  }
}

function serializeMessage(message: MailboxMessageRow) {
  return {
    ...message,
    payload: parsePayload(message.payloadJson),
  };
}

async function createMailboxMessage(input: {
  fromAgent?: AgentRow | null;
  fromMailboxId: string;
  toAgent: AgentRow;
  type: MailboxType;
  taskId?: number | null;
  threadId?: number | null;
  subject?: string | null;
  body?: string | null;
  payload?: Record<string, unknown>;
  replyToMessageId?: number | null;
  artifactId?: number | null;
  eventAction?: string;
  eventContent?: string | null;
  eventMetadata?: Record<string, unknown>;
}) {
  const db = getDb();
  const result = await db.insert(mailboxMessages).values({
    taskId: input.taskId ?? null,
    threadId: input.threadId ?? null,
    fromAgentId: input.fromAgent?.id ?? null,
    fromMailboxId: input.fromMailboxId,
    toAgentId: input.toAgent.id,
    toMailboxId: input.toAgent.agentId,
    type: input.type,
    status: "unread",
    subject: input.subject ?? null,
    body: input.body ?? null,
    payloadJson: input.payload ? JSON.stringify(input.payload) : null,
    replyToMessageId: input.replyToMessageId ?? null,
    artifactId: input.artifactId ?? null,
  });

  let messageId = (result as any).insertId as number | undefined;
  if (!messageId) {
    const row = await db
      .select({ id: mailboxMessages.id })
      .from(mailboxMessages)
      .where(and(
        eq(mailboxMessages.toMailboxId, input.toAgent.agentId),
        eq(mailboxMessages.fromMailboxId, input.fromMailboxId),
      ))
      .orderBy(desc(mailboxMessages.createdAt))
      .limit(1)
      .then((r) => r[0]);
    messageId = row?.id;
  }
  if (!messageId) throw new Error("Mailbox message insert did not return an id");

  await recordMailboxEvent({
    taskId: input.taskId,
    threadId: input.threadId,
    fromAgentId: input.fromAgent?.id ?? null,
    toAgentId: input.toAgent.id,
    action: input.eventAction ?? "send",
    mailboxMessageId: messageId,
    content: input.eventContent ?? input.subject ?? input.body ?? `Mailbox message sent to ${input.toAgent.agentId}`,
    metadata: {
      type: input.type,
      fromMailboxId: input.fromMailboxId,
      toMailboxId: input.toAgent.agentId,
      ...input.eventMetadata,
    },
  });

  // Notify dashboard clients
  wsManager.broadcastToDashboard({
    type: "mailbox_message_sent",
    messageId,
    fromMailboxId: input.fromMailboxId,
    toMailboxId: input.toAgent.agentId,
    taskId: input.taskId ?? null,
    messageType: input.type,
    timestamp: new Date().toISOString(),
  });

  // Notify target agent via WebSocket (real-time push to connector)
  wsManager.sendToAgent(input.toAgent.id, {
    type: "mailbox_message",
    message: {
      id: messageId,
      fromMailboxId: input.fromMailboxId,
      fromAgentId: input.fromAgent?.id ?? null,
      toMailboxId: input.toAgent.agentId,
      toAgentId: input.toAgent.id,
      type: input.type,
      subject: input.subject ?? null,
      body: input.body ?? null,
      status: "unread",
      taskId: input.taskId ?? null,
      threadId: input.threadId ?? null,
      timestamp: new Date().toISOString(),
    },
  });

  return { messageId, toMailboxId: input.toAgent.agentId, toAgentId: input.toAgent.id };
}

function makeTaskKey(prefix = "TGMB") {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

export const mailboxRouter = createRouter({
  send: authedQuery
    .input(z.object({
      fromMailboxId: z.string().min(1).max(20).optional(),
      fromAgentId: z.number().optional(),
      toMailboxId: z.string().min(1).max(20),
      taskId: z.number().optional(),
      type: mailboxTypeEnum.default("direct"),
      subject: z.string().max(255).optional(),
      body: z.string().max(10000).optional(),
      payload: z.record(z.string(), z.any()).optional(),
      replyToMessageId: z.number().optional(),
      artifactId: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const toAgent = await resolveMailbox(input.toMailboxId);
      const fromAgent = await resolveOptionalSender(input);
      const fromMailboxId = fromAgent?.agentId ?? (input.fromMailboxId ? normalizeMailboxId(input.fromMailboxId) : "system");

      const created = await createMailboxMessage({
        fromAgent,
        fromMailboxId,
        toAgent,
        taskId: input.taskId ?? null,
        type: input.type,
        subject: input.subject ?? null,
        body: input.body ?? null,
        payload: input.payload,
        replyToMessageId: input.replyToMessageId ?? null,
        artifactId: input.artifactId ?? null,
      });

      return { success: true, ...created };
    }),

  mention: authedQuery
    .input(z.object({
      fromMailboxId: z.string().min(1).max(20),
      toMailboxId: z.string().min(1).max(20),
      taskId: z.number(),
      threadId: z.number().optional(),
      subject: z.string().max(255).optional(),
      body: z.string().max(10000).optional(),
      payload: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ input }) => {
      const fromAgent = await resolveMailbox(input.fromMailboxId);
      const toAgent = await resolveMailbox(input.toMailboxId);
      const db = getDb();
      const task = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");

      const created = await createMailboxMessage({
        fromAgent,
        fromMailboxId: fromAgent.agentId,
        toAgent,
        type: "mention",
        taskId: task.id,
        threadId: input.threadId ?? null,
        subject: input.subject ?? `Mention: ${fromAgent.agentId} → ${toAgent.agentId}`,
        body: input.body ?? null,
        payload: input.payload,
        eventAction: "mention",
        eventContent: input.body ?? `${fromAgent.agentId} mentioned ${toAgent.agentId}`,
      });

      return { success: true, ...created, type: "mention" };
    }),

  createSubtask: authedQuery
    .input(z.object({
      fromMailboxId: z.string().min(1).max(20),
      toMailboxId: z.string().min(1).max(20),
      parentTaskId: z.number(),
      title: z.string().min(1).max(255),
      description: z.string().max(10000).optional(),
      input: z.string().max(10000).optional(),
      priority: z.number().int().optional(),
      subject: z.string().max(255).optional(),
      body: z.string().max(10000).optional(),
      payload: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const fromAgent = await resolveMailbox(input.fromMailboxId);
      const toAgent = await resolveMailbox(input.toMailboxId);
      const parent = await db.select().from(tasks).where(eq(tasks.id, input.parentTaskId)).then((r) => r[0]);
      if (!parent) throw new Error("Parent task not found");

      const taskKey = makeTaskKey("TGST");
      await db.insert(tasks).values({
        taskId: taskKey,
        name: input.title,
        agentId: toAgent.id,
        description: input.description ?? null,
        input: input.input ?? null,
        priority: input.priority ?? 0,
        status: "queued",
        lifecycleStatus: "queued",
        parentTaskId: parent.id,
        dispatcherAgentId: fromAgent.id,
      });
      const child = await db.select().from(tasks).where(eq(tasks.taskId, taskKey)).then((r) => r[0]);
      if (!child) throw new Error("Failed to create subtask");

      await db.insert(taskMessages).values({
        taskId: parent.id,
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
        eventType: "system",
        content: input.body ?? `Subtask created for ${toAgent.agentId}: ${input.title}`,
        metadata: JSON.stringify({
          channel: "mailbox",
          action: "subtask_created",
          childTaskId: child.id,
          childTaskKey: child.taskId,
          fromMailboxId: fromAgent.agentId,
          toMailboxId: toAgent.agentId,
        }),
      });

      const created = await createMailboxMessage({
        fromAgent,
        fromMailboxId: fromAgent.agentId,
        toAgent,
        type: "subtask",
        taskId: child.id,
        subject: input.subject ?? `Subtask: ${input.title}`,
        body: input.body ?? input.description ?? null,
        payload: {
          ...(input.payload ?? {}),
          parentTaskId: parent.id,
          childTaskId: child.id,
          childTaskKey: child.taskId,
        },
        eventAction: "subtask",
        eventContent: input.body ?? `Subtask assigned to ${toAgent.agentId}: ${input.title}`,
        eventMetadata: { parentTaskId: parent.id, childTaskId: child.id, childTaskKey: child.taskId },
      });

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "created",
        id: child.id,
        taskId: child.taskId,
        name: child.name,
        status: child.status,
        agentId: child.agentId,
        parentTaskId: parent.id,
        timestamp: new Date().toISOString(),
      });

      return { success: true, taskId: child.id, taskKey: child.taskId, mailboxMessageId: created.messageId, toMailboxId: created.toMailboxId };
    }),

  handoff: authedQuery
    .input(z.object({
      fromMailboxId: z.string().min(1).max(20),
      toMailboxId: z.string().min(1).max(20),
      taskId: z.number(),
      reason: z.string().max(10000).optional(),
      subject: z.string().max(255).optional(),
      payload: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const fromAgent = await resolveMailbox(input.fromMailboxId);
      const toAgent = await resolveMailbox(input.toMailboxId);
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((r) => r[0]);
      if (!task) throw new Error("Task not found");
      if (task.agentId !== fromAgent.id) {
        throw new Error("Only the current task assignee can hand off this task");
      }
      if (["done", "failed"].includes(task.status) || ["completed", "failed", "timeout", "cancelled"].includes(task.lifecycleStatus ?? "")) {
        throw new Error("Cannot hand off a terminal task");
      }

      await db.update(tasks).set({
        agentId: toAgent.id,
        lifecycleStatus: "dispatched",
        status: "running",
        dispatcherAgentId: fromAgent.id,
        dispatchedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(tasks.id, task.id));

      const created = await createMailboxMessage({
        fromAgent,
        fromMailboxId: fromAgent.agentId,
        toAgent,
        type: "handoff",
        taskId: task.id,
        subject: input.subject ?? `Handoff: ${task.name}`,
        body: input.reason ?? null,
        payload: { ...(input.payload ?? {}), taskId: task.id, previousAgentId: fromAgent.id, nextAgentId: toAgent.id },
        eventAction: "handoff",
        eventContent: input.reason ?? `Task handed off from ${fromAgent.agentId} to ${toAgent.agentId}`,
        eventMetadata: { previousAgentId: fromAgent.id, nextAgentId: toAgent.id, lifecycleStatus: "dispatched" },
      });

      wsManager.broadcastToDashboard({
        type: "a2a_dispatch",
        taskId: task.taskId,
        taskDbId: task.id,
        targetAgentId: toAgent.id,
        targetAgentName: toAgent.name,
        lifecycleStatus: "dispatched",
        timestamp: new Date().toISOString(),
      });

      return { success: true, taskId: task.id, fromMailboxId: fromAgent.agentId, toMailboxId: toAgent.agentId, mailboxMessageId: created.messageId, lifecycleStatus: "dispatched" };
    }),

  inbox: publicQuery
    .input(z.object({
      mailboxId: z.string().min(1).max(20),
      status: mailboxStatusEnum.optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const agent = await resolveMailbox(input.mailboxId);
      const conditions = [eq(mailboxMessages.toMailboxId, agent.agentId)];
      if (input.status) conditions.push(eq(mailboxMessages.status, input.status));
      const rows = await db
        .select()
        .from(mailboxMessages)
        .where(and(...conditions))
        .orderBy(asc(mailboxMessages.createdAt))
        .limit(input.limit);
      return rows.map(serializeMessage);
    }),

  get: publicQuery
    .input(z.object({
      messageId: z.number(),
      mailboxId: z.string().min(1).max(20).optional(),
    }))
    .query(async ({ input }) => {
      const message = await loadMessage(input.messageId);
      if (input.mailboxId) assertParticipant(message, input.mailboxId);
      return serializeMessage(message);
    }),

  ack: authedQuery
    .input(z.object({
      messageId: z.number(),
      mailboxId: z.string().min(1).max(20),
      note: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await resolveMailbox(input.mailboxId);
      const message = await loadMessage(input.messageId);
      assertRecipient(message, input.mailboxId);

      if (message.status === "acknowledged" || message.status === "working" || message.status === "replied" || message.status === "resolved") {
        return { success: true, messageId: message.id, idempotent: true, status: message.status };
      }
      if (message.status === "failed") throw new Error("Cannot ack a failed mailbox message");

      await db.update(mailboxMessages).set({
        status: "acknowledged",
        acknowledgedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(mailboxMessages.id, input.messageId));

      await recordMailboxEvent({
        taskId: message.taskId,
        fromAgentId: message.toAgentId,
        toAgentId: message.fromAgentId,
        action: "ack",
        mailboxMessageId: message.id,
        content: input.note ?? `Mailbox message acknowledged by ${message.toMailboxId}`,
        metadata: { mailboxId: message.toMailboxId },
      });

      return { success: true, messageId: message.id, idempotent: false, status: "acknowledged" };
    }),

  reply: authedQuery
    .input(z.object({
      messageId: z.number(),
      fromMailboxId: z.string().min(1).max(20),
      body: z.string().max(10000).optional(),
      payload: z.record(z.string(), z.any()).optional(),
      artifactId: z.number().optional(),
      subject: z.string().max(255).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const message = await loadMessage(input.messageId);
      assertRecipient(message, input.fromMailboxId);
      const fromAgent = await resolveMailbox(input.fromMailboxId);
      const toAgent = await resolveMailbox(message.fromMailboxId);

      const result = await db.insert(mailboxMessages).values({
        taskId: message.taskId ?? null,
        fromAgentId: fromAgent.id,
        fromMailboxId: fromAgent.agentId,
        toAgentId: toAgent.id,
        toMailboxId: toAgent.agentId,
        type: "result_notice",
        status: "unread",
        subject: input.subject ?? (message.subject ? `Re: ${message.subject}` : null),
        body: input.body ?? null,
        payloadJson: input.payload ? JSON.stringify(input.payload) : null,
        replyToMessageId: message.id,
        artifactId: input.artifactId ?? null,
      });
      let replyMessageId = (result as any).insertId as number | undefined;
      if (!replyMessageId) {
        const row = await db
          .select({ id: mailboxMessages.id })
          .from(mailboxMessages)
          .where(and(
            eq(mailboxMessages.replyToMessageId, message.id),
            eq(mailboxMessages.fromMailboxId, fromAgent.agentId),
            eq(mailboxMessages.toMailboxId, toAgent.agentId),
          ))
          .orderBy(desc(mailboxMessages.createdAt))
          .limit(1)
          .then((r) => r[0]);
        replyMessageId = row?.id;
      }
      if (!replyMessageId) throw new Error("Mailbox reply insert did not return an id");

      await db.update(mailboxMessages).set({
        status: "replied",
        repliedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(mailboxMessages.id, message.id));

      await recordMailboxEvent({
        taskId: message.taskId,
        fromAgentId: fromAgent.id,
        toAgentId: toAgent.id,
        action: "reply",
        mailboxMessageId: message.id,
        content: input.subject ?? input.body ?? `Mailbox reply from ${fromAgent.agentId}`,
        metadata: { replyMessageId, fromMailboxId: fromAgent.agentId, toMailboxId: toAgent.agentId },
      });

      wsManager.broadcastToDashboard({
        type: "mailbox_message_replied",
        messageId: message.id,
        replyMessageId,
        fromMailboxId: fromAgent.agentId,
        toMailboxId: toAgent.agentId,
        taskId: message.taskId ?? null,
        timestamp: new Date().toISOString(),
      });

      // Notify original sender (toAgent) via WebSocket
      wsManager.sendToAgent(toAgent.id, {
        type: "mailbox_message",
        message: {
          id: replyMessageId,
          fromMailboxId: fromAgent.agentId,
          fromAgentId: fromAgent.id,
          toMailboxId: toAgent.agentId,
          toAgentId: toAgent.id,
          type: "result_notice",
          subject: input.subject ?? (message.subject ? `Re: ${message.subject}` : null),
          body: input.body ?? null,
          status: "unread",
          taskId: message.taskId ?? null,
          replyToMessageId: message.id,
          timestamp: new Date().toISOString(),
        },
      });

      return { success: true, messageId: message.id, replyMessageId, status: "replied" };
    }),

  resolve: authedQuery
    .input(z.object({
      messageId: z.number(),
      mailboxId: z.string().min(1).max(20),
      note: z.string().max(2000).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await resolveMailbox(input.mailboxId);
      const message = await loadMessage(input.messageId);
      assertParticipant(message, input.mailboxId);

      if (message.status === "resolved") {
        return { success: true, messageId: message.id, idempotent: true, status: "resolved" };
      }
      if (message.status === "failed") throw new Error("Cannot resolve a failed mailbox message");

      await db.update(mailboxMessages).set({
        status: "resolved",
        resolvedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(mailboxMessages.id, input.messageId));

      await recordMailboxEvent({
        taskId: message.taskId,
        fromAgentId: message.toMailboxId === input.mailboxId ? message.toAgentId : message.fromAgentId,
        toAgentId: message.toMailboxId === input.mailboxId ? message.fromAgentId : message.toAgentId,
        action: "resolve",
        mailboxMessageId: message.id,
        content: input.note ?? `Mailbox message resolved by ${input.mailboxId}`,
        metadata: { mailboxId: input.mailboxId },
      });

      return { success: true, messageId: message.id, idempotent: false, status: "resolved" };
    }),
});
