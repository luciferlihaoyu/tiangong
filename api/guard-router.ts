/**
 * Phase 2: 高价模型熔断 — 白名单 + 授权管理
 *
 * 职责：
 * - 检查模型调用是否被允许（白名单）
 * - 管理高价模型授权（谁、为什么、过期时间）
 * - 记录熔断事件
 */
import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { modelAllowlist, highCostModelAuth, agents, tokenUsage } from "@db/schema";
import { eq, and, gte, lte, desc, sql, or, type SQL } from "drizzle-orm";

/**
 * 高价模型判定阈值（costCents per call）
 * GPT-5.5 high 等模型 costCents >= 100 视为高价
 */
const HIGH_COST_THRESHOLD_CENTS = 100;

/** 已知高价模型列表（硬编码 + 数据库动态维护） */
const KNOWN_HIGH_COST_MODELS = [
  "4sapi/gpt-5.5-high",
  "4sapi/claude-opus-4-8",
  "zeabur-ai/gpt-5.4-pro",
  "zeabur-ai/claude-opus-4-7",
  "zeabur-ai/claude-opus-4-6",
];

export const guardRouter = createRouter({
  /**
   * 检查模型调用是否允许
   * 返回 { allowed, reason, auth }
   */
  check: publicQuery
    .input(
      z.object({
        model: z.string().min(1).max(100),
        agentId: z.number().optional(),
        costCents: z.number().int().min(0).default(0),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();
      const isHighCost =
        input.costCents >= HIGH_COST_THRESHOLD_CENTS ||
        KNOWN_HIGH_COST_MODELS.includes(input.model);

      if (!isHighCost) {
        return { allowed: true, reason: "low_cost_model", highCost: false };
      }

      // 高价模型：检查白名单
      if (input.agentId) {
        const allowlistEntry = await db
          .select()
          .from(modelAllowlist)
          .where(
            and(
              eq(modelAllowlist.agentId, input.agentId),
              eq(modelAllowlist.model, input.model)
            )
          )
          .limit(1);

        if (allowlistEntry.length > 0) {
          return {
            allowed: true,
            reason: "allowlisted",
            highCost: true,
            allowlistReason: allowlistEntry[0].reason,
          };
        }

        // 检查是否有未过期的高价模型授权
        const authEntry = await db
          .select()
          .from(highCostModelAuth)
          .where(
            and(
              eq(highCostModelAuth.agentId, input.agentId),
              eq(highCostModelAuth.model, input.model),
              eq(highCostModelAuth.active, "true"),
              or(
                sql`${highCostModelAuth.expiresAt} IS NULL`,
                gte(highCostModelAuth.expiresAt, new Date())
              )
            )
          )
          .limit(1);

        if (authEntry.length > 0) {
          return {
            allowed: true,
            reason: "authorized",
            highCost: true,
            auth: {
              authorizedBy: authEntry[0].authorizedBy,
              reason: authEntry[0].reason,
              expiresAt: authEntry[0].expiresAt,
            },
          };
        }
      }

      return {
        allowed: false,
        reason: "high_cost_not_authorized",
        highCost: true,
        message: `模型 ${input.model} 是高价模型，未授权使用。请在管理面板添加白名单或授权。`,
      };
    }),

  /**
   * 添加模型到白名单
   */
  addAllowlist: publicQuery
    .input(
      z.object({
        agentId: z.number(),
        model: z.string().min(1).max(100),
        reason: z.string().optional(),
        createdBy: z.string().max(50).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const result = await db.insert(modelAllowlist).values({
        agentId: input.agentId,
        model: input.model,
        reason: input.reason ?? null,
        createdBy: input.createdBy ?? "admin",
      } as any);
      const insertId = (result as any).insertId;
      return { id: insertId, model: input.model, agentId: input.agentId };
    }),

  /**
   * 移除白名单条目
   */
  removeAllowlist: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(modelAllowlist).where(eq(modelAllowlist.id, input.id));
      return { deleted: true };
    }),

  /**
   * 查询白名单列表
   */
  listAllowlist: publicQuery
    .input(
      z
        .object({
          agentId: z.number().optional(),
          model: z.string().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.agentId) conditions.push(eq(modelAllowlist.agentId, input.agentId));
      if (input?.model) conditions.push(eq(modelAllowlist.model, input.model));

      if (conditions.length > 0) {
        return db
          .select()
          .from(modelAllowlist)
          .where(and(...conditions))
          .orderBy(desc(modelAllowlist.createdAt));
      }
      return db
        .select()
        .from(modelAllowlist)
        .orderBy(desc(modelAllowlist.createdAt));
    }),

  /**
   * 创建高价模型授权
   */
  createAuth: publicQuery
    .input(
      z.object({
        agentId: z.number(),
        model: z.string().min(1).max(100),
        reason: z.string().min(1),
        authorizedBy: z.string().max(50),
        expiresAt: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const values: Record<string, unknown> = {
        agentId: input.agentId,
        model: input.model,
        reason: input.reason,
        authorizedBy: input.authorizedBy,
      };
      if (input.expiresAt) values.expiresAt = new Date(input.expiresAt);

      const result = await db.insert(highCostModelAuth).values(values as any);
      const insertId = (result as any).insertId;
      return { id: insertId };
    }),

  /**
   * 撤销授权
   */
  revokeAuth: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(highCostModelAuth)
        .set({ active: "false" })
        .where(eq(highCostModelAuth.id, input.id));
      return { revoked: true };
    }),

  /**
   * 查询授权列表
   */
  listAuth: publicQuery
    .input(
      z
        .object({
          agentId: z.number().optional(),
          model: z.string().optional(),
          active: z.enum(["true", "false"]).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.agentId) conditions.push(eq(highCostModelAuth.agentId, input.agentId));
      if (input?.model) conditions.push(eq(highCostModelAuth.model, input.model));
      if (input?.active) conditions.push(eq(highCostModelAuth.active, input.active));

      if (conditions.length > 0) {
        return db
          .select()
          .from(highCostModelAuth)
          .where(and(...conditions))
          .orderBy(desc(highCostModelAuth.createdAt));
      }
      return db
        .select()
        .from(highCostModelAuth)
        .orderBy(desc(highCostModelAuth.createdAt));
    }),

  /**
   * 在 record 时自动检查并标记高价模型
   * 如果未授权则拒绝记录
   */
  recordWithGuard: publicQuery
    .input(
      z.object({
        model: z.string().min(1).max(100),
        provider: z.string().max(50).optional(),
        promptTokens: z.number().int().min(0).default(0),
        completionTokens: z.number().int().min(0).default(0),
        totalTokens: z.number().int().min(0).optional(),
        callCount: z.number().int().min(1).default(1),
        costCents: z.number().int().min(0).default(0),
        taskId: z.number().optional(),
        agentId: z.number().optional(),
        sessionKey: z.string().max(128).optional(),
        source: z
          .enum(["manual", "cron", "connector", "runner", "system", "subagent"])
          .optional(),
        traceId: z.string().max(64).optional(),
        startedAt: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const total = input.totalTokens ?? (input.promptTokens + input.completionTokens);

      const isHighCost =
        input.costCents >= HIGH_COST_THRESHOLD_CENTS ||
        KNOWN_HIGH_COST_MODELS.includes(input.model);

      // P10.4: 预算检查
      if (input.agentId) {
        const agentInfo = await db
          .select({ budgetCents: agents.budgetCents, spentCents: agents.spentCents })
          .from(agents)
          .where(eq(agents.id, input.agentId))
          .limit(1)
          .then((rows) => rows[0]);

        if (agentInfo && agentInfo.budgetCents && agentInfo.budgetCents > 0) {
          const newSpent = (agentInfo.spentCents ?? 0) + input.costCents;
          if (newSpent > agentInfo.budgetCents) {
            return {
              allowed: false,
              reason: "budget_exceeded",
              message: `Agent #${input.agentId} 预算已超限：已用 $${(agentInfo.spentCents ?? 0) / 100} / 预算 $${agentInfo.budgetCents / 100}，本次调用需要 $${input.costCents / 100}`,
            };
          }
        }
      }

      // 如果是高价模型，检查授权
      if (isHighCost && input.agentId) {
        const allowlistEntry = await db
          .select()
          .from(modelAllowlist)
          .where(
            and(
              eq(modelAllowlist.agentId, input.agentId),
              eq(modelAllowlist.model, input.model)
            )
          )
          .limit(1);

        if (allowlistEntry.length === 0) {
          const authEntry = await db
            .select()
            .from(highCostModelAuth)
            .where(
              and(
                eq(highCostModelAuth.agentId, input.agentId),
                eq(highCostModelAuth.model, input.model),
                eq(highCostModelAuth.active, "true"),
                or(
                  sql`${highCostModelAuth.expiresAt} IS NULL`,
                  gte(highCostModelAuth.expiresAt, new Date())
                )
              )
            )
            .limit(1);

          if (authEntry.length === 0) {
            return {
              allowed: false,
              reason: "high_cost_not_authorized",
              message: `模型 ${input.model} 是高价模型，未授权使用。请先在管理面板添加白名单或授权。`,
            };
          }
        }
      }

      // 记录用量
      const values: Record<string, unknown> = {
        model: input.model,
        provider: input.provider ?? "unknown",
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: total,
        callCount: input.callCount ?? 1,
        costCents: input.costCents ?? 0,
        highCostModel: isHighCost ? "true" : "false",
      };
      if (input.taskId !== undefined) values.taskId = input.taskId;
      if (input.agentId !== undefined) values.agentId = input.agentId;
      if (input.sessionKey !== undefined) values.sessionKey = input.sessionKey;
      if (input.source !== undefined) values.source = input.source;
      if (input.traceId !== undefined) values.traceId = input.traceId;
      if (input.startedAt) values.startedAt = new Date(input.startedAt);

      const result = await db.insert(tokenUsage).values(values as any);
      const insertId = (result as any).insertId;

      // P10.4: 更新 Agent 已用预算
      if (input.agentId && input.costCents > 0) {
        await db
          .update(agents)
          .set({
            spentCents: sql`COALESCE(${agents.spentCents}, 0) + ${input.costCents}`,
          })
          .where(eq(agents.id, input.agentId));
      }

      return {
        allowed: true,
        id: insertId,
        totalTokens: total,
        highCost: isHighCost,
      };
    }),
});
