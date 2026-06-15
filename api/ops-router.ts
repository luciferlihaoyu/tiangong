/**
 * Phase 3: Ops 作战室 — 多 Agent 运行状态总览
 *
 * 聚合数据：
 * - Agent 在线状态 / 心跳异常
 * - 任务流统计
 * - 模型调用流
 * - 成本热力图
 */
import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents, tasks, tokenUsage } from "@db/schema";
import { eq, and, gte, lte, desc, sql, type SQL } from "drizzle-orm";

export const opsRouter = createRouter({
  /**
   * Agent 在线状态总览
   */
  agentStatus: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        id: agents.id,
        agentId: agents.agentId,
        name: agents.name,
        status: agents.status,
        model: agents.model,
        currentTask: agents.currentTask,
        lastHeartbeat: agents.lastHeartbeat,
        spentCents: agents.spentCents,
        budgetCents: agents.budgetCents,
      })
      .from(agents)
      .orderBy(agents.status);

    const now = new Date();
    const heartbeatTimeoutMs = 300_000; // 5 min

    return rows.map((a) => ({
      ...a,
      heartbeatOk:
        a.lastHeartbeat
          ? now.getTime() - new Date(a.lastHeartbeat).getTime() < heartbeatTimeoutMs
          : false,
      budgetUsed:
        a.budgetCents && a.budgetCents > 0
          ? ((a.spentCents ?? 0) / a.budgetCents) * 100
          : 0,
    }));
  }),

  /**
   * 任务流统计
   */
  taskStats: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({
        status: tasks.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(tasks)
      .groupBy(tasks.status);

    const stats: Record<string, number> = {
      queued: 0,
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
    };
    for (const r of rows) {
      stats[r.status] = r.count;
    }
    return stats;
  }),

  /**
   * 最近任务列表
   */
  recentTasks: publicQuery
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).default(10),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      return db
        .select({
          id: tasks.id,
          taskId: tasks.taskId,
          name: tasks.name,
          status: tasks.status,
          priority: tasks.priority,
          agentId: tasks.agentId,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks)
        .orderBy(desc(tasks.createdAt))
        .limit(input?.limit ?? 10);
    }),

  /**
   * 模型调用流 — 最近调用记录
   */
  recentModelCalls: publicQuery
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(50).default(20),
          highCostOnly: z.boolean().optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const conditions: SQL[] = [];
      if (input?.highCostOnly) {
        conditions.push(eq(tokenUsage.highCostModel, "true"));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      return db
        .select({
          id: tokenUsage.id,
          model: tokenUsage.model,
          provider: tokenUsage.provider,
          totalTokens: tokenUsage.totalTokens,
          costCents: tokenUsage.costCents,
          highCostModel: tokenUsage.highCostModel,
          source: tokenUsage.source,
          sessionKey: tokenUsage.sessionKey,
          traceId: tokenUsage.traceId,
          agentId: tokenUsage.agentId,
          createdAt: tokenUsage.createdAt,
        })
        .from(tokenUsage)
        .where(whereClause)
        .orderBy(desc(tokenUsage.createdAt))
        .limit(input?.limit ?? 20);
    }),

  /**
   * 成本热力图 — 按天 + 按模型
   */
  costHeatmap: publicQuery
    .input(
      z
        .object({
          days: z.number().int().min(1).max(90).default(7),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();
      const days = input?.days ?? 7;
      const since = new Date(Date.now() - days * 86400_000);

      // 按天 + 模型聚合
      const rows = await db
        .select({
          date: sql<string>`DATE(${tokenUsage.createdAt})`,
          model: tokenUsage.model,
          totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
          callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
          costCents: sql<number>`COALESCE(SUM(${tokenUsage.costCents}), 0)`,
        })
        .from(tokenUsage)
        .where(gte(tokenUsage.createdAt, since))
        .groupBy(sql`DATE(${tokenUsage.createdAt})`, tokenUsage.model)
        .orderBy(desc(sql`DATE(${tokenUsage.createdAt})`));

      // 按日期分组
      const byDate: Record<
        string,
        { totalTokens: number; callCount: number; costCents: number; models: Record<string, { tokens: number; cost: number }> }
      > = {};

      for (const r of rows) {
        if (!byDate[r.date]) {
          byDate[r.date] = { totalTokens: 0, callCount: 0, costCents: 0, models: {} };
        }
        byDate[r.date].totalTokens += r.totalTokens;
        byDate[r.date].callCount += r.callCount;
        byDate[r.date].costCents += r.costCents;
        byDate[r.date].models[r.model] = {
          tokens: r.totalTokens,
          cost: r.costCents,
        };
      }

      return {
        days: Object.entries(byDate)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, data]) => ({ date, ...data })),
        totalCostCents: rows.reduce((s, r) => s + r.costCents, 0),
        totalTokens: rows.reduce((s, r) => s + r.totalTokens, 0),
        totalCalls: rows.reduce((s, r) => s + r.callCount, 0),
      };
    }),

  /**
   * 今日概览 — 一站式摘要
   */
  todayOverview: publicQuery.query(async () => {
    const db = getDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    // Agent 统计
    const agentRows = await db
      .select({
        status: agents.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(agents)
      .groupBy(agents.status);

    const agentStats: Record<string, number> = { online: 0, busy: 0, idle: 0 };
    for (const r of agentRows) {
      agentStats[r.status] = r.count;
    }

    // 今日任务统计
    const taskRows = await db
      .select({
        status: tasks.status,
        count: sql<number>`COUNT(*)`,
      })
      .from(tasks)
      .where(gte(tasks.createdAt, today))
      .groupBy(tasks.status);

    const taskStats: Record<string, number> = { queued: 0, pending: 0, running: 0, done: 0, failed: 0 };
    for (const r of taskRows) {
      taskStats[r.status] = r.count;
    }

    // 今日用量
    const usageRows = await db
      .select({
        totalTokens: sql<number>`COALESCE(SUM(${tokenUsage.totalTokens}), 0)`,
        costCents: sql<number>`COALESCE(SUM(${tokenUsage.costCents}), 0)`,
        callCount: sql<number>`COALESCE(SUM(${tokenUsage.callCount}), 0)`,
        highCostCount: sql<number>`COALESCE(SUM(CASE WHEN ${tokenUsage.highCostModel} = 'true' THEN ${tokenUsage.callCount} ELSE 0 END), 0)`,
      })
      .from(tokenUsage)
      .where(
        and(
          gte(tokenUsage.createdAt, today),
          lte(tokenUsage.createdAt, todayEnd)
        )
      );

    const usage = usageRows[0] || { totalTokens: 0, costCents: 0, callCount: 0, highCostCount: 0 };

    return {
      agents: agentStats,
      tasks: taskStats,
      usage: {
        totalTokens: Number(usage.totalTokens),
        costCents: Number(usage.costCents),
        callCount: Number(usage.callCount),
        highCostCount: Number(usage.highCostCount),
      },
    };
  }),
});
