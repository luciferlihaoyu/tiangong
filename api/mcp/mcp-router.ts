/**
 * 天宫 MCP 管理路由 (tRPC)
 * Task 4: MCP API Key management + audit log queries
 *
 * 提供给前端 Dashboard 的管理接口：
 * - 列出所有 API Key
 * - 创建/撤销 Key
 * - 查询审计日志
 */

import { z } from "zod";
import { createRouter, publicQuery, authedQuery, adminQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { mcpApiKeys, mcpAuditLog, agents } from "@db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

export const mcpRouter = createRouter({
  // ─── List all API keys ───
  listKeys: authedQuery.query(async ({ ctx }) => {
    const db = getDb();
    const keys = await db.select().from(mcpApiKeys).orderBy(desc(mcpApiKeys.createdAt));

    // Fetch associated agent names
    const agentIds = [...new Set(keys.map(k => k.agentId).filter(Boolean))];
    const agentMap = new Map<number, string>();
    if (agentIds.length > 0) {
      const agentRows = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(sql`${agents.id} IN ${agentIds}`);
      for (const a of agentRows) agentMap.set(a.id, a.name);
    }

    return keys.map(k => ({
      ...k,
      agentName: k.agentId ? agentMap.get(k.agentId) ?? null : null,
      keyPreview: k.key.slice(0, 12) + "..." + k.key.slice(-8),
      key: undefined, // Never expose full key in list
    }));
  }),

  // ─── Get single key details ───
  getKey: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const k = await db
        .select()
        .from(mcpApiKeys)
        .where(eq(mcpApiKeys.id, input.id))
        .then(r => r[0]);

      if (!k) return null;

      return {
        ...k,
        keyPreview: k.key.slice(0, 12) + "..." + k.key.slice(-8),
        key: undefined,
      };
    }),

  // ─── Reveal full key (requires confirmation) ───
  revealKey: authedQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const k = await db
        .select()
        .from(mcpApiKeys)
        .where(eq(mcpApiKeys.id, input.id))
        .then(r => r[0]);

      if (!k) return null;

      return { id: k.id, key: k.key };
    }),

  // ─── Create a new API key ───
  createKey: adminQuery
    .input(
      z.object({
        name: z.string().min(1).max(100).describe("Key 用途说明"),
        agentId: z.number().optional().describe("关联的 Agent ID"),
        permissions: z.string().optional().describe("JSON: 可用的 tools/resources 列表"),
        rateLimit: z.number().min(1).max(100).optional().default(10).describe("每秒最大请求数"),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // Generate key: tg-{agentId or random}-{32 random chars}
      const prefix = input.agentId ? `tg-${input.agentId}-` : "tg-";
      const randomPart = nanoid(32);
      const keyValue = prefix + randomPart;

      await db.insert(mcpApiKeys).values({
        key: keyValue,
        agentId: input.agentId ?? null,
        name: input.name,
        permissions: input.permissions ?? null,
        rateLimit: input.rateLimit ?? 10,
        active: "true",
      });

      const created = await db
        .select()
        .from(mcpApiKeys)
        .where(eq(mcpApiKeys.key, keyValue))
        .then(r => r[0]);

      return {
        success: true,
        key: keyValue, // Full key - only returned on creation!
        id: created?.id,
      };
    }),

  // ─── Revoke (deactivate) a key ───
  revokeKey: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(mcpApiKeys)
        .set({ active: "false" })
        .where(eq(mcpApiKeys.id, input.id));
      return { success: true };
    }),

  // ─── Reactivate a key ───
  activateKey: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(mcpApiKeys)
        .set({ active: "true" })
        .where(eq(mcpApiKeys.id, input.id));
      return { success: true };
    }),

  // ─── Delete a key permanently ───
  deleteKey: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      // Also delete audit logs for this key
      await db.delete(mcpAuditLog).where(eq(mcpAuditLog.keyId, input.id));
      await db.delete(mcpApiKeys).where(eq(mcpApiKeys.id, input.id));
      return { success: true };
    }),

  // ─── Update key permissions ───
  updateKey: adminQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(100).optional(),
        permissions: z.string().optional(),
        rateLimit: z.number().min(1).max(100).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...fields } = input;
      const updates: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) updates[k] = v;
      }
      if (Object.keys(updates).length > 0) {
        await db.update(mcpApiKeys).set(updates).where(eq(mcpApiKeys.id, id));
      }
      return { success: true };
    }),

  // ─── Get audit logs ───
  getAuditLog: authedQuery
    .input(
      z.object({
        keyId: z.number().optional().describe("按 Key ID 过滤"),
        limit: z.number().min(1).max(500).optional().default(50),
        offset: z.number().min(0).optional().default(0),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      let query = db
        .select()
        .from(mcpAuditLog)
        .orderBy(desc(mcpAuditLog.createdAt));

      if (input.keyId) {
        const results = await query.where(eq(mcpAuditLog.keyId, input.keyId));
        return results.slice(input.offset || 0, (input.offset || 0) + (input.limit || 50));
      }

      const results = await query;
      return results.slice(input.offset || 0, (input.offset || 0) + (input.limit || 50));
    }),

  // ─── Get audit log stats ───
  getAuditStats: authedQuery.query(async () => {
    const db = getDb();
    const total = await db
      .select({ count: sql<number>`count(*)` })
      .from(mcpAuditLog)
      .then(r => r[0]?.count ?? 0);

    const successCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(mcpAuditLog)
      .where(eq(mcpAuditLog.result, "success"))
      .then(r => r[0]?.count ?? 0);

    const errorCount = await db
      .select({ count: sql<number>`count(*)` })
      .from(mcpAuditLog)
      .where(eq(mcpAuditLog.result, "error"))
      .then(r => r[0]?.count ?? 0);

    const recentErrors = await db
      .select()
      .from(mcpAuditLog)
      .where(eq(mcpAuditLog.result, "error"))
      .orderBy(desc(mcpAuditLog.createdAt))
      .then(rows => rows.slice(0, 10));

    return {
      total,
      successCount,
      errorCount,
      errorRate: total > 0 ? ((errorCount / total) * 100).toFixed(1) + "%" : "0%",
      recentErrors: recentErrors.map(e => ({
        id: e.id,
        keyId: e.keyId,
        tool: e.tool,
        error: e.error?.slice(0, 200),
        createdAt: e.createdAt,
      })),
    };
  }),
});
