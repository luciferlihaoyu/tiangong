import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext, _globalApiKeys } from "./middleware";
import { createMcpApp } from "./mcp/transport";
import { env } from "./lib/env";
import { verifyToken } from "./local-auth-router";
import { getSsoJwks } from "./lib/sso-signing";
import { autoMigrate } from "./lib/auto-migrate";
import { migrateV2 } from "./lib/migrate-v2";
import { bootstrapMysqlImport } from "./lib/bootstrap-mysql-import";
import { serveStaticFiles } from "./lib/vite";
import { wsManager } from "./ws-manager";
import { verifyMcpKey } from "./mcp/auth";
import { wsTicketStore, isAllowedWsOrigin, WS_TICKET_TTL_MS } from "./lib/ws-ticket";
import { getDb } from "./queries/connection";
import { taskRunner } from "./lib/task-runner";
import { sweeperScheduler } from "./lib/sweepers/scheduler";
import { taskOutboxDispatcher } from "./lib/task-outbox";
import { getReadiness, readiness } from "./lib/readiness";
import { ArtifactVolume } from "./lib/artifacts/artifact-volume";
import { agents, messages } from "@db/schema";
import { ensureAssistantAgent } from "./lib/ai-assistant";
import { eq, and, asc, isNotNull, ne } from "drizzle-orm";

const app = new Hono<{ Bindings: HttpBindings }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const artifactGenerationId = Number(env.artifactGenerationId);
if (!env.artifactVolumeId || !Number.isSafeInteger(artifactGenerationId) || artifactGenerationId < 1) {
  throw new Error("mount_validation_failed: TIANGONG_ARTIFACT_VOLUME_ID and positive generation are required");
}
await new ArtifactVolume({ root: env.artifactRoot, volumeId: env.artifactVolumeId, generationId: artifactGenerationId }).probe();


app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

// ─── Security headers ───
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Referrer-Policy", "no-referrer");
  c.res.headers.set("X-XSS-Protection", "1; mode=block");
  c.res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

// ─── Auth helper for raw Hono routes ───
async function requireAdmin(c: Context): Promise<boolean> {
  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const payload = await verifyToken(authHeader.slice(7));
  return !!payload && payload.role === "admin";
}

// MCP HTTP Routes (before tRPC to avoid wildcard conflicts)
app.route("/mcp", createMcpApp());

// tRPC handler
app.use("/api/trpc/*", async (c) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: ({ req }) => createContext({ req }),
  });
});

// ========== 统一健康检查端点（P0-3）==========
// 与北斗/璇玑一致：GET /health → {ok, name, db}。getDb() 打开 SQLite 连接，
// 失败（路径/卷异常）则 db=false 并返回 503。
// 注意 liveness 与 readiness 的分工（Phase B §2）：/health 是 liveness——
// 只回答"进程还活着吗、库能开吗"，不就绪**不**返回 503（那会让编排层重启容器，
// 反而把故障放大）。"能不能接单"看 /ready 与下面的 ready 字段。
const healthStartTime = Date.now();
app.get("/health", (c) => {
  const readiness = getReadiness();
  try {
    getDb();
    return c.json({
      ok: true,
      name: "tiangong",
      db: true,
      ready: readiness.ready,
      reasons: readiness.reasons,
      uptime: Math.floor((Date.now() - healthStartTime) / 1000),
    });
  } catch {
    return c.json(
      {
        ok: true,
        name: "tiangong",
        db: false,
        ready: false,
        reasons: readiness.reasons,
        uptime: Math.floor((Date.now() - healthStartTime) / 1000),
      },
      503
    );
  }
});

// Phase B §2：就绪探针。不就绪返回 503 + 可读原因（迁移/schema 对齐/执行器/派发）。
// 与 /health 的区别：这里 503 表示"别给我派活"，不是"进程挂了"。
app.get("/ready", (c) => {
  const readiness = getReadiness();
  return c.json(
    {
      ready: readiness.ready,
      checks: readiness.checks,
      reasons: readiness.reasons,
      degraded: readiness.degraded,
    },
    readiness.ready ? 200 : 503
  );
});

// P11.4: 版本信息端点（读取部署环境变量或构建时注入的 commit，无运行时 .git 依赖）
app.get("/api/version", async (c) => {
  let buildMeta: Record<string, string | null> = {};
  try {
    const commitMod = await import('./commit.js');
    buildMeta = commitMod.BUILD_META ?? {};
  } catch {
    buildMeta = {};
  }

  let sha: string | null = null;
  let shortCommit: string | null = null;
  let branch: string | null = null;
  let source = "unknown";

  const envSha =
    process.env.COMMIT_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.SOURCE_COMMIT ||
    process.env.ZBPACK_COMMIT_SHA ||
    null;

  if (envSha) {
    sha = envSha;
    shortCommit = envSha.slice(0, 7);
    source = "env";
  } else if (buildMeta.commit && buildMeta.commit !== "unknown") {
    sha = buildMeta.commit;
    shortCommit = buildMeta.shortCommit;
    branch = buildMeta.branch;
    source = "build";
  }

  let buildTime = process.env.BUILD_TIME || process.env.VERCEL_BUILD_TIME || buildMeta.buildTime || null;
  if (!buildTime) {
    // Generate a build timestamp if not provided
    buildTime = new Date().toISOString();
  }

  return c.json({
    ok: true,
    version: process.env.npm_package_version || "0.0.0",
    commit: sha,
    shortCommit: shortCommit ?? (sha ? sha.slice(0, 7) : null),
    branch: branch ?? "unknown",
    buildTime,
    deployedAt: process.env.DEPLOYED_AT || process.env.ZEABUR_DEPLOY_TIME || null,
    source,
    timestamp: new Date().toISOString(),
  });
});

// P1-3 协议 v2：SSO 联邦认证 JWKS 公开端点 —— 璇玑/北斗等接收端在此拉取
// Ed25519 验签公钥（见 api/lib/sso-signing.ts）。匿名可访问：boot.ts 裸路由
// 默认公开（须注册在下方 /api/* 404 兜底之前）；GET 无 CSRF 风险；
// 响应只含公钥材料（kty/crv/x/kid/alg/use），绝无私钥。
// Cache-Control：允许接收端/CDN 短缓存（5 分钟），降低轮换窗口外的重复拉取。
app.get("/api/sso/jwks.json", (c) =>
  c.json(getSsoJwks(), 200, { "Cache-Control": "public, max-age=300" }),
);

// P7: Runner 状态诊断端点（需要管理员认证，不泄露 secrets/command/args/token 内容）
app.get("/api/runner/status", async (c) => {
  const isAdmin = await requireAdmin(c);
  if (!isAdmin) {
    return c.json({ error: "需要管理员权限" }, 401);
  }
  const s = taskRunner.status;
  return c.json({
    ok: true,
    runner: {
      enabled: s.enabled,
      mode: s.mode,
      intervalMs: s.intervalMs,
      batchSize: s.batchSize,
      running: s.running,
      // P5 legacy
      commandConfigured: s.commandConfigured,
      // P6: new fields
      execMode: s.execMode,
      execFileConfigured: s.execFileConfigured,
      execArgsConfigured: s.execArgsConfigured,
      execArgsValid: s.execArgsValid,
      execArgsCount: s.execArgsCount,
      legacyCommandConfigured: s.legacyCommandConfigured,
      // P7: safe Gateway runner diagnostics
      gatewayConfigured: s.gatewayConfigured,
      gatewayUrlConfigured: s.gatewayUrlConfigured,
      gatewayUrlHost: s.gatewayUrlHost,
      gatewayTokenConfigured: s.gatewayTokenConfigured,
      gatewayAgent: s.gatewayAgent,
      gatewayModelConfigured: s.gatewayModelConfigured,
      gatewaySessionPrefixConfigured: s.gatewaySessionPrefixConfigured,
      // 天枢 safe diagnostics
      tianshuConfigured: s.tianshuConfigured,
      tianshuBaseUrlHost: s.tianshuBaseUrlHost,
      tianshuModelConfigured: s.tianshuModelConfigured,
      consecutiveErrors: s.consecutiveErrors,
    },
    timestamp: new Date().toISOString(),
  });
});

// Admin migration endpoint (requires admin auth)
app.get("/api/admin/migrate", async (c) => {
  const isAdmin = await requireAdmin(c);
  if (!isAdmin) {
    return c.json({ error: "需要管理员权限" }, 401);
  }
  const force = c.req.query("force") === "1";
  const results: string[] = [];
  results.push(`force: ${force}`);
  const amLogs = await autoMigrate(force);
  results.push(...amLogs);
  const mvLogs = await migrateV2(force);
  results.push(...mvLogs);
  return c.json({ ok: true, results });
});

// Debug: check API key loading
app.get("/api/admin/debug-keys", async (c) => {
  const isAdmin = await requireAdmin(c);
  if (!isAdmin) {
    return c.json({ error: "需要管理员权限" }, 401);
  }
  const results: Record<string, unknown> = {};
  results.envDatabaseUrl = !!process.env.DATABASE_URL;
  results.envTiangongApiKey = !!process.env.TIANGONG_API_KEY;
  results.envMcpKeys = Object.keys(process.env).filter(k => k.startsWith("TIANGONG_") && k.endsWith("_MCP_KEY"));
  // Check global key set
  try {
    results.globalKeyCount = _globalApiKeys.size;
    results.globalKeyPrefixes = Array.from(_globalApiKeys).map(k => k.slice(0, 10));
  } catch (e: unknown) {
    results.globalKeyError = e instanceof Error ? e.message : String(e);
  }
  return c.json(results);
});

// WebSocket 诊断端点（HTTP，需要管理员认证）
app.get("/api/ws/status", async (c) => {
  const isAdmin = await requireAdmin(c);
  if (!isAdmin) {
    return c.json({ error: "需要管理员权限" }, 401);
  }
  return c.json({
    ok: true,
    websocket: "enabled",
    onlineAgents: wsManager.getOnlineAgents(),
    timestamp: new Date().toISOString(),
  });
});

// 用 JWT 换一次性 WS ticket。浏览器原生 WebSocket 不能设自定义头，
// dashboard 握手只能把凭据放 query，所以先发短期 ticket 再带上连接。
// 只认 JWT 不认 Agent Key：dashboard 广播面向登录用户，不给 agent 身份。
app.get("/api/ws-ticket", async (c) => {
  const authHeader = c.req.header("authorization");
  const payload = authHeader?.startsWith("Bearer ")
    ? await verifyToken(authHeader.slice(7))
    : null;
  if (!payload) {
    return c.json({ error: "请先登录" }, 401);
  }
  const ticket = wsTicketStore.issue({
    userId: parseInt(payload.sub, 10),
    role: payload.role,
  });
  return c.json({ ticket, expiresIn: WS_TICKET_TTL_MS / 1000 });
});

app.all("/api/*", (c) => c.json({ error: "Not Found" }, 404));

// ═══════════════════════════════════════════════════════════════
//  WebSocket 端点
// ═══════════════════════════════════════════════════════════════

/**
 * Agent WebSocket 连接端点
 * GET /ws?agentId=X&token=***
 *
 * 流程：
 * 1. 验证 token（复用 MCP Key 验证逻辑）
 * 2. 连接成功后更新 Agent 状态为 online，更新 lastHeartbeat
 * 3. 推送离线期间未读消息
 * 4. 心跳：客户端发 {"type":"ping"} → 回复 {"type":"pong"}
 * 5. 断开时更新 Agent 状态为 idle
 */
app.get("/ws", async (c) => {
  const agentIdStr = c.req.query("agentId");
  const token = c.req.query("token");

  if (!agentIdStr || !token) {
    return c.json({ error: "缺少 agentId 或 token 参数" }, 400);
  }

  const agentId = parseInt(agentIdStr, 10);
  if (isNaN(agentId)) {
    return c.json({ error: "agentId 必须是数字" }, 400);
  }

  // 验证 token
  const authResult = await verifyMcpKey(token);
  if (!authResult.valid) {
    return new Response(JSON.stringify({ error: authResult.error || "认证失败" }), {
      status: authResult.statusCode || 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 验证 token 关联的 agent 与请求的 agentId 一致
  if (authResult.agent && authResult.agent.id !== agentId) {
    return c.json({ error: "Token 与 Agent 不匹配" }, 403);
  }

  const db = getDb();

  // 升级到 WebSocket
  return upgradeWebSocket(c, {
    onOpen: async (_evt, ws) => {
      try {
        // 注册连接
        wsManager.connect(agentId, ws);

        // 更新 Agent 状态为 online，更新 lastHeartbeat
        await db
          .update(agents)
          .set({ status: "online", lastHeartbeat: new Date() })
          .where(eq(agents.id, agentId));

        console.log(`[WS] Agent ${agentId} connected`);

        // 推送离线期间未读消息（status='sent' 且 toAgent=该Agent）
        try {
          const unreadMessages = await db
            .select()
            .from(messages)
            .where(
              and(
                eq(messages.toAgent, agentId),
                eq(messages.status, "sent")
              )
            )
            .orderBy(asc(messages.createdAt))
            .limit(100);

          if (unreadMessages.length > 0) {
            ws.send(
              JSON.stringify({
                type: "offline_messages",
                messages: unreadMessages,
                count: unreadMessages.length,
              })
            );

            // 标记这些消息为 delivered，同时记录 deliveredAt
            const now = new Date();
            for (const msg of unreadMessages) {
              await db
                .update(messages)
                .set({ status: "delivered", deliveredAt: now })
                .where(eq(messages.id, msg.id));
            }

            console.log(
              `[WS] Pushed ${unreadMessages.length} offline messages to Agent ${agentId}`
            );
          }
        } catch (e: unknown) {
          console.warn(`[WS] Failed to push offline messages: ${e instanceof Error ? e.message : String(e)}`);
        }

        // 通知 Dashboard：Agent 上线
        wsManager.broadcastToDashboard({
          type: "agent_status",
          agentId,
          status: "online",
          timestamp: new Date().toISOString(),
        });
      } catch (e: unknown) {
        console.error(`[WS] onOpen error for Agent ${agentId}:`, e instanceof Error ? e.message : String(e));
      }
    },

    onMessage: async (_evt, ws) => {
      let data: unknown;
      try {
        data = JSON.parse(_evt.data as string);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      // 心跳处理
      if (typeof data === "object" && data !== null && (data as Record<string, unknown>).type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));

        // 更新 lastHeartbeat
        try {
          await db
            .update(agents)
            .set({ lastHeartbeat: new Date() })
            .where(eq(agents.id, agentId));
        } catch {}
        return;
      }

      // 其他消息类型可以在这里扩展
      console.log(`[WS] Agent ${agentId} sent:`, (typeof data === "object" && data !== null ? (data as Record<string, unknown>).type : undefined) || "unknown");
    },

    onClose: async (_evt, ws) => {
      try {
        // 从连接管理器中移除当前 WebSocket 连接
        wsManager.disconnect(agentId, ws);

        // 如果该 Agent 没有其他连接了，更新状态为 idle
        if (!wsManager.isOnline(agentId)) {
          await db
            .update(agents)
            .set({ status: "idle" })
            .where(eq(agents.id, agentId));

          // 通知 Dashboard：Agent 下线
          wsManager.broadcastToDashboard({
            type: "agent_status",
            agentId,
            status: "idle",
            timestamp: new Date().toISOString(),
          });
        }

        console.log(`[WS] Agent ${agentId} disconnected`);
      } catch (e: unknown) {
        console.error(`[WS] onClose error for Agent ${agentId}:`, e instanceof Error ? e.message : String(e));
      }
    },

    onError: (_evt) => {
      console.error(`[WS] Error for Agent ${agentId}:`, _evt);
    },
  });
});

/**
 * Dashboard 实时推送端点
 * GET /ws/dashboard?ticket=***
 * 与 /ws（Agent 端点）同形态：先鉴权再 upgrade——校验 Origin（防 CSWSH）
 * 和一次性 ticket（由 GET /api/ws-ticket 用 JWT 换取），拒绝在 upgrade 前完成。
 */
app.get("/ws/dashboard", async (c) => {
  // 先校验 Origin：跨站握手直接拒绝，允许清单来自环境变量（逗号分隔）。
  // 本站位于 Cloudflare/Zeabur 代理之后，Host 可能被改写，所以把两个可能承载
  // 公网域名的头都作为候选——任一命中即放行，避免把正常浏览器挡在 403 外。
  const origin = c.req.header("origin") ?? null;
  const allowList = (process.env.TIANGONG_ALLOWED_WS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const hostCandidates = [c.req.header("host"), c.req.header("x-forwarded-host")]
    .map((value) => value?.split(",")[0]?.trim() ?? null)
    .filter((value): value is string => !!value);
  const originAllowed =
    hostCandidates.length === 0
      ? isAllowedWsOrigin(origin, null, allowList)
      : hostCandidates.some((host) => isAllowedWsOrigin(origin, host, allowList));
  if (!originAllowed) {
    console.warn("[WS] dashboard handshake rejected: bad_origin");
    return c.json({ error: "来源不被允许" }, 403);
  }

  // 再消费一次性 ticket：缺失/过期/重放一律拒绝（日志不含凭据本身）
  const ticket = c.req.query("ticket");
  const ticketPayload = ticket ? wsTicketStore.consume(ticket) : null;
  if (!ticketPayload) {
    console.warn("[WS] dashboard handshake rejected: no_ticket");
    return c.json({ error: "缺少或失效的 WS 凭据" }, 401);
  }

  return upgradeWebSocket(c, {
    onOpen: (_evt, ws) => {
      wsManager.registerDashboard(ws);
      // 只记用户 id，不记 ticket/凭据本身
      console.log(`[WS] Dashboard client connected (user ${ticketPayload.userId})`);

      // 发送当前在线 Agent 列表
      ws.send(
        JSON.stringify({
          type: "online_agents",
          agentIds: wsManager.getOnlineAgents(),
          timestamp: new Date().toISOString(),
        })
      );
    },

    onMessage: (_evt, ws) => {
      // Dashboard 客户端一般只接收，不发送
      let data: unknown;
      try {
        data = JSON.parse(_evt.data as string);
      } catch {
        return;
      }

      if (typeof data === "object" && data !== null && (data as Record<string, unknown>).type === "ping") {
        ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
    },

    onClose: (_evt, ws) => {
      wsManager.unregisterDashboard(ws);
      console.log("[WS] Dashboard client disconnected");
    },

    onError: (_evt) => {
      console.error("[WS] Dashboard error:", _evt);
    },
  });
});

export default app;

if (env.isProduction) {
  serveStaticFiles(app);
}

// Auto-create tables on startup (both dev and prod)
try {
  await autoMigrate();
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn("Auto-migration failed:", msg);
  // Phase B §2：迁移失败 → 不就绪 → 不接单（而不是照常派活、等运行时才炸）
  readiness.recordMigration(false, msg);
}

// V2 migration — add new columns to existing tables
try {
  await migrateV2();
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn("V2 migration failed:", msg);
  readiness.recordMigration(false, `V2 migration: ${msg}`);
}

// MySQL → SQLite 启动自迁移（#61）：若仍配置 MySQL DSN 且 SQLite 空，全量导入。
try {
  const impLogs = await bootstrapMysqlImport();
  for (const l of impLogs) console.log(l);
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn("Bootstrap MySQL import failed (app continues):", msg);
  // 可选集成：降级而非不接单（生产已迁到原生 SQLite，此路径通常直接 skip）
  readiness.recordDegraded("mysql-import", msg);
}

// Load MCP tokens from DB into global key set for API key verification
try {
  const db = getDb();
  const rows = await db
    .select({ mcpToken: agents.mcpToken })
    .from(agents)
    .where(and(isNotNull(agents.mcpToken), ne(agents.mcpToken, "")));
  for (const row of rows) {
    if (row.mcpToken && row.mcpToken.trim()) _globalApiKeys.add(row.mcpToken.trim());
  }
  console.log(`[Boot] Loaded ${_globalApiKeys.size} MCP tokens from DB`);
} catch (e: unknown) {
  console.warn("[Boot] MCP token load from DB failed:", e instanceof Error ? e.message : String(e));
}

// 预创建「天宫助手」agent：保证消息面板左侧列表里可见（否则首次对话前用户选不到它）
try {
  const assistantId = await ensureAssistantAgent();
  console.log(`[Boot] 天宫助手 ready (id=${assistantId})`);
} catch (e: unknown) {
  console.warn("[Boot] 天宫助手预创建失败（首次发消息时会重试）:", e instanceof Error ? e.message : String(e));
}

// P5: Start Task Runner
try {
  taskRunner.start();
  console.log("[Boot] Task Runner started");
  readiness.recordExecutor(true);
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn("[Boot] Task Runner start failed:", msg);
  readiness.recordExecutor(false, msg);
}

// Start server-side maintenance sweepers (timeouts, watchdog, approval nag, memory, newapi patrol)
try {
  sweeperScheduler.start();
  console.log("[Boot] Sweeper Scheduler started");
} catch (e: unknown) {
  console.warn("[Boot] Sweeper Scheduler start failed:", e instanceof Error ? e.message : String(e));
}

try {
  taskOutboxDispatcher.start();
  console.log("[Boot] Task outbox dispatcher started");
  readiness.recordOutbox(true);
} catch (e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn("[Boot] Task outbox dispatcher start failed:", msg);
  readiness.recordOutbox(false, msg);
}

const port = parseInt(process.env.PORT || "3000");
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`Server running on http://localhost:${port}/`);
});
injectWebSocket(server);
