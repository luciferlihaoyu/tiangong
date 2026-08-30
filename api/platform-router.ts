/**
 * 平台注册 + 健康聚合路由（P1-1：天宫升级为统一主平台的地基）
 *
 * - registry: 返回全平台服务注册清单（天宫自身 + 北斗 + 璇玑 + 天枢 + AList），
 *   各服务 base url 从环境变量读取（BEIDOU_BASE_URL / XUANJI_BASE_URL /
 *   TIANSHU_BASE_URL / ALIST_BASE_URL），未配置则留空字符串。
 * - health.all: 并发探活全平台；单个服务失败只影响自身结果，不拖垮整体。
 *   外部请求一律 fetch + AbortSignal.timeout，异常全部捕获转成结构化
 *   { ok: false, reason }，绝不向上抛崩。
 */
import { createRouter, userQuery } from "./middleware";

// ─── 类型定义 ───

/** 平台服务注册项 */
export interface PlatformService {
  key: string;
  label: string;
  url: string;
  healthPath?: string;
  kind: "self" | "app" | "gateway" | "storage";
}

/** 单个服务的健康探测结果 */
export interface ServiceHealth {
  ok: boolean;
  latencyMs?: number;
  db?: boolean | null;
  reason?: string;
}

/** /health 响应体（兼容 db / dbConnected 两种字段名） */
interface HealthBody {
  ok?: unknown;
  db?: unknown;
  dbConnected?: unknown;
}

// ─── 服务注册表 ───

/** 去掉 url 尾部斜杠（与 tianshu-router 一致） */
function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** 全平台服务清单：url 来自环境变量，未配置则为空字符串 */
export function getPlatformServices(): PlatformService[] {
  return [
    { key: "tiangong", label: "天宫", url: "", healthPath: "/health", kind: "self" },
    { key: "beidou", label: "北斗", url: stripTrailingSlash(process.env.BEIDOU_BASE_URL || ""), healthPath: "/health", kind: "app" },
    { key: "xuanji", label: "璇玑", url: stripTrailingSlash(process.env.XUANJI_BASE_URL || ""), healthPath: "/health", kind: "app" },
    { key: "tianshu", label: "天枢", url: stripTrailingSlash(process.env.TIANSHU_BASE_URL || ""), kind: "gateway" },
    { key: "alist", label: "AList", url: stripTrailingSlash(process.env.ALIST_BASE_URL || ""), kind: "storage" },
  ];
}

// ─── 健康探测 ───

/**
 * 探测单个服务健康状态；任何异常都被捕获并转成 { ok: false, reason }。
 * - self（天宫自身）：同进程，不发起外部请求，能响应即健康。
 * - app（北斗/璇玑）：要求 HTTP 2xx 且 JSON body 中 ok === true；尽量解析 db。
 * - gateway / storage（天枢/AList）：尽力探测 base 地址，HTTP 2xx 即视为健康。
 */
async function probeHealth(service: PlatformService): Promise<ServiceHealth> {
  if (service.kind === "self") {
    return { ok: true };
  }

  const base = service.url;
  if (!base) {
    return { ok: false, reason: "not configured" };
  }

  const healthUrl = service.healthPath ? `${base}${service.healthPath}` : base;
  const start = Date.now();
  try {
    const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
    const latencyMs = Date.now() - start;
    if (!resp.ok) {
      return { ok: false, latencyMs, reason: `HTTP ${resp.status}` };
    }

    // gateway / storage：尽力探测，2xx 即健康（不强制 JSON 结构）
    if (service.kind === "gateway" || service.kind === "storage") {
      return { ok: true, latencyMs };
    }

    // app（beidou / xuanji）：要求 JSON 中 ok === true，并尽量解析 db 状态
    let body: HealthBody;
    try {
      body = (await resp.json()) as HealthBody;
    } catch {
      return { ok: false, latencyMs, reason: "invalid health JSON" };
    }
    const isOk = body?.ok === true;
    return {
      ok: isOk,
      latencyMs,
      db:
        typeof body?.db === "boolean"
          ? body.db
          : typeof body?.dbConnected === "boolean"
            ? body.dbConnected
            : null,
      ...(isOk ? {} : { reason: "health payload ok !== true" }),
    };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── 路由 ───

export const platformRouter = createRouter({
  /** 平台服务注册清单 */
  registry: userQuery.query(async () => getPlatformServices()),

  /** 全平台健康聚合：并发探活，单个失败不拖垮整体 */
  health: createRouter({
    all: userQuery.query(async () => {
      const services = getPlatformServices();
      const entries = await Promise.all(
        services.map(async (svc) => [svc.key, await probeHealth(svc)] as const),
      );
      const results: Record<string, ServiceHealth> = Object.fromEntries(entries);
      return { results, ts: Date.now() };
    }),
  }),
});
