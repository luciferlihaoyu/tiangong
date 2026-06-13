import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { HttpBindings } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "./router";
import { createContext } from "./middleware";
import { createMcpApp } from "./mcp/transport";
import { env } from "./lib/env";
import { autoMigrate } from "./lib/auto-migrate";
import { migrateV2 } from "./lib/migrate-v2";
import { serveStaticFiles } from "./lib/vite";
import { wsManager } from "./ws-manager";
import { verifyMcpKey } from "./mcp/auth";
import { getDb } from "./queries/connection";
import { taskRunner } from "./lib/task-runner";
import { agents, messages } from "@db/schema";
import { eq, and, asc } from "drizzle-orm";

const app = new Hono<{ Bindings: HttpBindings }>();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });


app.use(bodyLimit({ maxSize: 50 * 1024 * 1024 }));

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

// P7: Runner 状态诊断端点（不泄露 secrets/command/args/token 内容）
app.get("/api/runner/status", (c) => {
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
      consecutiveErrors: s.consecutiveErrors,
    },
    timestamp: new Date().toISOString(),
  });
});

// Admin migration endpoint
app.get("/api/admin/migrate", async (c) => {
  const force = c.req.query("force") === "1";
  const results: string[] = [];
  results.push(`DATABASE_URL: ${env.databaseUrl ? "SET (" + env.databaseUrl.substring(0, 20) + "...)" : "NOT SET"}`);
  results.push(`force: ${force}`);
  const amLogs = await autoMigrate(force);
  results.push(...amLogs);
  const mvLogs = await migrateV2(force);
  results.push(...mvLogs);
  return c.json({ ok: true, results });
});

// WebSocket 诊断端点（HTTP）
app.get("/api/ws/status", (c) => {
  return c.json({
    ok: true,
    websocket: "enabled",
    onlineAgents: wsManager.getOnlineAgents(),
    timestamp: new Date().toISOString(),
  });
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

            // 标记这些消息为 delivered
            for (const msg of unreadMessages) {
              await db
                .update(messages)
                .set({ status: "delivered" })
                .where(eq(messages.id, msg.id));
            }

            console.log(
              `[WS] Pushed ${unreadMessages.length} offline messages to Agent ${agentId}`
            );
          }
        } catch (e: any) {
          console.warn(`[WS] Failed to push offline messages: ${e.message}`);
        }

        // 通知 Dashboard：Agent 上线
        wsManager.broadcastToDashboard({
          type: "agent_status",
          agentId,
          status: "online",
          timestamp: new Date().toISOString(),
        });
      } catch (e: any) {
        console.error(`[WS] onOpen error for Agent ${agentId}:`, e.message);
      }
    },

    onMessage: async (_evt, ws) => {
      let data: any;
      try {
        data = JSON.parse(_evt.data as string);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      // 心跳处理
      if (data.type === "ping") {
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
      console.log(`[WS] Agent ${agentId} sent:`, data.type || "unknown");
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
      } catch (e: any) {
        console.error(`[WS] onClose error for Agent ${agentId}:`, e.message);
      }
    },

    onError: (_evt) => {
      console.error(`[WS] Error for Agent ${agentId}:`, _evt);
    },
  });
});

/**
 * Dashboard 实时推送端点
 * GET /ws/dashboard
 * 无需认证，注册为 Dashboard 客户端，接收实时事件推送。
 */
app.get("/ws/dashboard", async (c) => {
  return upgradeWebSocket(c, {
    onOpen: (_evt, ws) => {
      wsManager.registerDashboard(ws);
      console.log("[WS] Dashboard client connected");

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
      let data: any;
      try {
        data = JSON.parse(_evt.data as string);
      } catch {
        return;
      }

      if (data.type === "ping") {
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

  // Auto-create tables on startup
  try {
    await autoMigrate();
  } catch (e: any) {
    console.warn("Auto-migration failed:", e.message);
  }

  // V2 migration — add new columns to existing tables
  try {
    await migrateV2();
  } catch (e: any) {
    console.warn("V2 migration failed:", e.message);
  }

  // P5: Start Task Runner
  try {
    taskRunner.start();
    console.log("[Boot] Task Runner started");
  } catch (e: any) {
    console.warn("[Boot] Task Runner start failed:", e.message);
  }

  const port = parseInt(process.env.PORT || "3000");
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
  injectWebSocket(server);
}
