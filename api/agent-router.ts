import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents } from "@db/schema";
import { eq } from "drizzle-orm";

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

  create: publicQuery
    .input(
      z.object({
        agentId: z.string().min(1).max(20),
        name: z.string().min(1).max(50),
        system: z.string().min(1).max(30),
        description: z.string().optional(),
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
      });
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

  delete: publicQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(agents).where(eq(agents.id, input.id));
      return { success: true };
    }),
});
