/**
 * 天宫 MCP HTTP Transport (Hono / Web-Standard)
 * Task 3: HTTP/SSE transport layer via WebStandardStreamableHTTPServerTransport
 *
 * 路由：
 *   POST /mcp → 处理 MCP 请求（初始化、tools/call 等）
 *   GET  /mcp → SSE 连接（server-initiated notifications）
 *   DELETE /mcp → 关闭 session
 *   GET  /mcp/health → 健康检查
 */

import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getMcpServer } from "./server";
import { verifyMcpKey, extractApiKey, writeAuditLog } from "./auth";

// ─── Session store (sessionId → transport) ───
const sessions = new Map<
  string,
  {
    transport: WebStandardStreamableHTTPServerTransport;
    apiKeyId: number;
    agentId: number | null;
  }
>();

async function getOrCreateTransport(
  sessionId: string | undefined,
  apiKeyId: number,
  agentId: number | null
): Promise<{
  transport: WebStandardStreamableHTTPServerTransport;
  sessionId: string;
  isNew: boolean;
}> {
  // Try existing session
  if (sessionId && sessions.has(sessionId)) {
    return { transport: sessions.get(sessionId)!.transport, sessionId, isNew: false };
  }

  // Create new transport + session
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () =>
      `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
  });

  const server = getMcpServer();
  await server.connect(transport);

  // The session ID is generated during initialization
  // We need to capture it after the client sends initialize
  const newSessionId = ""; // Will be set from response headers later

  return { transport, sessionId: newSessionId, isNew: true };
}

export function createMcpApp(): Hono {
  const app = new Hono();

  // ─── Health check ───
  app.get("/health", (c) => {
    return c.json({
      ok: true,
      version: "2.0.1",
      build: "4ca0e5f",
      name: "Tiangong MCP Server",
      protocol: "mcp/2025-03-26",
      capabilities: {
        tools: {},
        resources: {},
      },
    });
  });

  // ─── POST /mcp → MCP Request ───
  app.post("/", async (c) => {
    const startTime = Date.now();

    // 1. Auth
    const apiKey = extractApiKey(c.req.raw);
    if (!apiKey) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message:
              "Missing API key. Provide via Authorization: Bearer <key> or X-API-Key header.",
          },
          id: null,
        },
        401
      );
    }

    const authResult = await verifyMcpKey(apiKey);
    if (!authResult.valid) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: authResult.error || "Authentication failed",
          },
          id: null,
        },
        authResult.statusCode as 400 | 401 | 403 | 429 | 500 || 401,
      );
    }

    // 2. Determine session
    const incomingSessionId = c.req.header("mcp-session-id") || undefined;

    // For new sessions (no incoming session ID), create a new transport
    // For existing sessions, reuse the transport
    let transport: WebStandardStreamableHTTPServerTransport;
    let isNewSession = false;

    if (incomingSessionId && sessions.has(incomingSessionId)) {
      transport = sessions.get(incomingSessionId)!.transport;
    } else {
      // New transport
      transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () =>
          `tg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      });

      const server = getMcpServer();
      await server.connect(transport);

      transport.onclose = () => {
        if (incomingSessionId) sessions.delete(incomingSessionId);
        // Also clean up by value
        for (const [sid, s] of sessions) {
          if (s.transport === transport) sessions.delete(sid);
        }
      };

      isNewSession = true;
    }

    // 3. Handle the request through the transport
    try {
      // Parse request body for audit purposes
      let requestBody: any;
      try {
        requestBody = await c.req.raw.clone().json();
      } catch {
        requestBody = {};
      }

      const toolName =
        requestBody?.method === "tools/call"
          ? requestBody?.params?.name || "tools/call"
          : requestBody?.method || "unknown";

      // Delegate to the transport
      const response = await transport.handleRequest(c.req.raw);

      // Capture the session ID from response headers if this is a new session
      const responseSessionId = response.headers.get("mcp-session-id");
      if (responseSessionId && !sessions.has(responseSessionId)) {
        sessions.set(responseSessionId, {
          transport,
          apiKeyId: authResult.apiKey!.id,
          agentId: authResult.agent?.id ?? null,
        });
      }

      // 4. Audit log (fire and forget)
      const durationMs = Date.now() - startTime;
      const isError = response.status >= 400;
      let errorMsg: string | undefined;
      let paramsSummary: string;

      if (requestBody?.method === "tools/call") {
        paramsSummary = JSON.stringify({
          tool: requestBody?.params?.name,
          argKeys: requestBody?.params?.arguments
            ? Object.keys(requestBody.params.arguments)
            : [],
        });
      } else if (requestBody?.method) {
        paramsSummary = requestBody.method;
        if (requestBody?.params) {
          paramsSummary += " " + JSON.stringify(requestBody.params).slice(0, 400);
        }
      } else {
        paramsSummary = "unknown";
      }

      if (isError) {
        try {
          const errBody = await response.clone().json() as Record<string, any>;
          errorMsg = errBody?.error?.message || `HTTP ${response.status}`;
        } catch {
          errorMsg = `HTTP ${response.status}`;
        }
      }

      writeAuditLog({
        keyId: authResult.apiKey!.id,
        tool: toolName,
        params: paramsSummary.slice(0, 500),
        result: isError ? "error" : "success",
        error: errorMsg,
        durationMs,
      });

      return response;
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      writeAuditLog({
        keyId: authResult.apiKey!.id,
        tool: "transport_error",
        params: (err.message || "unknown").slice(0, 500),
        result: "error",
        error: err.message,
        durationMs,
      });

      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: err.message || "Internal server error",
          },
          id: null,
        },
        500
      );
    }
  });

  // ─── GET /mcp → SSE connection ───
  app.get("/", async (c) => {
    const apiKey = extractApiKey(c.req.raw);
    if (!apiKey) {
      return c.json({ error: "Missing API key" }, 401);
    }

    const authResult = await verifyMcpKey(apiKey);
    if (!authResult.valid) {
      return c.json({ error: authResult.error }, (authResult.statusCode || 401) as 400 | 401 | 403 | 429 | 500);
    }

    const sessionId = c.req.header("mcp-session-id");
    if (!sessionId || !sessions.has(sessionId)) {
      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message:
              "No active session. Send POST /mcp with initialize first.",
          },
          id: null,
        },
        400
      );
    }

    // Delegate GET to the transport for SSE
    try {
      const session = sessions.get(sessionId)!;
      return await session.transport.handleRequest(c.req.raw);
    } catch (err: any) {
      console.error("MCP SSE error:", err.message);
      return c.json({ error: "SSE not available" }, 500);
    }
  });

  // ─── DELETE /mcp → Close session ───
  app.delete("/", async (c) => {
    const sessionId = c.req.header("mcp-session-id");
    if (!sessionId) {
      return c.json({ error: "Missing mcp-session-id header" }, 400);
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return c.json({ error: "Session not found" }, 404);
    }

    try {
      await session.transport.close();
    } catch {
      // Ignore close errors
    }
    sessions.delete(sessionId);

    return c.json({ ok: true, message: "Session closed" });
  });

  return app;
}
