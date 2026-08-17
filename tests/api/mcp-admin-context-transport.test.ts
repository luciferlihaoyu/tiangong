/**
 * Transport 集成测试：验证 MCP HTTP 链路把 Key 的身份与 permissions
 * 注入到工具上下文（Phase 1 管理写工具的 admin 门依赖这条链路）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const authMocks = vi.hoisted(() => ({
  verifyMcpKey: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("../../api/mcp/auth", () => ({
  extractApiKey: (req: Request): string | null => req.headers.get("x-api-key"),
  verifyMcpKey: authMocks.verifyMcpKey,
  writeAuditLog: authMocks.writeAuditLog,
}));

const connMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../../api/queries/connection", () => ({ getDb: connMocks.getDb }));

import { createMcpApp } from "../../api/mcp/transport";
import { createFakeDb, type FakeDb } from "./helpers/fake-db";
import * as schema from "@db/schema";

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "admin-ctx-test", version: "1.0.0" },
  },
});

async function parseMcpResponse(res: Response): Promise<Record<string, any>> {
  const text = await res.text();
  if (text.startsWith("event: message")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) throw new Error(`SSE response missing data line: ${text}`);
    return JSON.parse(dataLine.slice(6));
  }
  return JSON.parse(text);
}

function toolCallBody(args: Record<string, unknown>): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "set_agent_budget", arguments: args },
  });
}

async function initializeThenCallTool(
  app: ReturnType<typeof createMcpApp>,
  apiKeyValue: string,
  args: Record<string, unknown>
): Promise<Record<string, any>> {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-api-key": apiKeyValue,
  };
  const initRes = await app.request("/", { method: "POST", headers, body: INITIALIZE_BODY });
  expect(initRes.status).toBe(200);
  const sessionId = initRes.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  const callRes = await app.request("/", {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId! },
    body: toolCallBody(args),
  });
  expect(callRes.status).toBe(200);
  const body = await parseMcpResponse(callRes);
  const text = body.result?.content?.[0]?.text ?? "{}";
  return JSON.parse(text);
}

describe("MCP transport injects key context into tools", () => {
  let db: FakeDb;

  beforeEach(() => {
    authMocks.verifyMcpKey.mockReset();
    authMocks.writeAuditLog.mockReset();
    db = createFakeDb();
    connMocks.getDb.mockReturnValue(db);
  });

  it("env-only key (no DB row) is denied admin write tools", async () => {
    authMocks.verifyMcpKey.mockResolvedValue({ valid: true });
    await db.insert(schema.agents).values({ agentId: "a1", name: "后土" });

    const app = createMcpApp();
    const payload = await initializeThenCallTool(app, "tg-1-env-only-key", {
      agentId: 1,
      budgetCents: 5000,
    });

    expect(payload.success).toBe(false);
    expect(payload.error).toContain("admin");
    expect(db.rowsOfTable(schema.agents)[0].budgetCents).toBeUndefined();
  });

  it("key with admin permission passes the gate end to end", async () => {
    authMocks.verifyMcpKey.mockResolvedValue({
      valid: true,
      apiKey: { id: 7, key: "tg-1-admin", agentId: null, permissions: '["admin"]', active: "true" },
      agent: null,
    });
    await db.insert(schema.agents).values({ agentId: "a1", name: "后土" });

    const app = createMcpApp();
    const payload = await initializeThenCallTool(app, "tg-1-admin", {
      agentId: 1,
      budgetCents: 5000,
    });

    expect(payload.success).toBe(true);
    expect(db.rowsOfTable(schema.agents)[0].budgetCents).toBe(5000);
  });

  it("key with CSV-style admin permission passes the gate", async () => {
    authMocks.verifyMcpKey.mockResolvedValue({
      valid: true,
      apiKey: { id: 8, key: "tg-1-csv", agentId: null, permissions: "ops, admin", active: "true" },
      agent: null,
    });
    await db.insert(schema.agents).values({ agentId: "a1", name: "后土" });

    const app = createMcpApp();
    const payload = await initializeThenCallTool(app, "tg-1-csv", {
      agentId: 1,
      budgetCents: 100,
    });

    expect(payload.success).toBe(true);
  });
});
