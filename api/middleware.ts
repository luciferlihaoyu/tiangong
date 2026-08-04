import { initTRPC, TRPCError } from "@trpc/server";
import { verifyToken } from "./local-auth-router";
import { readFileSync } from "node:fs";
import { verifyMcpKey } from "./mcp/auth";

// ─── API Key validation ───
// Global token set populated by boot.ts on startup
export const _globalApiKeys = new Set<string>();

function loadEnvKeys(): Set<string> {
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

  return keys;
}

let _envKeys: Set<string> | null = null;

type ApiKeyResolution = {
  readonly valid: boolean;
  readonly boundAgentId: number | null;
};

async function verifyApiKey(headerValue: string | null): Promise<ApiKeyResolution> {
  if (!headerValue) return { valid: false, boundAgentId: null };
  const val = headerValue.trim();
  // Check env-based keys
  if (!_envKeys) _envKeys = loadEnvKeys();
  if (_envKeys.has(val)) return { valid: true, boundAgentId: null };
  // Check DB-based keys (populated by boot.ts)
  if (_globalApiKeys.has(val)) return { valid: true, boundAgentId: null };

  const mcpAuth = await verifyMcpKey(val);
  if (!mcpAuth.valid) return { valid: false, boundAgentId: null };
  return { valid: true, boundAgentId: mcpAuth.apiKey?.agentId ?? null };
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
  const apiKeyResolution = await verifyApiKey(apiKey);
  if (apiKeyResolution.valid) {
    apiKeyAgentId = apiKeyResolution.boundAgentId ?? -1;
  }

  return { req: opts.req, user, apiKeyAgentId };
}

type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return {
      code: shape.code,
      message: shape.message,
      data: {
        code: shape.code,
        httpStatus: shape.data?.httpStatus,
        path: shape.data?.path,
        stack: process.env.NODE_ENV === "development" ? shape.data?.stack : undefined,
      },
    };
  },
});

export const router = t.router;
export const createRouter = router;
export const publicProcedure = t.procedure;
export const createCallerFactory = t.createCallerFactory;

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
