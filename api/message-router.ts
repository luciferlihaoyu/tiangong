import { z } from "zod";
import { createRouter, publicQuery, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { messages, agents } from "@db/schema";
import { eq, desc, asc, sql, and, or, isNull, lt, gte, type SQL } from "drizzle-orm";
import { wsManager } from "./ws-manager";

export const messageRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    return db
      .select()
      .from(messages)
      .orderBy(desc(messages.createdAt))
      .limit(100);
  }),

  listByAgent: publicQuery
    .input(z.object({ agentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(messages)
        .where(
          or(
            eq(messages.fromAgent, input.agentId),
            eq(messages.toAgent, input.agentId)
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(50);
    }),

  /**
   * P8.1: 发送消息 — 幂等 + 可靠协作字段
   *
   * 支持 idempotencyKey: 同 fromAgent + idempotencyKey 返回已有 messageId。
   * 支持 correlationId, taskId, parentMessageId, priority, expiresAt。
   * 写入数据库后，通过 WebSocket 推送给在线目标，更新 deliveredAt/status。
   */
  send: authedQuery
    .input(
      z.object({
        fromAgent: z.number(),
        toAgent: z.number(),
        content: z.string().min(1).max(5000),
        type: z
          .enum(["command", "response", "broadcast", "system", "ack"])
          .default("command"),
        conversationId: z.number().optional(),
        // P8.1 new fields
        correlationId: z.string().max(64).optional(),
        idempotencyKey: z.string().max(128).optional(),
        taskId: z.number().optional(),
        parentMessageId: z.number().optional(),
        priority: z.number().int().min(0).default(0),
        expiresAt: z.string().optional(), // ISO timestamp
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // ── 幂等检查 ──
      if (input.idempotencyKey) {
        const existing = await db
          .select({ id: messages.id, messageId: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.fromAgent, input.fromAgent),
              eq(messages.idempotencyKey, input.idempotencyKey)
            )
          )
          .then((r) => r[0]);

        if (existing) {
          return {
            success: true,
            messageId: existing.messageId,
            idempotent: true,
          };
        }
      }

      // ── 构造插入值 ──
      const values: Record<string, unknown> = {
        fromAgent: input.fromAgent,
        toAgent: input.toAgent,
        content: input.content,
        type: input.type,
        status: "sent",
        priority: input.priority,
      };

      if (input.conversationId !== undefined)
        values.conversationId = input.conversationId;
      if (input.correlationId) values.correlationId = input.correlationId;
      if (input.idempotencyKey)
        values.idempotencyKey = input.idempotencyKey;
      if (input.taskId) values.taskId = input.taskId;
      if (input.parentMessageId)
        values.parentMessageId = input.parentMessageId;
      if (input.expiresAt) values.expiresAt = new Date(input.expiresAt);

      const result = await db.insert(messages).values(values as any);
      const insertId = (result as any).insertId;

      // Increment sender's message count
      await db
        .update(agents)
        .set({ messagesCount: sql`${agents.messagesCount} + 1` })
        .where(eq(agents.id, input.fromAgent));

      // ── 获取完整消息 ──
      let fullMessage: any = null;
      if (insertId) {
        const rows = await db
          .select()
          .from(messages)
          .where(eq(messages.id, insertId));
        fullMessage = rows[0];
      }

      // ── WebSocket 推送 ──
      if (wsManager.isOnline(input.toAgent)) {
        try {
          const pushPayload = fullMessage
            ? serializeMessage(fullMessage)
            : defaultMessagePayload(input, insertId);
          await wsManager.sendToAgent(input.toAgent, {
            type: "message",
            message: pushPayload,
          });

          // 更新 deliveredAt 和状态
          if (insertId) {
            await db
              .update(messages)
              .set({ status: "delivered", deliveredAt: new Date() })
              .where(eq(messages.id, insertId));
            if (fullMessage) {
              fullMessage.status = "delivered";
              fullMessage.deliveredAt = new Date();
            }
          }
        } catch (e: any) {
          console.warn(
            `[WS] Failed to push message to Agent ${input.toAgent}:`,
            e.message
          );
        }
      }

      // ── 通知 Dashboard ──
      wsManager.broadcastToDashboard({
        type: "new_message",
        message: fullMessage
          ? serializeMessage(fullMessage)
          : defaultMessagePayload(input, insertId),
      });

      return {
        success: true,
        messageId: insertId,
        idempotent: false,
      };
    }),

  /**
   * P8.1: Inbox — 获取待处理消息列表
   *
   * 返回未过期、未 ACK、未 read 的消息（status = sent 或 delivered），
   * 按 priority 降序、createdAt 升序排列。
   */
  inbox: publicQuery
    .input(
      z.object({
        agentId: z.number(),
        limit: z.number().int().min(1).max(200).default(50),
        /** 是否返回已超时的已确认消息 */
        includeAcked: z.boolean().default(false),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: ReturnType<typeof eq>[] = [
        eq(messages.toAgent, input.agentId),
      ];
      const andConditions: SQL[] = [...conditions];

      if (!input.includeAcked) {
        // 未 ack、未 read、未 expired
        const statusCond = or(
          eq(messages.status, "sent"),
          eq(messages.status, "delivered")
        );
        if (statusCond) andConditions.push(statusCond);

        // 过滤已过期消息
        const now = new Date();
        const expireCond = or(
          isNull(messages.expiresAt),
          gte(messages.expiresAt, now)
        );
        if (expireCond) andConditions.push(expireCond);
      }

      return db
        .select()
        .from(messages)
        .where(and(...andConditions))
        .orderBy(desc(messages.priority), asc(messages.createdAt))
        .limit(input.limit);
    }),

  /**
   * P8.1: ACK 消息 — 幂等确认
   *
   * 接收方确认收到/处理一条消息。幂等：重复 ACK 同一消息返回相同结果。
   * 更新 status='acked' 并设置 ackedAt。
   */
  ack: authedQuery
    .input(
      z.object({
        messageId: z.number(),
        agentId: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // ── 检查消息是否存在 ──
      const existing = await db
        .select()
        .from(messages)
        .where(eq(messages.id, input.messageId))
        .then((r) => r[0]);

      if (!existing) {
        throw new Error("Message not found");
      }

      if (input.agentId !== undefined && existing.toAgent !== input.agentId) {
        throw new Error("Agent is not the recipient of this message");
      }

      // ── 幂等：已 ack 直接返回 ──
      if (existing.status === "acked") {
        return {
          success: true,
          messageId: existing.id,
          idempotent: true,
          ackedAt: existing.ackedAt,
          status: existing.status,
        };
      }

      if (existing.status === "expired") {
        return {
          success: false,
          messageId: existing.id,
          error: "Message already expired",
          status: existing.status,
        };
      }

      // ── 标记已确认 ──
      const now = new Date();
      await db
        .update(messages)
        .set({ status: "acked", ackedAt: now })
        .where(eq(messages.id, input.messageId));

      // 通知 Dashboard
      wsManager.broadcastToDashboard({
        type: "message_acked",
        messageId: input.messageId,
        agentId: input.agentId,
        timestamp: now.toISOString(),
      });

      // 通知发送方
      if (existing.fromAgent && wsManager.isOnline(existing.fromAgent)) {
        try {
          wsManager.sendToAgent(existing.fromAgent, {
            type: "message_acked",
            messageId: existing.id,
            ackedBy: input.agentId ?? existing.toAgent,
            timestamp: now.toISOString(),
          });
        } catch {}
      }

      return {
        success: true,
        messageId: existing.id,
        idempotent: false,
        ackedAt: now,
        status: "acked" as const,
      };
    }),

  /**
   * P8.1: 标记消息已读
   * PATCH 更新 status='read' + readAt
   */
  markRead: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(messages)
        .set({ status: "read", readAt: new Date() })
        .where(eq(messages.id, input.id));

      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.id, input.id));
      const updated = rows[0];

      if (updated) {
        wsManager.broadcastToDashboard({
          type: "message_read",
          messageId: input.id,
          fromAgent: updated.fromAgent,
          toAgent: updated.toAgent,
          readAt: updated.readAt,
        });
      }

      return { success: true, message: updated };
    }),

  /**
   * P8.1: Replay/Undelivered — 获取未投递消息并触发重推
   *
   * 返回状态为 'sent'（未推送）且未过期的消息。可选择性触发重推。
   * 用于离线 Agent 上线时补偿投递。
   */
  replayUndelivered: authedQuery
    .input(
      z.object({
        agentId: z.number(),
        limit: z.number().int().min(1).max(200).default(100),
        /** 是否立即重推（仅当 Agent 在线时有效） */
        triggerReplay: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = new Date();

      const undelivered = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.toAgent, input.agentId),
            eq(messages.status, "sent"),
            or(
              isNull(messages.expiresAt),
              gte(messages.expiresAt, now)
            )
          )
        )
        .orderBy(desc(messages.priority), asc(messages.createdAt))
        .limit(input.limit);

      let replayed = 0;
      let expiredDuringReplay = 0;

      if (input.triggerReplay && undelivered.length > 0) {
        if (wsManager.isOnline(input.agentId)) {
          for (const msg of undelivered) {
            try {
              await wsManager.sendToAgent(input.agentId, {
                type: "message",
                message: serializeMessage(msg),
              });
              await db
                .update(messages)
                .set({
                  status: "delivered",
                  deliveredAt: new Date(),
                  retryCount: sql`${messages.retryCount} + 1` as any,
                })
                .where(eq(messages.id, msg.id));
              replayed++;
            } catch {
              // 推送失败，增加重试计数
              await db
                .update(messages)
                .set({
                  retryCount: sql`${messages.retryCount} + 1` as any,
                })
                .where(eq(messages.id, msg.id));
            }
          }
        }

        // 处理已过期的消息
        const expired = undelivered.filter(
          (m) => m.expiresAt && new Date(m.expiresAt) < now
        );
        if (expired.length > 0) {
          await db
            .update(messages)
            .set({ status: "expired" })
            .where(
              and(
                eq(messages.toAgent, input.agentId),
                eq(messages.status, "sent"),
                lt(messages.expiresAt, now)
              )
            );
          expiredDuringReplay = expired.length;
        }
      }

      return {
        undelivered: undelivered.map(serializeMessage),
        count: undelivered.length,
        replayed,
        expiredDuringReplay,
      };
    }),

  /**
   * 查询两人双向对话记录
   */
  conversation: publicQuery
    .input(z.object({ from: z.number(), to: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(messages)
        .where(
          or(
            and(
              eq(messages.fromAgent, input.from),
              eq(messages.toAgent, input.to)
            ),
            and(
              eq(messages.fromAgent, input.to),
              eq(messages.toAgent, input.from)
            )
          )
        )
        .orderBy(asc(messages.createdAt))
        .limit(200);
    }),

  /**
   * 广播消息给所有在线 Agent
   */
  broadcast: adminQuery
    .input(
      z.object({
        fromAgent: z.number(),
        content: z.string().min(1).max(5000),
        type: z
          .enum(["command", "response", "broadcast", "system", "ack"])
          .default("broadcast"),
        correlationId: z.string().max(64).optional(),
        priority: z.number().int().min(0).default(0),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      const values: Record<string, unknown> = {
        fromAgent: input.fromAgent,
        toAgent: 0,
        content: input.content,
        type: input.type,
        status: "sent",
        priority: input.priority,
      };
      if (input.correlationId) values.correlationId = input.correlationId;

      const result = await db.insert(messages).values(values as any);
      const insertId = (result as any).insertId;

      const onlineAgents = wsManager.getOnlineAgents();
      const broadcastPayload = {
        type: "broadcast",
        message: {
          id: insertId,
          fromAgent: input.fromAgent,
          content: input.content,
          type: input.type,
          createdAt: new Date().toISOString(),
        },
      };

      for (const agentId of onlineAgents) {
        if (agentId !== input.fromAgent) {
          try {
            await wsManager.sendToAgent(agentId, broadcastPayload);
          } catch {}
        }
      }

      wsManager.broadcastToDashboard({
        type: "broadcast",
        messageId: insertId,
        fromAgent: input.fromAgent,
        content: input.content.slice(0, 100),
        broadcastTo: onlineAgents.length,
      });

      return {
        success: true,
        messageId: insertId,
        broadcastTo: onlineAgents.filter(
          (id) => id !== input.fromAgent
        ).length,
      };
    }),

  stats: publicQuery.query(async () => {
    const db = getDb();
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages);

    // P8.1: 分组统计
    const byStatus = await db
      .select({
        status: messages.status,
        count: sql<number>`count(*)`,
      })
      .from(messages)
      .groupBy(messages.status);

    return {
      total: result[0]?.count ?? 0,
      byStatus: byStatus.reduce(
        (acc: Record<string, number>, s) => {
          acc[s.status] = s.count;
          return acc;
        },
        {} as Record<string, number>
      ),
    };
  }),

  /**
   * 通知飞书 — 队列化通知，由 Connector 或 cron 负责实际发送
   */
  notifyFeishu: authedQuery
    .input(z.object({
      agentName: z.string(),
      subject: z.string(),
      body: z.string(),
      urgency: z.enum(["info", "warning", "critical"]).default("info"),
    }))
    .mutation(async ({ input }) => {
      // 1. 记录通知日志到控制台（可扩展为写入数据库）
      console.log(`[notifyFeishu] ${input.urgency.toUpperCase()} | Agent: ${input.agentName} | ${input.subject}`);

      // 2. 通过 WebSocket 广播到 Dashboard，触发前端 toast 提示
      wsManager.broadcastToDashboard({
        type: "feishu_notification",
        agentName: input.agentName,
        subject: input.subject,
        body: input.body,
        urgency: input.urgency,
        timestamp: new Date().toISOString(),
      });

      // 3. 返回成功，实际飞书发送由 Connector 或 OpenClaw cron 处理
      return { success: true, message: "Notification queued" };
    }),
});

// ── 辅助 ──

/**
 * 序列化消息（将 Date 字段转成 ISO 字符串），以便 JSON 传输。
 */
function serializeMessage(msg: any): any {
  return {
    ...msg,
    createdAt: msg.createdAt instanceof Date ? msg.createdAt.toISOString() : msg.createdAt,
    readAt: msg.readAt instanceof Date ? msg.readAt.toISOString() : msg.readAt,
    ackedAt: msg.ackedAt instanceof Date ? msg.ackedAt.toISOString() : msg.ackedAt,
    deliveredAt: msg.deliveredAt instanceof Date ? msg.deliveredAt.toISOString() : msg.deliveredAt,
    expiresAt: msg.expiresAt instanceof Date ? msg.expiresAt.toISOString() : msg.expiresAt,
  };
}

/**
 * 当无法从 DB 查询完整消息时，构造默认消息 payload。
 */
function defaultMessagePayload(input: any, insertId: number): any {
  return {
    id: insertId,
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    content: input.content,
    type: input.type,
    status: "delivered",
    createdAt: new Date().toISOString(),
  };
}
