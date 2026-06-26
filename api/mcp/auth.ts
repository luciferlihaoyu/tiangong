/**
 * MCP 安全层 — API Key 认证 + 速率限制 + 审计日志
 * Task 1: MCP API Key authentication middleware
 */

import { getDb } from "../queries/connection";
import { mcpApiKeys, mcpAuditLog, agents } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { _globalApiKeys } from "../middleware";

// ─── In-memory rate limit (per key, per second) ───
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, maxPerSecond: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 1000 });
    return true;
  }
  if (entry.count >= maxPerSecond) return false;
  entry.count++;
  return true;
}

// ─── Auth result ───
export interface McpAuthResult {
  valid: boolean;
  apiKey?: typeof mcpApiKeys.$inferSelect;
  agent?: typeof agents.$inferSelect;
  error?: string;
  statusCode?: number;
}

/**
 * Verify an MCP API key from request header or query param.
 * Checks:
 * 1. Key exists and is active
 * 2. Rate limit not exceeded
 * 3. Returns associated agent + permissions
 */
export async function verifyMcpKey(key: string): Promise<McpAuthResult> {
  if (!key || typeof key !== "string" || key.length < 16) {
    return { valid: false, error: "缺少或无效的 API Key", statusCode: 401 };
  }

  // Fast path: check global API key set (loaded from DB + env + secrets by middleware)
  if (_globalApiKeys.has(key)) {
    // Still try to get agent info from mcp_api_keys table
    try {
      const db = getDb();
      const rows = await db
        .select()
        .from(mcpApiKeys)
        .where(eq(mcpApiKeys.key, key));
      const apiKey = rows[0];
      let agent: typeof agents.$inferSelect | undefined;
      if (apiKey?.agentId) {
        const agentRows = await db.select().from(agents).where(eq(agents.id, apiKey.agentId));
        agent = agentRows[0];
      }
      return { valid: true, apiKey: apiKey as any, agent };
    } catch {
      // DB lookup failed but key is in global set — still valid
      return { valid: true };
    }
  }

  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(mcpApiKeys)
      .where(eq(mcpApiKeys.key, key));

    const apiKey = rows[0];
    if (!apiKey) {
      return { valid: false, error: "API Key 不存在", statusCode: 401 };
    }

    if (apiKey.active !== "true") {
      return { valid: false, error: "API Key 已被撤销", statusCode: 403 };
    }

    // Rate limit check
    const maxRate = apiKey.rateLimit ?? 10;
    if (!checkRateLimit(key, maxRate)) {
      return { valid: false, error: "请求频率超限", statusCode: 429 };
    }

    // Update lastUsedAt (fire and forget, don't block)
    db.update(mcpApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(mcpApiKeys.id, apiKey.id))
      .catch(() => {});

    // Get associated agent
    let agent: typeof agents.$inferSelect | undefined;
    if (apiKey.agentId) {
      const agentRows = await db
        .select()
        .from(agents)
        .where(eq(agents.id, apiKey.agentId));
      agent = agentRows[0];
    }

    return { valid: true, apiKey, agent };
  } catch (err: any) {
    return { valid: false, error: "认证服务异常: " + (err.message || "未知错误"), statusCode: 500 };
  }
}

/**
 * Extract API key from request.
 * Checks in order: Authorization header → X-API-Key header → query param
 */
export function extractApiKey(req: Request): string | null {
  // 1. Authorization: Bearer <key>
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }

  // 2. X-API-Key header
  const xKey = req.headers.get("x-api-key");
  if (xKey) return xKey.trim();

  // 3. Query param ?api_key=
  const url = new URL(req.url);
  const qKey = url.searchParams.get("api_key");
  if (qKey) return qKey.trim();

  return null;
}

/**
 * Write an audit log entry (fire and forget).
 * Only logs a summary, not full params for security.
 */
export function writeAuditLog(params: {
  keyId: number;
  tool: string;
  params: string;
  result: "success" | "error";
  error?: string;
  durationMs: number;
}) {
  const db = getDb();
  db.insert(mcpAuditLog)
    .values({
      keyId: params.keyId,
      tool: params.tool,
      params: params.params.slice(0, 500),
      result: params.result,
      error: params.error?.slice(0, 1024) ?? null,
      durationMs: params.durationMs,
    })
    .catch(() => {}); // Never block on audit failures
}
