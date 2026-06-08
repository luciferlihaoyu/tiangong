import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents } from "@db/schema";
import { eq, like, and, isNotNull, sql } from "drizzle-orm";

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

  create: publicQuery
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
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(agents).values({
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
      });
      return { success: true };
    }),

  update: publicQuery
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
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...fields } = input;
      const updateFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) updateFields[k] = v;
      }
      if (Object.keys(updateFields).length > 0) {
        await db.update(agents).set(updateFields).where(eq(agents.id, id));
      }
      return { success: true };
    }),

  updateStatus: publicQuery
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

  updateHeartbeat: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(agents)
        .set({ lastHeartbeat: new Date() })
        .where(eq(agents.id, input.id));
      return { success: true };
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

  delete: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(agents).where(eq(agents.id, input.id));
      return { success: true };
    }),
});
