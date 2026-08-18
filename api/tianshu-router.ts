/**
 * 天枢 (Tianshu / New API 兼容网关) 模型管理路由
 *
 * 提供模型列表查询、默认模型选择（持久化到 system_settings）、按智能体分配模型。
 * 任务执行器 (task-runner) 的模型解析优先级：agent.model > 默认模型(设置) > TIANSHU_MODEL 环境变量。
 */
import { z } from "zod";
import { createRouter, userQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents, modelPricing } from "@db/schema";
import { eq } from "drizzle-orm";
import { getSetting, setSetting } from "./lib/settings";

const DEFAULT_BASE_URL = "https://woppis1.zeabur.app";
export const TIANSHU_DEFAULT_MODEL_KEY = "tianshu_default_model";

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
      return { ok: false as const, error: "TIANSHU_API_KEY 未配置", models: [] as string[], defaultModel: "", pricing: {} as Record<string, { inputPrice: string; outputPrice: string }> };
    }

    let modelIds: string[];
    try {
      const resp = await fetch(`${tianshuBaseUrl()}/v1/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        return { ok: false as const, error: `天枢返回 HTTP ${resp.status}`, models: [] as string[], defaultModel: "", pricing: {} as Record<string, { inputPrice: string; outputPrice: string }> };
      }
      const payload = (await resp.json()) as TianshuModelsPayload;
      modelIds = (payload.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 100)
        .sort();
    } catch (e) {
      return { ok: false as const, error: `天枢请求失败: ${e instanceof Error ? e.message : String(e)}`, models: [] as string[], defaultModel: "", pricing: {} as Record<string, { inputPrice: string; outputPrice: string }> };
    }

    const db = getDb();
    const pricingRows = await db.select().from(modelPricing);
    const pricing: Record<string, { inputPrice: string; outputPrice: string }> = {};
    for (const row of pricingRows) {
      pricing[row.model] = { inputPrice: String(row.inputPrice), outputPrice: String(row.outputPrice) };
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
