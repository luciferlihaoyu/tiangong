import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents, tasks, modelAllowlist, taskMessages, tokenUsage, notifications, type Agent, type AgentCard } from "@db/schema";
import { eq, like, and, or, sql, desc, isNull, lt } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { MySqlRawQueryResult } from "drizzle-orm/mysql2";
import { claimNextTask } from "./lib/task-claim";

type AgentNode = Agent & { children: AgentNode[] };
type AgentCapability = AgentCard["capabilities"][number];
type InsertResult = MySqlRawQueryResult | { readonly insertId?: number };

function getInsertId(result: InsertResult): number {
  return Array.isArray(result) ? result[0].insertId : result.insertId ?? 0;
}

/** update 返回的受影响行数（兼容 mysql2 数组形状与测试 mock 的普通对象形状） */
function getAffectedRows(result: unknown): number {
  const value = Array.isArray(result) ? result[0] : result;
  if (value === null || typeof value !== "object") return 0;
  return Number((value as { affectedRows?: number }).affectedRows ?? 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeCapabilityItem(item: unknown): AgentCapability {
  if (typeof item === "string") {
    return { category: "general", items: [item], level: "intermediate" };
  }
  if (!isRecord(item)) {
    return { category: "general", items: [], level: "intermediate" };
  }
  const rawItems = item.items;
  const items = Array.isArray(rawItems)
    ? rawItems.filter((entry): entry is string => typeof entry === "string")
    : typeof rawItems === "string"
      ? [rawItems]
      : [];
  return {
    category: typeof item.category === "string" ? item.category : "general",
    items,
    level: isCapabilityLevel(item.level) ? item.level : "intermediate",
  };
}

function isCapabilityLevel(value: unknown): value is AgentCapability["level"] {
  return value === "expert" || value === "advanced" || value === "intermediate" || value === "beginner";
}

/**
 * 认领决策（findClaimableTask / isBudgetExhausted / claimNextTask）已抽到
 * api/lib/task-claim.ts（单一事实源，MCP claim_task 工具与 tRPC 面共用）。
 */

export const agentRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(agents).orderBy(agents.updatedAt);
  }),

  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(agents).where(eq(agents.id, input.id));
      return rows[0] ?? null;
    }),

  getBySource: publicQuery
    .input(z.object({ source: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(agents).where(like(agents.source, `%${input.source}%`));
    }),

  create: authedQuery
    .input(
      z.object({
        agentId: z.string().min(1).max(20),
        name: z.string().min(1).max(50),
        system: z.string().min(1).max(30),
        description: z.string().optional(),
        source: z.string().max(50).optional(),
        model: z.string().max(100).optional(),
        role: z.string().max(100).optional(),
        capabilities: z.string().optional(),
        orgId: z.number().optional(),
        departmentId: z.number().optional(),
        reportsTo: z.number().optional(),
        sourceApiKey: z.string().max(255).optional(),
        sourceEndpoint: z.string().max(500).optional(),
        // A2A-lite v0.1
        agentCard: z.record(z.string(), z.unknown()).optional(),
        openclawAgent: z.string().max(100).optional(),
        canModifyTiangongCore: z.boolean().optional(),
        canSendExternalMessage: z.boolean().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const result = await db.insert(agents).values({
        agentId: input.agentId,
        name: input.name,
        system: input.system,
        status: "idle",
        description: input.description ?? null,
        source: input.source ?? "custom",
        model: input.model ?? null,
        role: input.role ?? null,
        capabilities: input.capabilities ?? null,
        orgId: input.orgId ?? null,
        departmentId: input.departmentId ?? null,
        reportsTo: input.reportsTo ?? null,
        sourceApiKey: input.sourceApiKey ?? null,
        sourceEndpoint: input.sourceEndpoint ?? null,
        agentCard: input.agentCard ? JSON.stringify(input.agentCard) : null,
        openclawAgent: input.openclawAgent ?? null,
        canModifyTiangongCore: input.canModifyTiangongCore ? "true" : "false",
        canSendExternalMessage: input.canSendExternalMessage ? "true" : "false",
      });
      const insertId = getInsertId(result);

      // P10.3: 自动同步模型白名单
      if (input.model && insertId) {
        const existing = await db
          .select({ id: modelAllowlist.id })
          .from(modelAllowlist)
          .where(
            and(
              eq(modelAllowlist.agentId, insertId),
              eq(modelAllowlist.model, input.model)
            )
          )
          .limit(1);

        if (existing.length === 0) {
          await db.insert(modelAllowlist).values({
            agentId: insertId,
            model: input.model,
            reason: `自动同步: Agent ${input.name} 注册时默认模型`,
            createdBy: "system",
          });
        }
      }

      return { success: true, id: insertId };
    }),

  update: authedQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(50).optional(),
        system: z.string().min(1).max(30).optional(),
        status: z.enum(["online", "busy", "idle"]).optional(),
        task: z.string().max(255).optional(),
        progress: z.number().min(0).max(100).optional(),
        description: z.string().optional(),
        source: z.string().max(50).optional(),
        model: z.string().max(100).optional(),
        role: z.string().max(100).optional(),
        manages: z.string().optional(),
        reportsTo: z.number().optional(),
        orgId: z.number().optional(),
        departmentId: z.number().optional(),
        currentTask: z.string().optional(),
        capabilities: z.string().optional(),
        budgetCents: z.number().optional(),
        spentCents: z.number().optional(),
        sourceApiKey: z.string().max(255).optional(),
        sourceEndpoint: z.string().max(500).optional(),
        // A2A-lite v0.1
        agentCard: z.record(z.string(), z.unknown()).optional(),
        openclawAgent: z.string().max(100).optional(),
        canModifyTiangongCore: z.boolean().optional(),
        canSendExternalMessage: z.boolean().optional(),
        mcpToken: z.string().max(100).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...fields } = input;
      const updateFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) updateFields[k] = v;
      }
      // Normalize agentCard JSON
      if (input.agentCard !== undefined) updateFields.agentCard = JSON.stringify(input.agentCard);
      if (input.canModifyTiangongCore !== undefined) updateFields.canModifyTiangongCore = input.canModifyTiangongCore ? "true" : "false";
      if (input.canSendExternalMessage !== undefined) updateFields.canSendExternalMessage = input.canSendExternalMessage ? "true" : "false";
      if (Object.keys(updateFields).length > 0) {
        await db.update(agents).set(updateFields).where(eq(agents.id, id));
      }

      // P10.3: 模型变更时自动同步白名单
      if (input.model) {
        const existing = await db
          .select({ id: modelAllowlist.id })
          .from(modelAllowlist)
          .where(
            and(
              eq(modelAllowlist.agentId, id),
              eq(modelAllowlist.model, input.model)
            )
          )
          .limit(1);

        if (existing.length === 0) {
          await db.insert(modelAllowlist).values({
            agentId: id,
            model: input.model,
            reason: `自动同步: Agent ${input.name || id} 更新时模型变更`,
            createdBy: "system",
          });
        }
      }

      return { success: true };
    }),

  updateStatus: authedQuery
    .input(
      z.object({
        id: z.number(),
        status: z.enum(["online", "busy", "idle"]),
        task: z.string().optional(),
        progress: z.number().min(0).max(100).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(agents)
        .set({
          status: input.status,
          task: input.task ?? null,
          progress: input.progress ?? 0,
        })
        .where(eq(agents.id, input.id));
      return { success: true };
    }),

  /**
   * 任务认领 — 查找可认领的 queued 任务并认领（仅限 connector / MCP Key）
   */
  claimTask: publicQuery
    .input(z.object({ agentId: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.apiKeyAgentId === null) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "任务认领需要有效的 MCP Key" });
      }
      if (ctx.apiKeyAgentId > 0 && ctx.apiKeyAgentId !== input.agentId) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Key 与目标 Agent 不匹配" });
      }

      const db = getDb();

      // 认领序列（查 agent → 预算熔断 → 审批闸门选任务 → 置 running/claimed → busy）
      // 走共享 lib api/lib/task-claim.ts（与 MCP claim_task 工具同一事实源）
      const result = await claimNextTask(db, input.agentId);
      if (result.reason === "agent_not_found") {
        throw new Error("Agent not found");
      }
      return result;
    }),

  updateHeartbeat: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.apiKeyAgentId === null) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "心跳更新需要有效的 MCP Key" });
      }
      if (ctx.apiKeyAgentId > 0 && ctx.apiKeyAgentId !== input.id) {
        throw new TRPCError({ code: "FORBIDDEN", message: "Key 与目标 Agent 不匹配" });
      }

      const db = getDb();

      // 1. 更新心跳
      await db
        .update(agents)
        .set({ lastHeartbeat: new Date(), status: "online" })
        .where(eq(agents.id, input.id));

      // 2. 检查是否有 queued 任务可认领（认领序列走共享 lib api/lib/task-claim.ts，
      //    与 claimTask / MCP claim_task 同一事实源；agent 不存在时安静返回无任务）
      const result = await claimNextTask(db, input.id);

      const claimedTask: { id: number; taskId: string; name: string; approvalRequired: boolean } | null = result.task
        ? {
            id: result.task.id,
            taskId: result.task.taskId,
            name: result.task.name,
            approvalRequired: result.task.approvalRequired,
          }
        : null;
      const claimReason: "budget_exhausted" | null = result.reason === "budget_exhausted" ? "budget_exhausted" : null;

      // claimReason 为新增的向后兼容字段（不耗尽预算时为 null；dsh-poller 只看 claimedTask）
      return { success: true, claimedTask, claimReason };
    }),

  getHierarchy: publicQuery.query(async () => {
    const db = getDb();
    const allAgents = await db.select().from(agents);

    // Build a tree from orgId/departmentId/reportsTo
    const byId = new Map(allAgents.map((a): [number, AgentNode] => [a.id, { ...a, children: [] }]));
    const roots: AgentNode[] = [];

    for (const a of allAgents) {
      if (a.reportsTo && byId.has(a.reportsTo)) {
        const parent = byId.get(a.reportsTo);
        const child = byId.get(a.id);
        if (parent && child) parent.children.push(child);
      } else {
        const root = byId.get(a.id);
        if (root) roots.push(root);
      }
    }

    return { roots, agents: allAgents };
  }),

  delete: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(agents).where(eq(agents.id, input.id));
      return { success: true };
    }),

  card: publicQuery
    .input(z.object({ agentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(agents).where(eq(agents.id, input.agentId));
      const agent = rows[0];
      if (!agent) return null;

      // Parse existing agentCard
      if (agent.agentCard) {
        try {
          const parsed = JSON.parse(agent.agentCard) as AgentCard;
          return parsed;
        } catch {
          // Fall through to default generation
        }
      }

      // Auto-generate default AgentCard from existing fields
      const capItems: string[] = [];
      if (agent.capabilities) {
        try {
          const parsedCap = JSON.parse(agent.capabilities);
          if (Array.isArray(parsedCap)) capItems.push(...parsedCap);
          else capItems.push(agent.capabilities);
        } catch {
          capItems.push(...agent.capabilities.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
        }
      }

      const defaultCard: AgentCard = {
        capabilities: [
          {
            category: agent.role || "general",
            items: capItems.length > 0 ? capItems : ["general"],
            level: "intermediate",
          },
        ],
        permissions: {
          canModifyTiangongCore: agent.canModifyTiangongCore === "true",
          canSendExternalMessage: agent.canSendExternalMessage === "true",
          canExecuteCode: false,
          canAccessFiles: false,
          canAccessNetwork: false,
        },
        collaboration: {
          supportsTaskExecution: true,
          supportsReview: false,
          supportsSubtask: false,
          supportsHandoff: false,
        },
        openclaw: agent.openclawAgent
          ? {
              agentId: agent.openclawAgent,
              sessionKey: "",
              model: agent.model || "",
              runtime: "acp",
            }
          : null,
      };

      return defaultCard;
    }),

  updateCard: authedQuery
    .input(
      z.object({
        agentId: z.number(),
        card: z.record(z.string(), z.unknown()),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(agents)
        .set({ agentCard: JSON.stringify(input.card) })
        .where(eq(agents.id, input.agentId));
      return { success: true };
    }),

  getCapabilities: publicQuery
    .input(z.object({ agentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(agents).where(eq(agents.id, input.agentId));
      const agent = rows[0];
      if (!agent) return null;

      let capabilities: AgentCapability[] = [];

      // 优先从 agentCard 解析
      if (agent.agentCard) {
        try {
          const card = JSON.parse(agent.agentCard) as AgentCard;
          if (card.capabilities && Array.isArray(card.capabilities)) {
            capabilities = card.capabilities.map((cap) => ({
              category: cap.category,
              items: cap.items,
              level: cap.level,
            }));
          }
        } catch {
          // fall through
        }
      }

      // 如果从 agentCard 没解析出来，尝试从 capabilities 字段
      if (capabilities.length === 0 && agent.capabilities) {
        try {
          const parsed: unknown = JSON.parse(agent.capabilities);
          if (Array.isArray(parsed)) {
            capabilities = parsed.map(normalizeCapabilityItem);
          } else {
            capabilities = [{
              category: "general",
              items: typeof parsed === "string" ? [parsed] : [],
              level: "intermediate",
            }];
          }
        } catch {
          const capItems = agent.capabilities.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
          if (capItems.length > 0) {
            capabilities = [{
              category: "general",
              items: capItems,
              level: "intermediate",
            }];
          }
        }
      }

      if (capabilities.length === 0) {
        capabilities = [{
          category: agent.role || "general",
          items: ["general"],
          level: "intermediate",
        }];
      }

      return {
        agentId: agent.id,
        agentName: agent.name,
        capabilities,
      };
    }),

  getRuntimeStats: publicQuery
    .input(z.object({ agentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();

      // 从 agents 表获取基本信息
      const agentRows = await db.select().from(agents).where(eq(agents.id, input.agentId));
      const agent = agentRows[0];
      if (!agent) return null;

      // 从 tokenUsage 表查询统计
      const tokenUsageRows = await db
        .select({
          totalCalls: sql<number>`SUM(${tokenUsage.callCount})`,
          totalTokens: sql<number>`SUM(${tokenUsage.totalTokens})`,
          totalCostCents: sql<number>`SUM(${tokenUsage.costCents})`,
        })
        .from(tokenUsage)
        .where(eq(tokenUsage.agentId, input.agentId));

      const tokenStats = tokenUsageRows[0] ?? { totalCalls: 0, totalTokens: 0, totalCostCents: 0 };

      // 从 taskMessages 表查询：统计 dispatch/result/error 事件
      const taskMessagesRows = await db
        .select({
          eventType: taskMessages.eventType,
          count: sql<number>`COUNT(*)`,
        })
        .from(taskMessages)
        .where(
          or(
            eq(taskMessages.fromAgentId, input.agentId),
            eq(taskMessages.toAgentId, input.agentId)
          )
        )
        .groupBy(taskMessages.eventType);

      const taskStats = {
        completed: 0,
        failed: 0,
        dispatched: 0,
        error: 0,
      };
      for (const row of taskMessagesRows) {
        if (row.eventType === "result") taskStats.completed += Number(row.count) || 0;
        if (row.eventType === "error") taskStats.failed += Number(row.count) || 0;
        if (row.eventType === "dispatch") taskStats.dispatched += Number(row.count) || 0;
        if (row.eventType === "timeout") taskStats.error += Number(row.count) || 0;
      }

      // 从 tasks 表查询 running/done/failed 的任务
      const taskStatusRows = await db
        .select({
          status: tasks.status,
          count: sql<number>`COUNT(*)`,
        })
        .from(tasks)
        .where(eq(tasks.agentId, input.agentId))
        .groupBy(tasks.status);

      const taskCounts: Record<string, number> = {};
      for (const row of taskStatusRows) {
        taskCounts[row.status] = Number(row.count) || 0;
      }

      return {
        agentId: agent.id,
        agentName: agent.name,
        status: agent.status,
        currentTask: agent.currentTask,
        progress: agent.progress,
        lastHeartbeat: agent.lastHeartbeat,
        spentCents: agent.spentCents,
        budgetCents: agent.budgetCents,
        tokenUsage: {
          totalCalls: Number(tokenStats.totalCalls) || 0,
          totalTokens: Number(tokenStats.totalTokens) || 0,
          totalCostCents: Number(tokenStats.totalCostCents) || 0,
        },
        taskExecution: {
          completed: taskStats.completed,
          failed: taskStats.failed,
          dispatched: taskStats.dispatched,
          timeout: taskStats.error,
          running: taskCounts["running"] || 0,
          done: taskCounts["done"] || 0,
          failedTasks: taskCounts["failed"] || 0,
          queued: taskCounts["queued"] || 0,
          pending: taskCounts["pending"] || 0,
        },
      };
    }),

  getDetails: publicQuery
    .input(z.object({ agentId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(agents).where(eq(agents.id, input.agentId));
      const agent = rows[0];
      if (!agent) return null;

      // 解析 capabilities（复用 getCapabilities 逻辑）
      let capabilities: AgentCapability[] = [];
      if (agent.agentCard) {
        try {
          const card = JSON.parse(agent.agentCard) as AgentCard;
          if (card.capabilities && Array.isArray(card.capabilities)) {
            capabilities = card.capabilities;
          }
        } catch { /* ignore */ }
      }
      if (capabilities.length === 0 && agent.capabilities) {
        try {
          const parsed: unknown = JSON.parse(agent.capabilities);
          if (Array.isArray(parsed)) {
            capabilities = parsed.map(normalizeCapabilityItem);
          } else {
            capabilities = [{
              category: "general",
              items: typeof parsed === "string" ? [parsed] : [],
              level: "intermediate",
            }];
          }
        } catch {
          const capItems = agent.capabilities.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
          if (capItems.length > 0) {
            capabilities = [{ category: "general", items: capItems, level: "intermediate" }];
          }
        }
      }
      if (capabilities.length === 0) {
        capabilities = [{ category: agent.role || "general", items: ["general"], level: "intermediate" }];
      }

      // 解析 permissions
      let permissions: Record<string, boolean> = {};
      if (agent.agentCard) {
        try {
          const card = JSON.parse(agent.agentCard) as AgentCard;
          if (card.permissions) permissions = card.permissions;
        } catch { /* ignore */ }
      }
      if (Object.keys(permissions).length === 0) {
        permissions = {
          canModifyTiangongCore: agent.canModifyTiangongCore === "true",
          canSendExternalMessage: agent.canSendExternalMessage === "true",
          canExecuteCode: false,
          canAccessFiles: false,
          canAccessNetwork: false,
        };
      }

      // 统计 tokenUsage
      const tokenUsageRows = await db
        .select({
          totalCalls: sql<number>`SUM(${tokenUsage.callCount})`,
          totalTokens: sql<number>`SUM(${tokenUsage.totalTokens})`,
          totalCostCents: sql<number>`SUM(${tokenUsage.costCents})`,
        })
        .from(tokenUsage)
        .where(eq(tokenUsage.agentId, input.agentId));

      const tokenStats = tokenUsageRows[0] ?? { totalCalls: 0, totalTokens: 0, totalCostCents: 0 };

      // 统计 taskMessages
      const taskMessagesRows = await db
        .select({
          eventType: taskMessages.eventType,
          count: sql<number>`COUNT(*)`,
        })
        .from(taskMessages)
        .where(
          or(
            eq(taskMessages.fromAgentId, input.agentId),
            eq(taskMessages.toAgentId, input.agentId)
          )
        )
        .groupBy(taskMessages.eventType);

      const taskStats = { completed: 0, failed: 0, dispatched: 0, error: 0 };
      for (const row of taskMessagesRows) {
        if (row.eventType === "result") taskStats.completed += Number(row.count) || 0;
        if (row.eventType === "error") taskStats.failed += Number(row.count) || 0;
        if (row.eventType === "dispatch") taskStats.dispatched += Number(row.count) || 0;
        if (row.eventType === "timeout") taskStats.error += Number(row.count) || 0;
      }

      // 从 tasks 表统计
      const taskStatusRows = await db
        .select({
          status: tasks.status,
          count: sql<number>`COUNT(*)`,
        })
        .from(tasks)
        .where(eq(tasks.agentId, input.agentId))
        .groupBy(tasks.status);

      const taskCounts: Record<string, number> = {};
      for (const row of taskStatusRows) {
        taskCounts[row.status] = Number(row.count) || 0;
      }

      return {
        ...agent,
        capabilities,
        permissions,
        runtimeStats: {
          tokenUsage: {
            totalCalls: Number(tokenStats.totalCalls) || 0,
            totalTokens: Number(tokenStats.totalTokens) || 0,
            totalCostCents: Number(tokenStats.totalCostCents) || 0,
          },
          taskExecution: {
            completed: taskStats.completed,
            failed: taskStats.failed,
            dispatched: taskStats.dispatched,
            timeout: taskStats.error,
            running: taskCounts["running"] || 0,
            done: taskCounts["done"] || 0,
            failedTasks: taskCounts["failed"] || 0,
            queued: taskCounts["queued"] || 0,
            pending: taskCounts["pending"] || 0,
          },
        },
      };
    }),

  // ═══ 通知中心（NC-4）═══
  // 归属过滤语义（与 ctx.apiKeyAgentId 现有约定对齐）：
  //   -1（管理型 Key）/ null（登录用户）→ 跨 agent 全量
  //   > 0（Key 绑定 agent）→ 只看自己
  // list 游标分页：按 createdAt DESC, id DESC，cursor 取上一页末条 id（id 单调递增）。
  notifications: createRouter({
    list: authedQuery
      .input(
        z.object({
          limit: z.number().int().min(1).max(100).default(20),
          unreadOnly: z.boolean().default(false),
          cursor: z.number().int().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const db = getDb();
        const isManagement = ctx.apiKeyAgentId === -1 || ctx.apiKeyAgentId === null;
        const conds = [];
        if (!isManagement) conds.push(eq(notifications.agentId, ctx.apiKeyAgentId as number));
        if (input.unreadOnly) conds.push(isNull(notifications.readAt));
        if (input.cursor !== undefined) conds.push(lt(notifications.id, input.cursor));

        const rows = await db
          .select()
          .from(notifications)
          .where(conds.length > 0 ? and(...conds) : undefined)
          .orderBy(desc(notifications.createdAt), desc(notifications.id))
          .limit(input.limit);

        return {
          items: rows,
          nextCursor: rows.length === input.limit ? rows[rows.length - 1]?.id : undefined,
        };
      }),

    markRead: authedQuery
      .input(z.object({ id: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const db = getDb();
        // 越权防护：绑定 agent 的 Key 只能标自己（where 附加 agentId 条件，异主 → affectedRows 0）
        const isManagement = ctx.apiKeyAgentId === -1 || ctx.apiKeyAgentId === null;
        const conds = [eq(notifications.id, input.id)];
        if (!isManagement) conds.push(eq(notifications.agentId, ctx.apiKeyAgentId as number));

        const result = await db
          .update(notifications)
          .set({ readAt: new Date() })
          .where(and(...conds));
        return { marked: getAffectedRows(result) > 0 };
      }),

    markAllRead: authedQuery
      .input(z.object({}))
      .mutation(async ({ ctx }) => {
        const db = getDb();
        // 管理位标所有未读；绑定 agent 的 Key 只标自己的未读
        const isManagement = ctx.apiKeyAgentId === -1 || ctx.apiKeyAgentId === null;
        const conds = [];
        if (!isManagement) conds.push(eq(notifications.agentId, ctx.apiKeyAgentId as number));
        conds.push(isNull(notifications.readAt));

        const result = await db
          .update(notifications)
          .set({ readAt: new Date() })
          .where(and(...conds));
        return { marked: getAffectedRows(result) };
      }),
  }),
});
