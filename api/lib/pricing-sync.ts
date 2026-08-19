/**
 * 官方模型定价同步（BaseLLM / New API ratio_config 格式）
 *
 * 数据源默认：https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json
 * （与天枢 New API 实例同源；可用 PRICING_SYNC_URL 环境变量覆盖）
 *
 * New API 约定：model_ratio = 1 对应 $0.002 / 1K tokens 输入价；
 * 输出价 = model_ratio × completion_ratio；缓存价 = 输入价 × cache_ratio；
 * model_price 存在时为固定价（USD / 1M tokens），优先于 ratio。
 * billing_mode = "tiered_expr" 的模型为分层定价（按上下文长度分档）：
 * 基础档写入价格列，完整档位序列化进 notes（JSON），成本核算按实际上下文长度选档。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { modelPricing } from "@db/schema";
import { getSetting, setSetting } from "./settings";
import { parseBillingExpr, parseTieredPricing, type PricingTier } from "./model-pricing";

export const DEFAULT_PRICING_SYNC_URL =
  "https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json";
export const PRICING_SYNCED_AT_KEY = "pricing_official_synced_at";
export const PRICING_SYNC_META_KEY = "pricing_official_sync_meta";

/** New API 基准：ratio = 1 ⇒ $0.002 / 1K tokens */
const USD_PER_1K_PER_RATIO = 0.002;

interface RatioConfigData {
  model_ratio?: Record<string, number>;
  completion_ratio?: Record<string, number>;
  cache_ratio?: Record<string, number>;
  model_price?: Record<string, number>;
  billing_mode?: Record<string, string>;
  billing_expr?: Record<string, string>;
}

export interface OfficialSyncResult {
  success: boolean;
  error?: string;
  total?: number;
  created?: number;
  updated?: number;
  tiered?: number;
  syncedAt?: string;
  sourceHost?: string;
}

function pricingSyncUrl(): string {
  return (process.env.PRICING_SYNC_URL || DEFAULT_PRICING_SYNC_URL).trim();
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid";
  }
}

/** 按模型名推断提供商（用于展示/归类） */
export function inferProvider(model: string): string {
  const m = model.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/^(gpt-|o1|o3|o4|chatgpt|text-embedding|whisper|tts|dall-e|davinci|babbage)/, "openai"],
    [/^claude/, "anthropic"],
    [/^(gemini|gemma|imagen|veo|learnlm)/, "google"],
    [/^deepseek/, "deepseek"],
    [/^(qwen|qwq|wanx|tongyi)/, "alibaba"],
    [/^(glm|chatglm|cogview|cogvideo)/, "zhipu"],
    [/^(kimi|moonshot)/, "moonshot"],
    [/^grok/, "xai"],
    [/^(minimax|abab)/, "minimax"],
    [/^(doubao|ep-)/, "bytedance"],
    [/^(ernie|wenxin)/, "baidu"],
    [/^hunyuan/, "tencent"],
    [/^spark/, "iflytek"],
    [/^(llama|meta-llama)/, "meta"],
    [/^(mistral|mixtral|codestral|pixtral)/, "mistral"],
    [/^step/, "stepfun"],
    [/^(command|embed-)/, "cohere"],
    [/^yi-/, "01ai"],
    [/^solar/, "upstage"],
    [/^longcat/, "meituan"],
    [/^mimo/, "xiaomi"],
    [/^mercury/, "inception"],
  ];
  for (const [re, provider] of rules) {
    if (re.test(m)) return provider;
  }
  return "tianshu";
}

/** 最近同步状态（供界面展示） */
export async function getOfficialPricingStatus() {
  const syncedAt = await getSetting(PRICING_SYNCED_AT_KEY).catch(() => null);
  const metaRaw = await getSetting(PRICING_SYNC_META_KEY).catch(() => null);
  let meta: Record<string, unknown> = {};
  try {
    meta = metaRaw ? (JSON.parse(metaRaw) as Record<string, unknown>) : {};
  } catch {
    meta = {};
  }
  return {
    syncedAt: syncedAt || null,
    sourceHost: safeHost(pricingSyncUrl()),
    total: Number(meta.total ?? 0) || 0,
    created: Number(meta.created ?? 0) || 0,
    updated: Number(meta.updated ?? 0) || 0,
    tiered: Number(meta.tiered ?? 0) || 0,
  };
}

/**
 * 从官方定价源全量同步模型定价到 model_pricing 表。
 * 已存在的模型覆盖价格（官方源为准），不删除官方源之外的自定义模型。
 */
export async function syncOfficialPricing(): Promise<OfficialSyncResult> {
  const url = pricingSyncUrl();

  let data: RatioConfigData;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { accept: "application/json" },
    });
    if (!resp.ok) return { success: false, error: `定价源返回 HTTP ${resp.status}` };
    const payload = (await resp.json()) as { success?: boolean; data?: RatioConfigData };
    if (!payload.success || typeof payload.data !== "object" || payload.data == null) {
      return { success: false, error: "定价源数据格式不正确" };
    }
    data = payload.data;
  } catch (e) {
    return { success: false, error: `定价源请求失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  const modelRatio = data.model_ratio ?? {};
  const completionRatio = data.completion_ratio ?? {};
  const cacheRatio = data.cache_ratio ?? {};
  const modelPrice = data.model_price ?? {};
  const billingMode = data.billing_mode ?? {};
  const billingExpr = data.billing_expr ?? {};

  const models = new Set<string>([
    ...Object.keys(modelRatio),
    ...Object.keys(modelPrice),
    ...Object.keys(billingExpr),
  ]);

  const db = getDb();
  const existing = await db.select({ model: modelPricing.model }).from(modelPricing);
  const existingSet = new Set(existing.map((r) => r.model));

  const syncedAt = new Date();
  let created = 0;
  let updated = 0;
  let tieredCount = 0;

  for (const model of models) {
    if (!model || model.length > 100) continue;

    let input = 0;
    let output = 0;
    let cached: number | null = null;
    let tiers: PricingTier[] | null = null;

    // 分层定价模型：基础档写入价格列，完整档位进 notes
    if (billingMode[model] === "tiered_expr" && typeof billingExpr[model] === "string") {
      const parsed = parseBillingExpr(billingExpr[model]);
      if (parsed && parsed.length > 0) {
        tiers = parsed;
        input = parsed[0].inputPer1k;
        output = parsed[0].outputPer1k;
        cached = parsed[0].cachedPer1k;
        tieredCount++;
      }
    }

    if (!tiers) {
      if (typeof modelPrice[model] === "number" && modelPrice[model] > 0) {
        // 固定价（USD / 1M tokens）
        input = modelPrice[model] / 1000;
        output = (modelPrice[model] * (completionRatio[model] ?? 1)) / 1000;
        const cr = cacheRatio[model];
        cached = typeof cr === "number" ? input * cr : null;
      } else if (typeof modelRatio[model] === "number") {
        input = modelRatio[model] * USD_PER_1K_PER_RATIO;
        output = modelRatio[model] * (completionRatio[model] ?? 1) * USD_PER_1K_PER_RATIO;
        const cr = cacheRatio[model];
        cached = typeof cr === "number" ? input * cr : null;
      } else {
        continue;
      }
    }

    const notes = JSON.stringify({
      source: "basellm",
      syncedAt: syncedAt.toISOString(),
      ...(tiers ? { tiered: tiers } : {}),
    });
    const values = {
      provider: inferProvider(model),
      inputPrice: input.toFixed(8),
      outputPrice: output.toFixed(8),
      cachedInputPrice: cached != null ? cached.toFixed(8) : null,
      currency: "USD",
      notes,
    };

    if (existingSet.has(model)) {
      await db
        .update(modelPricing)
        .set({ ...values, updatedAt: syncedAt })
        .where(eq(modelPricing.model, model));
      updated++;
    } else {
      await db.insert(modelPricing).values({ model, ...values });
      created++;
    }
  }

  const meta = {
    total: created + updated,
    created,
    updated,
    tiered: tieredCount,
  };
  await setSetting(PRICING_SYNCED_AT_KEY, syncedAt.toISOString(), "pricing").catch(() => undefined);
  await setSetting(PRICING_SYNC_META_KEY, JSON.stringify(meta), "pricing").catch(() => undefined);

  return {
    success: true,
    ...meta,
    syncedAt: syncedAt.toISOString(),
    sourceHost: safeHost(url),
  };
}

// 供 tianshu-router 列表标注分层模型使用
export { parseTieredPricing };
