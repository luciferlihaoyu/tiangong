import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { organizations, departments, agents } from "@db/schema";
import { eq, and } from "drizzle-orm";

export const orgRouter = createRouter({
  // ─── Organizations ───
  orgList: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(organizations).orderBy(organizations.name);
  }),

  orgGet: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const rows = await db.select().from(organizations).where(eq(organizations.id, input.id));
      return rows[0] ?? null;
    }),

  orgCreate: publicQuery
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      goals: z.string().optional(),
      budget: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(organizations).values({
        name: input.name,
        description: input.description ?? null,
        goals: input.goals ?? null,
        budget: input.budget ?? 0,
      });
      return { success: true };
    }),

  orgUpdate: publicQuery
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().optional(),
      goals: z.string().optional(),
      budget: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...fields } = input;
      const updateFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) updateFields[k] = v;
      }
      if (Object.keys(updateFields).length > 0) {
        await db.update(organizations).set(updateFields).where(eq(organizations.id, id));
      }
      return { success: true };
    }),

  orgDelete: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(organizations).where(eq(organizations.id, input.id));
      return { success: true };
    }),

  orgGetDepartments: publicQuery
    .input(z.object({ orgId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      const depts = await db.select().from(departments).where(eq(departments.orgId, input.orgId));
      return depts;
    }),

  // ─── Departments ───
  deptCreate: publicQuery
    .input(z.object({
      name: z.string().min(1).max(100),
      description: z.string().optional(),
      orgId: z.number(),
      leadAgentId: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.insert(departments).values({
        name: input.name,
        description: input.description ?? null,
        orgId: input.orgId,
        leadAgentId: input.leadAgentId ?? null,
      });
      return { success: true };
    }),

  deptUpdate: publicQuery
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(100).optional(),
      description: z.string().optional(),
      leadAgentId: z.number().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...fields } = input;
      const updateFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) updateFields[k] = v;
      }
      if (Object.keys(updateFields).length > 0) {
        await db.update(departments).set(updateFields).where(eq(departments.id, id));
      }
      return { success: true };
    }),

  deptDelete: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      // Unassign agents from this department
      await db.update(agents).set({ departmentId: null }).where(eq(agents.departmentId, input.id));
      await db.delete(departments).where(eq(departments.id, input.id));
      return { success: true };
    }),

  deptGetAgents: publicQuery
    .input(z.object({ deptId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(agents).where(eq(agents.departmentId, input.deptId));
    }),

  deptAssignAgent: publicQuery
    .input(z.object({
      agentId: z.number(),
      deptId: z.number(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const dept = await db.select().from(departments).where(eq(departments.id, input.deptId)).then(r => r[0]);
      if (!dept) return { success: false, error: "部门不存在" };
      await db.update(agents).set({
        departmentId: input.deptId,
        orgId: dept.orgId,
      }).where(eq(agents.id, input.agentId));
      return { success: true };
    }),

  deptUnassignAgent: publicQuery
    .input(z.object({ agentId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(agents).set({
        departmentId: null,
        orgId: null,
      }).where(eq(agents.id, input.agentId));
      return { success: true };
    }),

  // Full org tree
  orgTree: publicQuery.query(async () => {
    const db = getDb();
    const orgs = await db.select().from(organizations);
    const allDepts = await db.select().from(departments);
    const allAgents = await db.select().from(agents);

    const tree = orgs.map(org => {
      const orgDepts = allDepts.filter(d => d.orgId === org.id);
      return {
        ...org,
        departments: orgDepts.map(dept => {
          const deptAgents = allAgents.filter(a => a.departmentId === dept.id);
          return {
            ...dept,
            leadAgent: dept.leadAgentId ? allAgents.find(a => a.id === dept.leadAgentId) : null,
            agents: deptAgents,
          };
        }),
      };
    });

    return tree;
  }),
});
