import { z } from "zod";
import { createRouter, publicQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { systems } from "@db/schema";
import { eq } from "drizzle-orm";

export const systemRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(systems).orderBy(systems.name);
  }),

  updateStatus: adminQuery
    .input(
      z.object({
        id: z.number(),
        status: z.enum(["connected", "syncing", "disconnected"]),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      await db
        .update(systems)
        .set({ status: input.status })
        .where(eq(systems.id, input.id));
      return { success: true };
    }),
});
