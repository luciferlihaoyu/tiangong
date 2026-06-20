import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents, mailboxMessages, taskMessages } from "@db/schema";
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

export const mailboxRouter = createRouter({
  send: publicQuery
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

      const result = await db.insert(mailboxMessages).values({
        taskId: input.taskId ?? null,
        fromAgentId: fromAgent?.id ?? null,
        fromMailboxId,
        toAgentId: toAgent.id,
        toMailboxId: toAgent.agentId,
        type: input.type,
        status: "unread",
        subject: input.subject ?? null,
        body: input.body ?? null,
        payloadJson: input.payload ? JSON.stringify(input.payload) : null,
        replyToMessageId: input.replyToMessageId ?? null,
        artifactId: input.artifactId ?? null,
      });
      const messageId = (result as any).insertId as number;

      await recordMailboxEvent({
        taskId: input.taskId,
        fromAgentId: fromAgent?.id ?? null,
        toAgentId: toAgent.id,
        action: "send",
        mailboxMessageId: messageId,
        content: input.subject ?? input.body ?? `Mailbox message sent to ${toAgent.agentId}`,
        metadata: { type: input.type, fromMailboxId, toMailboxId: toAgent.agentId },
      });

      wsManager.broadcastToDashboard({
        type: "mailbox_message_sent",
        messageId,
        fromMailboxId,
        toMailboxId: toAgent.agentId,
        taskId: input.taskId ?? null,
        messageType: input.type,
        timestamp: new Date().toISOString(),
      });

      return { success: true, messageId, toMailboxId: toAgent.agentId, toAgentId: toAgent.id };
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

  ack: publicQuery
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

  reply: publicQuery
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
      const replyMessageId = (result as any).insertId as number;

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

      return { success: true, messageId: message.id, replyMessageId, status: "replied" };
    }),

  resolve: publicQuery
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
