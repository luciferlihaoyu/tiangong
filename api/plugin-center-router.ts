/**
 * 插件中心路由（P2-1）
 *
 * - list: 列出全部插件；并发探活每个"启用"插件的 MCP tools/list（3s 超时，
 *   单插件失败只影响自身 status，绝不拖垮整体，也绝不抛崩）。返回体绝不
 *   包含 url 与 tokenEnvKey（普通用户不可见内部地址与密钥环境变量名）。
 * - setEnable: 管理员切换插件启用状态。
 * - upsert: 管理员新增/更新插件注册信息（key 相同则覆盖，启用状态保留原值）。
 * - remove: 管理员删除插件（幂等：key 不存在也视为成功）。
 *
 * 惯例与 platform-router 一致：出站请求一律 fetch + AbortSignal.timeout，
 * 异常全部捕获转成结构化结果；admin 过程失败返回固定中文文案，不透传内部错误。
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, adminQuery, userQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { plugins, type Plugin } from "@db/schema";

// ─── 类型定义 ───

/** 对外插件状态（契约钉死："ok" | "down" | "unknown"；未探活的禁用插件为 "unknown"） */
type PluginStatus = "ok" | "down" | "unknown";

/** 单个插件探活的内部结果；reason 仅服务端排查用，绝不进入对外返回体 */
interface ProbeResult {
  status: "ok" | "down";
  latencyMs: number;
  toolCount?: number;
  reason?: string;
}

/** MCP tools/list JSON-RPC 响应（只关心 result.tools） */
interface McpToolsListResponse {
  result?: { tools?: unknown };
}

// ─── MCP 探活 ───

/**
 * 探测单个插件的 MCP tools/list；任何异常都被捕获并转成结构化结果。
 * - 请求头带 Accept: application/json, text/event-stream（Streamable HTTP 更稳）
 * - tokenEnvKey 已配置且对应环境变量有值时，附 Authorization: Bearer <token>；
 *   未配置或 env 无值则不带鉴权头
 * - result.tools 为数组 → status="ok" + toolCount；HTTP 非 2xx / 超时 /
 *   JSON 解析失败 → status="down" + reason
 */
async function probePlugin(plugin: Plugin): Promise<ProbeResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const token = plugin.tokenEnvKey ? process.env[plugin.tokenEnvKey] : undefined;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const start = Date.now();
  try {
    const resp = await fetch(plugin.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return { status: "down", latencyMs, reason: `HTTP ${resp.status}` };
    }
    let body: McpToolsListResponse;
    try {
      body = (await resp.json()) as McpToolsListResponse;
    } catch {
      return { status: "down", latencyMs, reason: "invalid JSON" };
    }
    if (Array.isArray(body?.result?.tools)) {
      return { status: "ok", latencyMs, toolCount: body.result.tools.length };
    }
    return { status: "down", latencyMs, reason: "missing result.tools" };
  } catch (e) {
    return {
      status: "down",
      latencyMs: Date.now() - start,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 把探活结果映射成对外字段（严格契约形态；丢弃内部 reason，绝不带 url / tokenEnvKey） */
function toPublicFields(plugin: Plugin, probe: ProbeResult | undefined) {
  return {
    key: plugin.key,
    name: plugin.name,
    description: plugin.description,
    enabled: plugin.enabled,
    status: (probe?.status ?? "unknown") as PluginStatus,
    ...(probe?.latencyMs !== undefined ? { latencyMs: probe.latencyMs } : {}),
    ...(probe?.toolCount !== undefined ? { toolCount: probe.toolCount } : {}),
  };
}

// ─── 路由 ───

export const pluginCenterRouter = createRouter({
  /** 插件清单：并发探活启用中的插件，单个失败只影响自身 */
  list: userQuery.query(async () => {
    const rows = await getDb().select().from(plugins);
    const enabledRows = rows.filter((r) => r.enabled);
    const entries = await Promise.all(
      enabledRows.map(async (r) => [r.key, await probePlugin(r)] as const),
    );
    const probeMap = new Map(entries);
    return { plugins: rows.map((r) => toPublicFields(r, probeMap.get(r.key))) };
  }),

  /** 切换插件启用状态（key 不存在返回固定中文错误） */
  setEnable: adminQuery
    .input(z.object({ key: z.string().min(1).max(50), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      try {
        const existing = await getDb()
          .select({ key: plugins.key })
          .from(plugins)
          .where(eq(plugins.key, input.key))
          .limit(1);
        if (existing.length === 0) {
          return { ok: false as const, error: "插件不存在" };
        }
        await getDb().update(plugins).set({ enabled: input.enabled }).where(eq(plugins.key, input.key));
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: "更新失败，请稍后重试" };
      }
    }),

  /** 新增/更新插件注册信息（upsert；新插件默认停用，覆盖时保留原启用状态） */
  upsert: adminQuery
    .input(
      z.object({
        key: z.string().min(1).max(50),
        name: z.string().min(1).max(100),
        description: z.string().min(1).max(200),
        url: z.string().url(),
        tokenEnvKey: z.string().max(100).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        await getDb()
          .insert(plugins)
          .values({
            key: input.key,
            name: input.name,
            description: input.description,
            url: input.url,
            tokenEnvKey: input.tokenEnvKey ?? null,
          })
          .onConflictDoUpdate({
            target: plugins.key,
            set: {
              name: input.name,
              description: input.description,
              url: input.url,
              tokenEnvKey: input.tokenEnvKey ?? null,
              updatedAt: new Date(),
            },
          });
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: "保存失败，请稍后重试" };
      }
    }),

  /** 删除插件（幂等：key 不存在也返回成功） */
  remove: adminQuery
    .input(z.object({ key: z.string().min(1).max(50) }))
    .mutation(async ({ input }) => {
      try {
        await getDb().delete(plugins).where(eq(plugins.key, input.key));
        return { ok: true as const };
      } catch {
        return { ok: false as const, error: "删除失败，请稍后重试" };
      }
    }),
});
