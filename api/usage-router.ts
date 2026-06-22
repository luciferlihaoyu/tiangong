import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tokenUsage, agents } from "@db/schema";
import { eq, and, gte, lte, desc, sql, type SQL } from "drizzle-orm";
import { getModelPricing, calculateCost, buildTokenUsageValues } from "./lib/model-pricing";

export const usageRouter = createRouter({
  /**
   * P9 + P13: 记录 token 用量（自动计算真实费用）
   */
  record: publicQuery
    .input(
      z.object({
        model: z.string().min(1).max(100),
        provider: z.string().max(50).optional(),
        promptTokens: z.number().int().min(0).default(0),
        completionTokens: z.number().int().min(0).default(0),
        totalTokens: z.number().int().min(0).optional(),
        // P13: cache split
        cachedPromptTokens: z.number().int().min(0).default(0),
        uncachedPromptTokens: z.number().int().min(0).default(0),
        callCount: z.number().int().min(1).default(1),
        costCents: z.number().int().min(0).optional(), // legacy override
        taskId: z.number().optional(),
        agentId: z.number().optional(),
        // Phase 1: 审计增强字段
        sessionKey: z.string().max(128).optional(),
        source: z.enum(["manual", "cron", "connector", "runner", "system", "subagent"]).optional(),
        traceId: z.string().max(64).optional(),
        startedAt: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const total = input.totalTokens ?? (input.promptTokens + input.completionTokens);

      // P13: compute real cost from pricing table
      const pricing = await getModelPricing(input.model);
      const costResult = calculateCost(
        pricing,
        input.cachedPromptTokens ?? 0,
        input.uncachedPromptTokens ?? 0,
        input.completionTokens ?? 0
      );

      // Allow legacy override if explicitly provided
      const finalCostCents = input.costCents !== undefined && input.costCents > 0
        ? input.costCents
        : costResult.costCents;

      const values = buildTokenUsageValues(
        {
          model: input.model,
          provider: input.provider,
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens,
          totalTokens: total,
          cachedPromptTokens: input.cachedPromptTokens,
          uncachedPromptTokens: input.uncachedPromptTokens,
          callCount: input.callCount,
          taskId: input.taskId,
          agentId: input.agentId,
          sessionKey: input.sessionKey,
          source: input.source,
          traceId: input.traceId,
          startedAt: input.startedAt,
        },
        { ...costResult, costCents: finalCostCents }
      );

      const result = await db.insert(tokenUsage).values(values as any);
      const insertId = (result as any).insertId;

      return { id: insertId, totalTokens: total, costCents: finalCostCents };
    }),

  /**
   * P9: 用量记录列表（按时间倒序）
   */
  list: publicQuery
    .input(
      z.object({
        model: z.string().optional(),
        provider: z.string().optional(),
        agentId: z.number().optional(),
        // Phase 1: 审计增强筛选
        sessionKey: z.string().max(128).optional(),
        source: z.string().max(20).optional(),
        traceId: z.string().max(64).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];

      if (input?.model) conditions.push(eq(tokenUsage.model, input.model));
      if (input?.provider) conditions.push(eq(tokenUsage.provider, input.provider));
      if (input?.agentId) conditions.push(eq(tokenUsage.agentId, input.agentId));
      if (input?.sessionKey) conditions.push(eq(tokenUsage.sessionKey, input.sessionKey));
      if (input?.source) conditions.push(eq(tokenUsage.source, input.source));
      if (input?.traceId) conditions.push(eq(tokenUsage.traceId, input.traceId));
      if (input?.from) conditions.push(gte(tokenUsage.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(tokenUsage.createdAt, new Date(input.to)));

      if (conditions.length > 0) {
        return db
          .select()
          .from(tokenUsage)
          .where(and(...conditions))
          .orderBy(desc(tokenUsage.createdAt))
          .limit(input?.limit ?? 100);
      }

      return db
        .select()
        .from(tokenUsage)
        .orderBy(desc(tokenUsage.createdAt))
        .limit(input?.limit ?? 100);
    }),

  /**
   * P9: 按模型聚合统计
   */
  byModel: publicQuery
    .input(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        provider: z.string().optional(),
        source: z.string().max(20).optional(),
        agentId: z.number().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.from) conditions.push(gte(tokenUsage.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(tokenUsage.createdAt, new Date(input.to)));
      if (input?.provider) conditions.push(eq(tokenUsage.provider, input.provider));
      if (input?.source) conditions.push(eq(tokenUsage.source, input.source));
      if (input?.agentId) conditions.push(eq(tokenUsage.agentId, input.agentId));

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          model: tokenUsage.model,
          provider: tokenUsage.provider,
          promptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          completionTokens: sql<number>`COALESCE(SUM(${tokenUsage.completionTokens}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
          cachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.cachedPromptTokens}), 0)`,
          uncachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.uncachedPromptTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
          costCents: sql<number>`COALESCE(SUM(${tokenUsage.costCents}), 0)`,
        })
        .from(tokenUsage)
        .where(whereClause)
        .groupBy(tokenUsage.model, tokenUsage.provider)
        .orderBy(desc(sql`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`));

      return rows;
    }),

  /**
   * P9: 按日聚合统计
   */
  byDay: publicQuery
    .input(
      z.object({
        model: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(365).default(30),
        agentId: z.number().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.model) conditions.push(eq(tokenUsage.model, input.model));
      if (input?.from) conditions.push(gte(tokenUsage.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(tokenUsage.createdAt, new Date(input.to)));
      if (input?.agentId) conditions.push(eq(tokenUsage.agentId, input.agentId));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          date: sql<string>`DATE(${tokenUsage.createdAt})`,
          promptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          completionTokens: sql<number>`COALESCE(SUM(${tokenUsage.completionTokens}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
          cachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.cachedPromptTokens}), 0)`,
          uncachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.uncachedPromptTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
          costCents: sql<number>`COALESCE(SUM(${tokenUsage.costCents}), 0)`,
        })
        .from(tokenUsage)
        .where(whereClause)
        .groupBy(sql`DATE(${tokenUsage.createdAt})`)
        .orderBy(desc(sql`DATE(${tokenUsage.createdAt})`))
        .limit(input?.limit ?? 30);

      return rows;
    }),

  /**
   * Phase 1: 按来源聚合统计
   */
  bySource: publicQuery
    .input(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        agentId: z.number().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.from) conditions.push(gte(tokenUsage.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(tokenUsage.createdAt, new Date(input.to)));
      if (input?.agentId) conditions.push(eq(tokenUsage.agentId, input.agentId));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          source: tokenUsage.source,
          promptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          completionTokens: sql<number>`COALESCE(SUM(${tokenUsage.completionTokens}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
          cachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.cachedPromptTokens}), 0)`,
          uncachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.uncachedPromptTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
          costCents: sql<number>`COALESCE(SUM(${tokenUsage.costCents}), 0)`,
        })
        .from(tokenUsage)
        .where(whereClause)
        .groupBy(tokenUsage.source)
        .orderBy(desc(sql`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`));

      return rows;
    }),

  /**
   * P13: 按 Agent 聚合统计
   */
  byAgent: publicQuery
    .input(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        model: z.string().optional(),
        source: z.string().max(20).optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.from) conditions.push(gte(tokenUsage.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(tokenUsage.createdAt, new Date(input.to)));
      if (input?.model) conditions.push(eq(tokenUsage.model, input.model));
      if (input?.source) conditions.push(eq(tokenUsage.source, input.source));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          agentId: tokenUsage.agentId,
          agentName: agents.name,
          promptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          completionTokens: sql<number>`COALESCE(SUM(${tokenUsage.completionTokens}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
          cachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.cachedPromptTokens}), 0)`,
          uncachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.uncachedPromptTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
          costCents: sql<number>`COALESCE(SUM(${tokenUsage.costCents}), 0)`,
        })
        .from(tokenUsage)
        .leftJoin(agents, eq(tokenUsage.agentId, agents.id))
        .where(whereClause)
        .groupBy(tokenUsage.agentId, agents.name)
        .orderBy(desc(sql`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`));

      return rows;
    }),

  /**
   * P13: 按 Agent × Model 交叉统计
   */
  byAgentAndModel: publicQuery
    .input(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        agentId: z.number().optional(),
        model: z.string().optional(),
        source: z.string().max(20).optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.from) conditions.push(gte(tokenUsage.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(tokenUsage.createdAt, new Date(input.to)));
      if (input?.agentId) conditions.push(eq(tokenUsage.agentId, input.agentId));
      if (input?.model) conditions.push(eq(tokenUsage.model, input.model));
      if (input?.source) conditions.push(eq(tokenUsage.source, input.source));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          agentId: tokenUsage.agentId,
          agentName: agents.name,
          model: tokenUsage.model,
          provider: tokenUsage.provider,
          promptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          completionTokens: sql<number>`COALESCE(SUM(${tokenUsage.completionTokens}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
          cachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.cachedPromptTokens}), 0)`,
          uncachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.uncachedPromptTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
          costCents: sql<number>`COALESCE(SUM(${tokenUsage.costCents}), 0)`,
        })
        .from(tokenUsage)
        .leftJoin(agents, eq(tokenUsage.agentId, agents.id))
        .where(whereClause)
        .groupBy(tokenUsage.agentId, agents.name, tokenUsage.model, tokenUsage.provider)
        .orderBy(desc(sql`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`));

      return rows;
    }),

  /**
   * P13: 缓存命中率统计
   */
  cacheStats: publicQuery
    .input(
      z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        agentId: z.number().optional(),
        model: z.string().optional(),
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.from) conditions.push(gte(tokenUsage.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(tokenUsage.createdAt, new Date(input.to)));
      if (input?.agentId) conditions.push(eq(tokenUsage.agentId, input.agentId));
      if (input?.model) conditions.push(eq(tokenUsage.model, input.model));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      // Overall stats
      const overall = await db
        .select({
          totalPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          cachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.cachedPromptTokens}), 0)`,
          uncachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.uncachedPromptTokens}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
          costCents: sql<number>`COALESCE(SUM(${tokenUsage.costCents}), 0)`,
        })
        .from(tokenUsage)
        .where(whereClause);

      // By model
      const byModel = await db
        .select({
          model: tokenUsage.model,
          cachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.cachedPromptTokens}), 0)`,
          uncachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.uncachedPromptTokens}), 0)`,
          totalPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
          costCents: sql<number>`COALESCE(SUM(${tokenUsage.costCents}), 0)`,
        })
        .from(tokenUsage)
        .where(whereClause)
        .groupBy(tokenUsage.model)
        .orderBy(desc(sql`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`));

      // By agent
      const byAgent = await db
        .select({
          agentId: tokenUsage.agentId,
          agentName: agents.name,
          cachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.cachedPromptTokens}), 0)`,
          uncachedPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.uncachedPromptTokens}), 0)`,
          totalPromptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
        })
        .from(tokenUsage)
        .leftJoin(agents, eq(tokenUsage.agentId, agents.id))
        .where(whereClause)
        .groupBy(tokenUsage.agentId, agents.name)
        .orderBy(desc(sql`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`));

      const o = overall[0] ?? { totalPromptTokens: 0, cachedPromptTokens: 0, uncachedPromptTokens: 0, totalTokens: 0, callCount: 0, costCents: 0 };
      const cacheHitRate = o.totalPromptTokens > 0
        ? (o.cachedPromptTokens / o.totalPromptTokens) * 100
        : 0;

      return {
        overall: {
          ...o,
          cacheHitRate: Number(cacheHitRate.toFixed(2)),
        },
        byModel,
        byAgent,
      };
    }),
});
