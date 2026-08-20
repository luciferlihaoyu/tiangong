/**
 * 按当前定价表重算历史用量成本
 *
 * 官方定价同步（pricing.syncOfficial）后调用，把 token_usage 中的历史记录
 * 用最新定价（含分层定价按上下文长度选档）重新计价，刷新 cost_cents /
 * cost_micros / cost_display / exchange_rate。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { tokenUsage } from "@db/schema";
import { resolveModelPricing, calculateCost, DEFAULT_EXCHANGE_RATE } from "./model-pricing";

export async function recalcAllUsageCosts(): Promise<{ total: number; updated: number }> {
  const db = getDb();
  const rows = await db.select().from(tokenUsage);
  let updated = 0;

  for (const row of rows) {
    const pricing = await resolveModelPricing(row.model, row.promptTokens ?? 0);
    const cost = calculateCost(
      pricing,
      row.cachedPromptTokens ?? 0,
      row.uncachedPromptTokens ?? 0,
      row.completionTokens ?? 0
    );
    const costDisplay = (cost.costUsd * DEFAULT_EXCHANGE_RATE).toFixed(4);
    if (
      row.costCents === cost.costCents &&
      Number(row.costMicros ?? 0) === cost.costMicros &&
      String(row.costDisplay) === costDisplay
    ) {
      continue;
    }
    await db
      .update(tokenUsage)
      .set({
        costCents: cost.costCents,
        costMicros: cost.costMicros,
        costDisplay,
        exchangeRate: String(DEFAULT_EXCHANGE_RATE),
      })
      .where(eq(tokenUsage.id, Number(row.id)));
    updated++;
  }

  return { total: rows.length, updated };
}
