/**
 * 天枢 (Tianshu / New API 兼容网关) 模型管理路由
 *
 * 提供模型列表查询、默认模型选择（持久化到 system_settings）、按智能体分配模型。
 * 任务执行器 (task-runner) 的模型解析优先级：agent.model > 默认模型(设置) > TIANSHU_MODEL 环境变量。
 */
import { z } from "zod";
import { createRouter, userQuery, adminQuery, publicQuery } from "./middleware";
import { getAssistantModel } from "./lib/ai-assistant";
import { getDb } from "./queries/connection";
import { agents, modelPricing } from "@db/schema";
import { eq } from "drizzle-orm";
import { getSetting, setSetting } from "./lib/settings";
import { parseTieredPricing } from "./lib/model-pricing";

const DEFAULT_BASE_URL = "https://woppis1.zeabur.app";
export const TIANSHU_DEFAULT_MODEL_KEY = "tianshu_default_model";
/** 死模型兜底候选（默认模型频道下线时换这个再试一次）；空 = 回退助手模型 */
export const TIANSHU_FALLBACK_MODEL_KEY = "tianshu_fallback_model";
/** 模型可用性探测结果缓存（JSON：{ ts, results: { model: { ok, ms, error } } }） */
export const MODEL_PROBE_CACHE_KEY = "tianshu_model_probe_cache";

type PricingInfo = Record<string, {
  inputPrice: string;
  outputPrice: string;
  cachedInputPrice: string | null;
  tiered: boolean;
}>;
const NO_PRICING: PricingInfo = {};

function tianshuBaseUrl(): string {
  return (process.env.TIANSHU_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function tianshuApiKey(): string {
  return (process.env.TIANSHU_API_KEY || "").trim();
}

function safeHost(): string {
  try {
    return new URL(tianshuBaseUrl()).host;
  } catch {
    return "invalid";
  }
}

/** 解析当前生效的默认模型：设置页选择 > TIANSHU_MODEL 环境变量 */
export async function resolveTianshuDefaultModel(): Promise<string> {
  const fromSettings = await getSetting(TIANSHU_DEFAULT_MODEL_KEY).catch(() => null);
  return (fromSettings || "").trim() || (process.env.TIANSHU_MODEL || "").trim();
}

/**
 * 解析死模型兜底候选：system_settings(tianshu_fallback_model) → 环境变量
 * TIANSHU_FALLBACK_MODEL → 空串（调用方自行回退助手模型）。
 */
export async function resolveTianshuFallbackModel(): Promise<string> {
  const fromSettings = await getSetting(TIANSHU_FALLBACK_MODEL_KEY).catch(() => null);
  return (fromSettings || "").trim() || (process.env.TIANSHU_FALLBACK_MODEL || "").trim();
}

export interface ProbeResult {
  ok: boolean;
  ms: number;
  error?: string;
}

interface TianshuModelsPayload {
  data?: Array<{ id?: unknown }>;
}

export const tianshuRouter = createRouter({
  /** 天枢连接状态 + 当前默认模型 */
  status: userQuery.query(async () => ({
    configured: Boolean(tianshuApiKey()),
    baseUrlHost: safeHost(),
    defaultModel: await resolveTianshuDefaultModel(),
  })),

  /** 从天枢拉取可用模型列表，并合并本地定价信息 */
  listModels: userQuery.query(async () => {
    const apiKey = tianshuApiKey();
    if (!apiKey) {
      return { ok: false as const, error: "TIANSHU_API_KEY 未配置", models: [] as string[], defaultModel: "", pricing: NO_PRICING };
    }

    let modelIds: string[];
    try {
      const resp = await fetch(`${tianshuBaseUrl()}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        return { ok: false as const, error: `天枢返回 HTTP ${resp.status}`, models: [] as string[], defaultModel: "", pricing: NO_PRICING };
      }
      const payload = (await resp.json()) as TianshuModelsPayload;
      modelIds = (payload.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100)
        .sort();
    } catch (e) {
      return { ok: false as const, error: `天枢请求失败: ${e instanceof Error ? e.message : String(e)}`, models: [] as string[], defaultModel: "", pricing: NO_PRICING };
    }

    const db = getDb();
    const pricingRows = await db.select().from(modelPricing);
    const pricing: PricingInfo = {};
    for (const row of pricingRows) {
      pricing[row.model] = {
        inputPrice: String(row.inputPrice),
        outputPrice: String(row.outputPrice),
        cachedInputPrice: row.cachedInputPrice != null ? String(row.cachedInputPrice) : null,
        tiered: parseTieredPricing(row.notes) != null,
      };
    }

    return {
      ok: true as const,
      models: modelIds,
      defaultModel: await resolveTianshuDefaultModel(),
      pricing,
    };
  }),

  /** 设置全局默认模型（写入 system_settings，立即生效） */
  setDefaultModel: adminQuery
    .input(z.object({ model: z.string().min(1).max(100) }))
    .mutation(async ({ input }) => {
      await setSetting(TIANSHU_DEFAULT_MODEL_KEY, input.model, "tianshu");
      return { success: true as const, defaultModel: input.model };
    }),

  /** 死模型兜底候选（公开读：助手页展示用） */
  getFallbackModel: publicQuery.query(async () => ({
    model: await resolveTianshuFallbackModel(),
    /** 空 = 未配置时实际使用助手模型兜底 */
    effectiveFromAssistant: !(await resolveTianshuFallbackModel()),
  })),

  /** 设置死模型兜底候选（admin）；空字符串 = 清除，回退用助手模型 */
  setFallbackModel: adminQuery
    .input(z.object({ model: z.string().max(100) }))
    .mutation(async ({ input }) => {
      await setSetting(TIANSHU_FALLBACK_MODEL_KEY, input.model.trim(), "tianshu");
      return { success: true as const, model: input.model.trim() };
    }),

  /** 模型可用性探测结果缓存（公开读，模型表展示徽标用） */
  getModelProbe: publicQuery.query(async () => {
    const raw = await getSetting(MODEL_PROBE_CACHE_KEY).catch(() => null);
    if (!raw) return { ts: null as string | null, results: {} as Record<string, ProbeResult> };
    try {
      const parsed = JSON.parse(raw) as { ts?: string; results?: Record<string, ProbeResult> };
      return { ts: parsed.ts ?? null, results: parsed.results ?? {} };
    } catch {
      return { ts: null as string | null, results: {} as Record<string, ProbeResult> };
    }
  }),

  /**
   * 探测模型可用性（admin）：发一个最小 chat 请求，把结果并入缓存。
   * 不传 models 时探测「关键模型」：默认模型 + 助手模型 + 兜底模型。
   */
  probeModels: adminQuery
    .input(z.object({ models: z.array(z.string().min(1).max(100)).max(20).optional() }))
    .mutation(async ({ input }) => {
      const targets = input.models?.length
        ? Array.from(new Set(input.models))
        : Array.from(
            new Set(
              [
                await resolveTianshuDefaultModel(),
                await resolveTianshuFallbackModel(),
                await getAssistantModel(),
              ].filter((m): m is string => Boolean(m && m.trim()))
            )
          );
      if (targets.length === 0) return { results: {} as Record<string, ProbeResult>, probed: 0 };

      const results: Record<string, ProbeResult> = {};
      for (const model of targets) {
        const startedAt = Date.now();
        try {
          const resp = await fetch(`${tianshuBaseUrl()}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${tianshuApiKey()}` },
            body: JSON.stringify({
              model,
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 1,
              stream: false,
            }),
            signal: AbortSignal.timeout(12000),
          });
          const body = await resp.text();
          if (resp.ok) {
            results[model] = { ok: true, ms: Date.now() - startedAt };
          } else {
            results[model] = {
              ok: false,
              ms: Date.now() - startedAt,
              error: body.slice(0, 160) || `HTTP ${resp.status}`,
            };
          }
        } catch (e) {
          results[model] = {
            ok: false,
            ms: Date.now() - startedAt,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }

      // 并入历史缓存（保留旧条目，只更新本次探测的模型）
      const prevRaw = await getSetting(MODEL_PROBE_CACHE_KEY).catch(() => null);
      let prev: Record<string, ProbeResult> = {};
      if (prevRaw) {
        try {
          prev = (JSON.parse(prevRaw) as { results?: Record<string, ProbeResult> }).results ?? {};
        } catch {
          prev = {};
        }
      }
      const merged = { ...prev, ...results };
      await setSetting(MODEL_PROBE_CACHE_KEY, JSON.stringify({ ts: new Date().toISOString(), results: merged }), "tianshu");

      return { results, probed: targets.length };
    }),

  /** 清除默认模型（回退到 TIANSHU_MODEL 环境变量 / 智能体自带模型） */
  clearDefaultModel: adminQuery.mutation(async () => {
    await setSetting(TIANSHU_DEFAULT_MODEL_KEY, "", "tianshu");
    return { success: true as const };
  }),

  /** 为指定智能体分配模型（传 null 表示跟随默认） */
  setAgentModel: adminQuery
    .input(z.object({
      agentId: z.number().int().positive(),
      model: z.string().max(100).nullable(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const agent = await db.select().from(agents).where(eq(agents.id, input.agentId)).then((rows) => rows[0]);
      if (!agent) return { success: false as const, error: "智能体不存在" };
      await db.update(agents).set({ model: input.model }).where(eq(agents.id, input.agentId));
      return { success: true as const, agentId: input.agentId, model: input.model };
    }),

  /** 智能体列表及其当前模型（用于分配界面） */
  listAgents: userQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({ id: agents.id, agentId: agents.agentId, name: agents.name, model: agents.model, status: agents.status })
      .from(agents);
    return rows;
  }),
});
