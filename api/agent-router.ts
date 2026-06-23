import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents, tasks, modelAllowlist, type AgentCard } from "@db/schema";
import { eq, like, and, isNotNull, isNull, sql, desc } from "drizzle-orm";

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
        agentCard: z.record(z.string(), z.any()).optional(),
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
      const insertId = (result as any).insertId;

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
        agentCard: z.record(z.string(), z.any()).optional(),
        openclawAgent: z.string().max(100).optional(),
        canModifyTiangongCore: z.boolean().optional(),
        canSendExternalMessage: z.boolean().optional(),
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
   * 任务认领 — 查找可认领的 queued 任务并认领
   */
  claimTask: publicQuery
    .input(z.object({ agentId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();

      // 1. 查询 Agent 信息
      const agentRows = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.agentId));
      const agent = agentRows[0];
      if (!agent) {
        throw new Error("Agent not found");
      }

      // 2. 查找可认领的任务：状态为 queued，且 agentId 匹配此 Agent 或为 null（通用任务），按优先级降序
      const claimableTasks = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.status, "queued"),
            agent.orgId
              ? eq(tasks.agentId, input.agentId)
              : eq(tasks.agentId, input.agentId),
          )
        )
        .orderBy(desc(tasks.priority))
        .limit(1);

      // 也查询 agentId 为 null 的通用任务
      const genericTasks = await db
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.status, "queued"),
            isNull(tasks.agentId),
          )
        )
        .orderBy(desc(tasks.priority))
        .limit(1);

      // 合并并取优先级最高的
      const allClaimable = [...claimableTasks, ...genericTasks]
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));

      const task = allClaimable[0];

      if (!task) {
        return { task: null };
      }

      // 3. 认领任务：更新任务状态为 running，设置 agentId，A2A-lite lifecycle
      await db
        .update(tasks)
        .set({
          status: "running",
          lifecycleStatus: "claimed",
          agentId: input.agentId,
          claimedAt: new Date(),
        })
        .where(eq(tasks.id, task.id));

      // 4. 更新 Agent 状态为 busy
      await db
        .update(agents)
        .set({ status: "busy" })
        .where(eq(agents.id, input.agentId));

      return {
        task: {
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          description: task.description,
          input: task.input,
          priority: task.priority,
        },
      };
    }),

  updateHeartbeat: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();

      // 1. 更新心跳
      await db
        .update(agents)
        .set({ lastHeartbeat: new Date(), status: "online" })
        .where(eq(agents.id, input.id));

      // 2. 检查是否有 queued 任务可认领
      const agentRows = await db
        .select()
        .from(agents)
        .where(eq(agents.id, input.id));
      const agent = agentRows[0];

      let claimedTask: { id: number; taskId: string; name: string } | null = null;

      if (agent) {
        // 查找匹配此 Agent 的 queued 任务
        const matchedTasks = await db
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.status, "queued"),
              eq(tasks.agentId, input.id),
            )
          )
          .orderBy(desc(tasks.priority))
          .limit(1);

        // 查找通用任务（agentId 为 null）
        const genericTasks = await db
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.status, "queued"),
              isNull(tasks.agentId),
            )
          )
          .orderBy(desc(tasks.priority))
          .limit(1);

        const allClaimable = [...matchedTasks, ...genericTasks]
          .sort((a, b) => (b.priority || 0) - (a.priority || 0));

        const bestTask = allClaimable[0];

        if (bestTask) {
          // 自动认领，A2A-lite lifecycle
          await db
            .update(tasks)
            .set({
              status: "running",
              lifecycleStatus: "claimed",
              agentId: input.id,
              claimedAt: new Date(),
            })
            .where(eq(tasks.id, bestTask.id));

          await db
            .update(agents)
            .set({ status: "busy" })
            .where(eq(agents.id, input.id));

          claimedTask = {
            id: bestTask.id,
            taskId: bestTask.taskId,
            name: bestTask.name,
          };
        }
      }

      return { success: true, claimedTask };
    }),

  getHierarchy: publicQuery.query(async () => {
    const db = getDb();
    const allAgents = await db.select().from(agents);

    // Build a tree from orgId/departmentId/reportsTo
    const byId = new Map(allAgents.map(a => [a.id, { ...a, children: [] as typeof allAgents }]));
    const roots: typeof allAgents = [];

    for (const a of allAgents) {
      if (a.reportsTo && byId.has(a.reportsTo)) {
        const parent = byId.get(a.reportsTo)! as any;
        parent.children = parent.children || [];
        parent.children.push(byId.get(a.id)!);
      } else {
        roots.push(byId.get(a.id)!);
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
        card: z.record(z.string(), z.any()),
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
});
