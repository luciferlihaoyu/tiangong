import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tokenUsage } from "@db/schema";
import { eq, and, gte, lte, desc, sql, type SQL } from "drizzle-orm";

export const usageRouter = createRouter({
  /**
   * P9: 记录 token 用量
   */
  record: publicQuery
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
        startedAt: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const total = input.totalTokens ?? (input.promptTokens + input.completionTokens);

      const values: Record<string, unknown> = {
        model: input.model,
        provider: input.provider ?? "unknown",
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        totalTokens: total,
        callCount: input.callCount ?? 1,
        costCents: input.costCents ?? 0,
      };
      if (input.taskId !== undefined) values.taskId = input.taskId;
      if (input.agentId !== undefined) values.agentId = input.agentId;
      if (input.startedAt) values.startedAt = new Date(input.startedAt);

      const result = await db.insert(tokenUsage).values(values as any);
      const insertId = (result as any).insertId;

      return { id: insertId, totalTokens: total };
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
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.from) conditions.push(gte(tokenUsage.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(tokenUsage.createdAt, new Date(input.to)));
      if (input?.provider) conditions.push(eq(tokenUsage.provider, input.provider));

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          model: tokenUsage.model,
          provider: tokenUsage.provider,
          promptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          completionTokens: sql<number>`COALESCE(SUM(${tokenUsage.completionTokens}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
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
      }).optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.model) conditions.push(eq(tokenUsage.model, input.model));
      if (input?.from) conditions.push(gte(tokenUsage.createdAt, new Date(input.from)));
      if (input?.to) conditions.push(lte(tokenUsage.createdAt, new Date(input.to)));
      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const rows = await db
        .select({
          date: sql<string>`DATE(${tokenUsage.createdAt})`,
          promptTokens: sql<number>`COALESCE(SUM(${tokenUsage.promptTokens}), 0)`,
          completionTokens: sql<number>`COALESCE(SUM(${tokenUsage.completionTokens}), 0)`,
          totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
        })
        .from(tokenUsage)
        .where(whereClause)
        .groupBy(sql`DATE(${tokenUsage.createdAt})`)
        .orderBy(desc(sql`DATE(${tokenUsage.createdAt})`))
        .limit(input?.limit ?? 30);

      return rows;
    }),
});
