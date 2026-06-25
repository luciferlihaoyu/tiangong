/**
 * P13: Model Pricing management router
 */
import { z } from "zod";
import { createRouter, publicQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { modelPricing } from "@db/schema";
import { eq } from "drizzle-orm";

export const pricingRouter = createRouter({
  /**
   * List all model pricing entries
   */
  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(modelPricing).orderBy(modelPricing.model);
  }),

  /**
   * Upsert a model pricing entry
   */
  upsert: adminQuery
    .input(
      z.object({
        model: z.string().min(1).max(100),
        provider: z.string().max(50).optional(),
        inputPrice: z.union([z.string(), z.number()]).transform((v) => String(v)),
        outputPrice: z.union([z.string(), z.number()]).transform((v) => String(v)),
        cachedInputPrice: z.union([z.string(), z.number()]).optional().transform((v) => v === undefined ? undefined : String(v)),
        currency: z.string().max(3).optional(),
        notes: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const existing = await db
        .select()
        .from(modelPricing)
        .where(eq(modelPricing.model, input.model))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(modelPricing)
          .set({
            provider: input.provider ?? existing[0].provider,
            inputPrice: input.inputPrice,
            outputPrice: input.outputPrice,
            cachedInputPrice: input.cachedInputPrice ?? existing[0].cachedInputPrice,
            currency: input.currency ?? existing[0].currency,
            notes: input.notes ?? existing[0].notes,
            updatedAt: new Date(),
          })
          .where(eq(modelPricing.model, input.model));
        return { model: input.model, action: "updated" as const };
      }

      await db.insert(modelPricing).values({
        model: input.model,
        provider: input.provider ?? "unknown",
        inputPrice: input.inputPrice,
        outputPrice: input.outputPrice,
        cachedInputPrice: input.cachedInputPrice,
        currency: input.currency ?? "USD",
        notes: input.notes,
      });
      return { model: input.model, action: "created" as const };
    }),

  /**
   * Delete a model pricing entry
   */
  delete: adminQuery
    .input(z.object({ model: z.string().min(1).max(100) }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(modelPricing).where(eq(modelPricing.model, input.model));
      return { deleted: true, model: input.model };
    }),
});
