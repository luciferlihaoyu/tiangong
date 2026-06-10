import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { messages, agents } from "@db/schema";
import { eq, desc, asc, sql, and, or } from "drizzle-orm";
import { wsManager } from "./ws-manager";

export const messageRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    const allMessages = await db
      .select()
      .from(messages)
      .orderBy(desc(messages.createdAt))
      .limit(100);
    return allMessages;
  }),

  listByAgent: publicQuery
    .input(z.object({ agentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select()
        .from(messages)
        .where(
          sql`${messages.fromAgent} = ${input.agentId} OR ${messages.toAgent} = ${input.agentId}`
        )
        .orderBy(desc(messages.createdAt))
        .limit(50);
    }),

  /**
   * 发送消息 — 写入数据库后，通过 WebSocket 实时推送给在线目标。
   * 推送成功后更新消息 status 为 'delivered'。
   */
  send: publicQuery
    .input(
      z.object({
        fromAgent: z.number(),
        toAgent: z.number(),
        content: z.string().min(1).max(5000),
        type: z.enum(["command", "response", "broadcast", "system"]).default("command"),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // 写入消息
      const result = await db.insert(messages).values({
        fromAgent: input.fromAgent,
        toAgent: input.toAgent,
        content: input.content,
        type: input.type,
        status: "sent",
      });

      const insertId = (result as any).insertId;

      // Increment sender's message count
      await db
        .update(agents)
        .set({ messagesCount: sql`${agents.messagesCount} + 1` })
        .where(eq(agents.id, input.fromAgent));

      // 获取刚插入的完整消息
      let fullMessage: any = null;
      if (insertId) {
        const rows = await db
          .select()
          .from(messages)
          .where(eq(messages.id, insertId));
        fullMessage = rows[0];
      }

      // WebSocket 实时推送给在线目标
      if (wsManager.isOnline(input.toAgent)) {
        try {
          await wsManager.sendToAgent(input.toAgent, {
            type: "message",
            message: fullMessage || {
              id: insertId,
              fromAgent: input.fromAgent,
              toAgent: input.toAgent,
              content: input.content,
              type: input.type,
              status: "delivered",
              createdAt: new Date().toISOString(),
            },
          });

          // 推送成功后更新状态为 delivered
          if (insertId) {
            await db
              .update(messages)
              .set({ status: "delivered" })
              .where(eq(messages.id, insertId));
          }
        } catch (e: any) {
          console.warn(`[WS] Failed to push message to Agent ${input.toAgent}:`, e.message);
        }
      }

      // 通知 Dashboard：新消息
      wsManager.broadcastToDashboard({
        type: "new_message",
        message: fullMessage || {
          id: insertId,
          fromAgent: input.fromAgent,
          toAgent: input.toAgent,
          content: input.content.slice(0, 100),
          type: input.type,
          status: wsManager.isOnline(input.toAgent) ? "delivered" : "sent",
          createdAt: new Date().toISOString(),
        },
      });

      return { success: true, messageId: insertId };
    }),

  /**
   * 标记消息已读
   * PATCH 更新 status='read' + readAt
   */
  markRead: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(messages)
        .set({ status: "read", readAt: new Date() })
        .where(eq(messages.id, input.id));

      // 获取更新后的消息
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.id, input.id));
      const updated = rows[0];

      // 通知发送方：消息已读
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
   * 查询两人双向对话记录
   * from=X&to=Y → 返回 from→to 和 to→from 的所有消息，时间正序
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
   * 广播消息给所有在线 Agent。
   * 消息存入数据库（toAgent 设为 0 表示广播），同时通过 WebSocket 推送。
   */
  broadcast: publicQuery
    .input(
      z.object({
        fromAgent: z.number(),
        content: z.string().min(1).max(5000),
        type: z.enum(["command", "response", "broadcast", "system"]).default("broadcast"),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // 写入数据库（toAgent=0 表示广播）
      const result = await db.insert(messages).values({
        fromAgent: input.fromAgent,
        toAgent: 0,
        content: input.content,
        type: input.type,
        status: "sent",
      });

      const insertId = (result as any).insertId;

      // 通过 WebSocket 广播给所有在线 Agent
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

      // 通知 Dashboard
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
        broadcastTo: onlineAgents.filter((id) => id !== input.fromAgent).length,
      };
    }),

  stats: publicQuery.query(async () => {
    const db = getDb();
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages);
    return { total: result[0]?.count ?? 0 };
  }),
});
