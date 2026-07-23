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

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringProperty(value: JsonObject, key: string): string | undefined {
  const property = value[key];
  return typeof property === "string" ? property : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    const build =
      process.env.GIT_COMMIT ||
      process.env.ZEABUR_GIT_COMMIT ||
      process.env.SOURCE_VERSION ||
      "unknown";
    return c.json({
      ok: true,
      version: "2.0.1",
      build,
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
      let requestBody: JsonObject;
      try {
        const parsed: unknown = await c.req.raw.clone().json();
        requestBody = isJsonObject(parsed) ? parsed : {};
      } catch {
        requestBody = {};
      }

      const params = isJsonObject(requestBody.params) ? requestBody.params : undefined;
      const method = getStringProperty(requestBody, "method");
      const toolName = method === "tools/call" ? getStringProperty(params ?? {}, "name") ?? "tools/call" : method ?? "unknown";

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

      if (method === "tools/call") {
        const args = params && isJsonObject(params.arguments) ? params.arguments : undefined;
        paramsSummary = JSON.stringify({
          tool: params ? getStringProperty(params, "name") : undefined,
          argKeys: args ? Object.keys(args) : [],
        });
      } else if (method) {
        paramsSummary = method;
        if (params) {
          paramsSummary += " " + JSON.stringify(params).slice(0, 400);
        }
      } else {
        paramsSummary = "unknown";
      }

      if (isError) {
        try {
          const errBody: unknown = await response.clone().json();
          const errorBody = isJsonObject(errBody) && isJsonObject(errBody.error) ? errBody.error : undefined;
          errorMsg = errorBody ? getStringProperty(errorBody, "message") ?? `HTTP ${response.status}` : `HTTP ${response.status}`;
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
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const message = getErrorMessage(err);
      writeAuditLog({
        keyId: authResult.apiKey!.id,
        tool: "transport_error",
        params: message.slice(0, 500),
        result: "error",
        error: message,
        durationMs,
      });

      return c.json(
        {
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message,
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
    } catch (err: unknown) {
      console.error("MCP SSE error:", getErrorMessage(err));
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
