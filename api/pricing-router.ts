/**
 * P13: Model Pricing management router
 */
import { z } from "zod";
import { createRouter, publicQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { modelPricing } from "@db/schema";
import { eq } from "drizzle-orm";
import { getOfficialPricingStatus, syncOfficialPricing } from "./lib/pricing-sync";
import { recalcAllUsageCosts } from "./lib/usage-recalc";

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
   * 从天枢 (Tianshu / New API 兼容网关) 同步模型列表到定价表。
   * 拉取 {TIANSHU_BASE_URL}/v1/models（需 TIANSHU_API_KEY），
   * 新模型以 provider="tianshu"、价格 0 占位插入（价格需后续人工维护），
   * 已存在的模型不覆盖价格。
   *
   * 增删同步：除插入新模型外，还会删除「provider=tianshu 且上游已下线」
   * 的本地条目——只清理天枢同步来源的模型，不动手工维护或官方定价同步
   * 的条目，避免误删。
   */
  syncFromTianshu: adminQuery.mutation(async () => {
    const baseUrl = (process.env.TIANSHU_BASE_URL || "https://woppis1.zeabur.app").replace(/\/+$/, "");
    const apiKey = process.env.TIANSHU_API_KEY || "";
    if (!apiKey) {
      return { success: false as const, error: "TIANSHU_API_KEY 未配置" };
    }

    let modelIds: string[];
    try {
      const resp = await fetch(`${baseUrl}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        return { success: false as const, error: `天枢返回 HTTP ${resp.status}` };
      }
      const payload = (await resp.json()) as { data?: Array<{ id?: unknown }> };
      modelIds = (payload.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100);
    } catch (e) {
      return { success: false as const, error: `天枢请求失败: ${e instanceof Error ? e.message : String(e)}` };
    }

    const db = getDb();
    const existing = await db.select({ model: modelPricing.model, provider: modelPricing.provider }).from(modelPricing);
    const existingSet = new Set(existing.map((r) => r.model));
    const upstreamSet = new Set(modelIds);

    let created = 0;
    for (const id of modelIds) {
      if (existingSet.has(id)) continue;
      await db.insert(modelPricing).values({
        model: id,
        provider: "tianshu",
        inputPrice: "0",
        outputPrice: "0",
        currency: "USD",
        notes: "Synced from Tianshu /v1/models — 价格待人工维护",
      });
      created++;
    }

    // 删除：仅清理 provider=tianshu 且上游已下线的条目（保护手工/官方模型）
    let removed = 0;
    const candidates = existing.filter((r) => r.provider === "tianshu" && !upstreamSet.has(r.model));
    for (const row of candidates) {
      await db.delete(modelPricing).where(eq(modelPricing.model, row.model));
      removed++;
    }

    return {
      success: true as const,
      total: modelIds.length,
      created,
      removed,
      skipped: modelIds.length - created,
    };
  }),

  /**
   * 从官方定价源（BaseLLM ratio_config，与天枢 New API 同源）全量同步模型定价。
   * 覆盖已有价格；分层定价模型按上下文分档存储。可用 PRICING_SYNC_URL 覆盖数据源。
   */
  syncOfficial: adminQuery.mutation(async () => {
    const result = await syncOfficialPricing();
    if (!result.success) return result;
    // 定价更新后，用最新价格重算全部历史用量成本
    const recalc = await recalcAllUsageCosts().catch(() => null);
    return { ...result, usageRecalculated: recalc?.updated ?? null };
  }),

  /** 官方定价同步状态（最近同步时间 / 数量 / 来源） */
  officialStatus: publicQuery.query(async () => getOfficialPricingStatus()),

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
