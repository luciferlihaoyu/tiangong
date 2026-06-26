import { initTRPC, TRPCError } from "@trpc/server";
import { verifyToken } from "./local-auth-router";
import { readFileSync } from "node:fs";
import { getDb } from "./queries/connection";
import { agents } from "@db/schema";
import { eq, isNotNull, ne } from "drizzle-orm";

// ─── API Key validation ───
let _cachedApiKeys: Set<string> | null = null;
let _cachedAt = 0;
const CACHE_TTL_MS = 60_000;

async function loadApiKeys(): Promise<Set<string>> {
  const now = Date.now();
  if (_cachedApiKeys && now - _cachedAt < CACHE_TTL_MS) return _cachedApiKeys;

  const keys = new Set<string>();

  // 1. Fixed API key from env
  const envKey = process.env.TIANGONG_API_KEY;
  if (envKey) keys.add(envKey.trim());

  // 2. Per-agent MCP keys from env (TIANGONG_<NAME>_MCP_KEY)
  for (const [envName, envVal] of Object.entries(process.env)) {
    if (envName.startsWith("TIANGONG_") && envName.endsWith("_MCP_KEY") && envVal) {
      keys.add(envVal.trim());
    }
  }

  // 3. MCP keys from secrets file (local/dev only)
  try {
    const secretsPath = "/home/node/.openclaw/secrets/tiangong-openclaw-agents.json";
    const raw = readFileSync(secretsPath, "utf-8");
    const data = JSON.parse(raw);
    const agentList = Array.isArray(data) ? data : data.agents || [];
    for (const agent of agentList) {
      if (agent.token) keys.add(String(agent.token).trim());
    }
  } catch {
    // secrets file may not exist in all environments
  }

  // 4. MCP tokens from database via Drizzle ORM (same connection as rest of app)
  try {
    const db = getDb();
    const rows = await db
      .select({ mcpToken: agents.mcpToken })
      .from(agents)
      .where(isNotNull(agents.mcpToken));
    for (const row of rows) {
      if (row.mcpToken && row.mcpToken.trim()) keys.add(row.mcpToken.trim());
    }
  } catch (e) {
    // DB may not be ready yet
    console.warn("loadApiKeys: DB read failed:", (e as Error).message?.slice(0, 100));
  }

  _cachedApiKeys = keys;
  _cachedAt = now;
  return keys;
}

async function verifyApiKey(headerValue: string | null): Promise<boolean> {
  if (!headerValue) return false;
  const keys = await loadApiKeys();
  return keys.has(headerValue.trim());
}

// Context for each request
export async function createContext(opts: { req: Request }) {
  let user: { id: number; role: string } | null = null;
  let apiKeyAgentId: number | null = null;

  // Try to get user from Bearer token
  const authHeader = opts.req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const payload = await verifyToken(authHeader.slice(7));
    if (payload) {
      user = { id: Number(payload.sub), role: payload.role };
    }
  }

  // Try API key from x-api-key or x-mcp-key
  const apiKey = opts.req.headers.get("x-api-key") || opts.req.headers.get("x-mcp-key");
  if (apiKey && await verifyApiKey(apiKey)) {
    apiKeyAgentId = -1; // marker for valid API key (no specific agent)
  }

  return { req: opts.req, user, apiKeyAgentId };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const createRouter = router;
export const publicProcedure = t.procedure;

// Public query - no auth required
export const publicQuery = publicProcedure;

// Authed query - requires login (Bearer token) OR valid API key (x-api-key / x-mcp-key)
export const authedQuery = publicProcedure.use(async ({ ctx, next }) => {
  const hasUser = !!ctx.user;
  const hasApiKey = ctx.apiKeyAgentId !== null;
  if (!hasUser && !hasApiKey) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录或提供有效的 API Key" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

// User-only query - requires login (Bearer token)
export const userQuery = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

// Admin query - requires admin role
export const adminQuery = publicProcedure.use(async ({ ctx, next }) => {
  const hasUser = !!ctx.user;
  const hasApiKey = ctx.apiKeyAgentId !== null;
  if (!hasUser && !hasApiKey) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录或提供有效的 API Key" });
  }
  if (ctx.user && ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN", message: "需要管理员权限" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});
