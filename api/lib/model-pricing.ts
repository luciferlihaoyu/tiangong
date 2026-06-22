/**
 * P13: Model pricing lookup + cost calculation utilities
 */
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { modelPricing, tokenUsage } from "@db/schema";

/** Default exchange rate: 1 USD = 7.2 CNY */
export const DEFAULT_EXCHANGE_RATE = 7.2;

/** Fallback price in USD per 1K tokens when model is not in pricing table */
export const FALLBACK_PRICE_PER_1K = 0.002;

/**
 * Look up a model's pricing. Returns null if not found.
 */
export async function getModelPricing(model: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(modelPricing)
    .where(eq(modelPricing.model, model))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Calculate real cost in USD cents for a usage record.
 *
 * Formula:
 *   cost = (uncachedPrompt * inputPrice + cachedPrompt * cachedInputPrice + completion * outputPrice) / 1000
 *
 * Falls back to uniform $0.002/1K tokens if model not in pricing table.
 */
export function calculateCost(
  pricing: { inputPrice: string | number; outputPrice: string | number; cachedInputPrice: string | number | null } | null,
  cachedPromptTokens: number,
  uncachedPromptTokens: number,
  completionTokens: number
): { costUsd: number; costCents: number; savedByCacheUsd: number } {
  if (!pricing) {
    const totalTokens = cachedPromptTokens + uncachedPromptTokens + completionTokens;
    const costUsd = (totalTokens * FALLBACK_PRICE_PER_1K) / 1000;
    return { costUsd, costCents: Math.round(costUsd * 100), savedByCacheUsd: 0 };
  }

  const inputPrice = Number(pricing.inputPrice) || 0;
  const outputPrice = Number(pricing.outputPrice) || 0;
  const cachedInputPrice = pricing.cachedInputPrice != null ? Number(pricing.cachedInputPrice) : inputPrice;

  const uncachedCost = (uncachedPromptTokens * inputPrice) / 1000;
  const cachedCost = (cachedPromptTokens * cachedInputPrice) / 1000;
  const completionCost = (completionTokens * outputPrice) / 1000;
  const costUsd = uncachedCost + cachedCost + completionCost;

  // Saved by cache = what it would have cost without cache discount
  const savedByCacheUsd = cachedPromptTokens > 0 && cachedInputPrice < inputPrice
    ? (cachedPromptTokens * (inputPrice - cachedInputPrice)) / 1000
    : 0;

  return {
    costUsd,
    costCents: Math.round(costUsd * 100),
    savedByCacheUsd,
  };
}

/**
 * Build insert values for token_usage with P13 fields.
 */
export function buildTokenUsageValues(
  params: {
    model: string;
    provider?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cachedPromptTokens?: number;
    uncachedPromptTokens?: number;
    callCount?: number;
    costCents?: number;
    taskId?: number;
    agentId?: number;
    sessionKey?: string;
    source?: string;
    traceId?: string;
    startedAt?: Date | string;
  },
  costResult: { costUsd: number; costCents: number; savedByCacheUsd: number }
): typeof tokenUsage.$inferInsert {
  const total =
    params.totalTokens ??
    ((params.promptTokens ?? 0) + (params.completionTokens ?? 0));

  return {
    model: params.model,
    provider: params.provider ?? "unknown",
    promptTokens: params.promptTokens ?? 0,
    completionTokens: params.completionTokens ?? 0,
    totalTokens: total,
    cachedPromptTokens: params.cachedPromptTokens ?? 0,
    uncachedPromptTokens: params.uncachedPromptTokens ?? 0,
    callCount: params.callCount ?? 1,
    costCents: costResult.costCents,
    currency: "USD",
    exchangeRate: String(DEFAULT_EXCHANGE_RATE),
    costDisplay: String((costResult.costUsd * DEFAULT_EXCHANGE_RATE).toFixed(4)),
    taskId: params.taskId,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    source: params.source ?? "manual",
    traceId: params.traceId,
    startedAt: params.startedAt ? new Date(params.startedAt) : undefined,
  };
}
