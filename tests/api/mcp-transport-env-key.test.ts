/**
 * Regression test: MCP transport must not crash when an API key is valid
 * via the global/env key set but has no row in the mcp_api_keys table.
 *
 * Root cause fixed: transport.ts used `authResult.apiKey!.id` non-null
 * assertions, which threw `TypeError: Cannot read properties of undefined
 * (reading 'id')` and returned HTTP 500 for env-only keys.
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

import { createMcpApp } from "../../api/mcp/transport";

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "regression-test", version: "1.0.0" },
  },
});

/** The transport responds with SSE (`event: message\ndata: {...}`) when the
 * client accepts `text/event-stream`. Extract the JSON-RPC payload. */
async function parseMcpResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (text.startsWith("event: message")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
    if (!dataLine) throw new Error(`SSE response missing data line: ${text}`);
    return JSON.parse(dataLine.slice(6));
  }
  return JSON.parse(text);
}

describe("MCP transport with env-only API key", () => {
  beforeEach(() => {
    authMocks.verifyMcpKey.mockReset();
    authMocks.writeAuditLog.mockReset();
  });

  it("returns 200 on initialize when key is valid but has no DB row", async () => {
    // Given: verifyMcpKey accepts the key via the global/env fast path
    // without resolving a DB apiKey row (the env-key case)
    authMocks.verifyMcpKey.mockResolvedValue({ valid: true });

    const app = createMcpApp();

    // When: a client sends initialize with an env-only key
    const res = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": "tg-1-env-only-key-without-db-row",
      },
      body: INITIALIZE_BODY,
    });

    // Then: the request succeeds instead of crashing with 500
    expect(res.status).toBe(200);
    const body = await parseMcpResponse(res);
    expect(body.result?.serverInfo?.name).toBe("Tiangong");
    expect(authMocks.verifyMcpKey).toHaveBeenCalledWith(
      "tg-1-env-only-key-without-db-row"
    );
  });

  it("writes audit log with keyId 0 when apiKey is undefined", async () => {
    // Given: valid via fast path, no DB apiKey row
    authMocks.verifyMcpKey.mockResolvedValue({ valid: true });

    const app = createMcpApp();
    await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-api-key": "tg-1-env-only-key-without-db-row",
      },
      body: INITIALIZE_BODY,
    });

    // Then: audit log is written without throwing (keyId falls back to 0)
    expect(authMocks.writeAuditLog).toHaveBeenCalled();
    const call = authMocks.writeAuditLog.mock.calls[0]?.[0];
    expect(call?.keyId).toBe(0);
  });

  it("rejects requests with an invalid key before touching the transport", async () => {
    // Given: key verification fails
    authMocks.verifyMcpKey.mockResolvedValue({
      valid: false,
      error: "API Key 不存在",
      statusCode: 401,
    });

    const app = createMcpApp();

    // When: initialize with an unknown key
    const res = await app.request("/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "tg-1-unknown-key",
      },
      body: INITIALIZE_BODY,
    });

    // Then: 401 JSON-RPC error, no crash
    expect(res.status).toBe(401);
    const body = await parseMcpResponse(res);
    expect(body.error?.message).toBe("API Key 不存在");
  });
});
