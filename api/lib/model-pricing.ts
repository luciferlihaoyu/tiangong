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
 * 分层定价档位（按上下文长度分档，价格单位 USD / 1K tokens）
 */
export interface PricingTier {
  /** 该档上下文长度上限（tokens），null = 最高档（无上限） */
  maxTokens: number | null;
  inputPer1k: number;
  outputPer1k: number;
  cachedPer1k: number | null;
}

/**
 * 解析 New API billing_expr 分层计费表达式，例如：
 *   len <= 200000 ? tier("0_200k", p * 1.25 + c * 10 + cr * 0.125) : tier("200k_plus", p * 2.5 + c * 15 + cr * 0.25)
 * 系数单位为 USD / 1M tokens，此处换算为 USD / 1K。无法解析返回 null。
 */
export function parseBillingExpr(expr: string): PricingTier[] | null {
  const parseTerms = (body: string): Record<string, number> => {
    const out: Record<string, number> = {};
    const re = /([a-zA-Z_]+)\s*\*\s*([0-9]+(?:\.[0-9]+)?)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body))) out[m[1]] = Number(m[2]);
    return out;
  };
  const toTier = (maxTokens: number | null, body: string): PricingTier | null => {
    const t = parseTerms(body);
    if (t["p"] == null || t["c"] == null) return null;
    return {
      maxTokens,
      inputPer1k: t["p"] / 1000,
      outputPer1k: t["c"] / 1000,
      cachedPer1k: t["cr"] != null ? t["cr"] / 1000 : null,
    };
  };

  const tiers: PricingTier[] = [];
  let rest = expr.trim();
  while (true) {
    const m = rest.match(/^len\s*<=\s*(\d+)\s*\?\s*tier\("[^"]*",\s*([^)]*)\)\s*:\s*([\s\S]+)$/);
    if (!m) break;
    const tier = toTier(Number(m[1]), m[2]);
    if (!tier) return null;
    tiers.push(tier);
    rest = m[3].trim();
  }
  const last = rest.match(/^tier\("[^"]*",\s*([^)]*)\)\s*$/);
  if (last) {
    const tier = toTier(null, last[1]);
    if (!tier) return null;
    tiers.push(tier);
  }
  return tiers.length > 0 ? tiers : null;
}

/**
 * 从 model_pricing.notes 解析分层定价档位（pricing-sync 写入的 JSON）。
 * 非 JSON 或无 tiered 字段时返回 null（即普通统一价模型）。
 */
export function parseTieredPricing(notes: string | null | undefined): PricingTier[] | null {
  if (!notes) return null;
  const trimmed = notes.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { tiered?: unknown };
    if (!Array.isArray(parsed.tiered)) return null;
    const tiers: PricingTier[] = [];
    for (const t of parsed.tiered) {
      if (typeof t !== "object" || t == null) return null;
      const o = t as Record<string, unknown>;
      const input = Number(o.inputPer1k);
      const output = Number(o.outputPer1k);
      if (!isFinite(input) || !isFinite(output)) return null;
      tiers.push({
        maxTokens: o.maxTokens == null ? null : Number(o.maxTokens),
        inputPer1k: input,
        outputPer1k: output,
        cachedPer1k: o.cachedPer1k == null ? null : Number(o.cachedPer1k),
      });
    }
    return tiers.length > 0 ? tiers : null;
  } catch {
    return null;
  }
}

/**
 * 查询模型定价；若该模型为分层定价且提供了上下文长度，按实际长度选档返回。
 * contextTokens 缺省时返回基础档（价格列原值）。
 */
export async function resolveModelPricing(model: string, contextTokens?: number) {
  const row = await getModelPricing(model);
  if (!row || contextTokens == null) return row;
  const tiers = parseTieredPricing(row.notes);
  if (!tiers) return row;
  const tier = tiers.find((t) => t.maxTokens == null || contextTokens <= t.maxTokens) ?? tiers[tiers.length - 1];
  return {
    ...row,
    inputPrice: tier.inputPer1k.toFixed(8),
    outputPrice: tier.outputPer1k.toFixed(8),
    cachedInputPrice: tier.cachedPer1k != null ? tier.cachedPer1k.toFixed(8) : row.cachedInputPrice,
  };
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
): { costUsd: number; costCents: number; costMicros: number; savedByCacheUsd: number } {
  if (!pricing) {
    const totalTokens = cachedPromptTokens + uncachedPromptTokens + completionTokens;
    const costUsd = (totalTokens * FALLBACK_PRICE_PER_1K) / 1000;
    return { costUsd, costCents: Math.round(costUsd * 100), costMicros: Math.round(costUsd * 1_000_000), savedByCacheUsd: 0 };
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
    costMicros: Math.round(costUsd * 1_000_000),
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
  costResult: { costUsd: number; costCents: number; costMicros: number; savedByCacheUsd: number }
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
    costMicros: costResult.costMicros,
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
