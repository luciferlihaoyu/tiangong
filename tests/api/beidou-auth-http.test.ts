/**
 * Todo 20 (Beidou plan): HTTP-level auth contract for the Beidou service
 * principal — exact header names, status codes, rotation/revocation, replay
 * of nonce on the frozen raw-body signature contract, cross-service denial,
 * admin endpoint probes, and credential redaction end-to-end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { randomBytes } from "node:crypto";

const shared = vi.hoisted(() => ({ db: null as unknown as import("./helpers/fake-db").FakeDb }));

vi.mock("../../api/queries/connection", async () => {
  const mod = await import("./helpers/fake-db");
  mod.fakeDbRegistry.instance = mod.createFakeDb();
  shared.db = mod.fakeDbRegistry.instance;
  return { getDb: () => mod.fakeDbRegistry.instance };
});

import { appRouter } from "../../api/router";
import { createContext } from "../../api/middleware";
import { issueServiceKey, rotateServiceKey, revokeServiceKey, type IssuedKey } from "../../api/lib/beidou-service-keys";
import { signRawBody, verifyRawBodySignature, generateNonce, resetNonceReplayStore } from "../../api/lib/raw-body-signature";

process.env.TIANGONG_SERVICE_KEY_PEPPER = "task20-http-test-pepper";

const app = new Hono();
app.use("/api/trpc/*", async (c) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: ({ req }) => createContext({ req }),
  }),
);

const CREATE_BODY = {
      external_ref: "beidou:research:http-qa-1",
      idempotency_key: "idem-http-1",
      operation: "create",
      target: "http qa task",
      params_snapshot: { query: "hello" },
      origin_system: "beidou",
};

async function callTrpc(path: string, headers: Record<string, string>, body: unknown) {
  return app.request(`http://localhost/api/trpc${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** Query procedures use GET with the tRPC `input` query param. */
async function callTrpcGet(path: string, headers: Record<string, string>, input: unknown) {
  const encoded = encodeURIComponent(JSON.stringify(input));
  return app.request(`http://localhost/api/trpc${path}?input=${encoded}`, {
    method: "GET",
    headers,
  });
}

function serviceHeaders(issued: IssuedKey): Record<string, string> {
  return {
    authorization: `Bearer ${issued.token}`,
    "x-tg-service-key-id": issued.keyId,
  };
}

describe("beidou service principal HTTP auth", () => {
  beforeEach(() => {
    shared.db.reset();
    resetNonceReplayStore();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exact headers create an external task with 200 and never return credentials", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read"],
    });
    const res = await callTrpc("/beidouExternal.create", serviceHeaders(issued), CREATE_BODY);
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.result.data.success).toBe(true);
    expect(payload.result.data.task.taskId).toMatch(/^TG-/);
    expect(JSON.stringify(payload)).not.toContain(issued.token);
    expect(JSON.stringify(payload)).not.toContain(issued.keyId);
  });

  it("missing service key id header → 401", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    const res = await callTrpc("/beidouExternal.create", { authorization: `Bearer ${issued.token}` }, CREATE_BODY);
    expect(res.status).toBe(401);
  });

  it("wrong token with a valid key id → 401", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    const res = await callTrpc(
      "/beidouExternal.create",
      { authorization: `Bearer ${randomBytes(32).toString("base64url")}`, "x-tg-service-key-id": issued.keyId },
      CREATE_BODY,
    );
    expect(res.status).toBe(401);
  });

  it("unknown key id → 401", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    const res = await callTrpc(
      "/beidouExternal.create",
      { authorization: `Bearer ${issued.token}`, "x-tg-service-key-id": "tgsk_does-not-exist" },
      CREATE_BODY,
    );
    expect(res.status).toBe(401);
  });

  it("revoked key → 401 immediately", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    await revokeServiceKey(issued.keyId, "qa");
    const res = await callTrpc("/beidouExternal.create", serviceHeaders(issued), CREATE_BODY);
    expect(res.status).toBe(401);
  });

  it("rotation: old key valid through overlap, 401 after the retention window", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read"],
    });
    const rotated = await rotateServiceKey(issued.keyId, { retentionMs: 86_400_000 });

    // Old key still authenticates inside the overlap window.
    const during = await callTrpc("/beidouExternal.create", serviceHeaders(issued), CREATE_BODY);
    expect(during.status).toBe(200);

    // New key works too.
    const fresh = await callTrpc("/beidouExternal.create", serviceHeaders(rotated), {
      ...CREATE_BODY,
      external_ref: "beidou:research:http-qa-2",
      idempotency_key: "idem-http-2",
    });
    expect(fresh.status).toBe(200);

    // Force the retention window to elapse (lazy revocation) then old key → 401.
    const { tiangongServiceKeys } = await import("@db/schema");
    const { eq } = await import("drizzle-orm");
    await shared.db
      .update(tiangongServiceKeys)
      .set({ rotationWindowEnd: new Date(Date.now() - 1) })
      .where(eq(tiangongServiceKeys.keyId, issued.keyId));
    const after = await callTrpc("/beidouExternal.create", serviceHeaders(issued), CREATE_BODY);
    expect(after.status).toBe(401);

    // New key still valid after old window.
    const stillFresh = await callTrpcGet("/beidouExternal.get", serviceHeaders(rotated), {
      external_ref: "beidou:research:http-qa-2",
    });
    expect(stillFresh.status).toBe(200);
  });

  it("wrong originSystem claim → 403", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    const res = await callTrpc("/beidouExternal.create", serviceHeaders(issued), {
      ...CREATE_BODY,
      origin_system: "xuanji",
    });
    expect(res.status).toBe(403);
  });

  it("agent MCP key (x-api-key) and human session cannot reach the external router → 401", async () => {
    const agentRes = await callTrpc("/beidouExternal.create", { "x-api-key": "tg-agent-key" }, CREATE_BODY);
    expect(agentRes.status).toBe(401);
    const humanRes = await callTrpc("/beidouExternal.create", { authorization: "Bearer human.jwt" }, CREATE_BODY);
    expect(humanRes.status).toBe(401);
    const anonRes = await callTrpc("/beidouExternal.create", {}, CREATE_BODY);
    expect(anonRes.status).toBe(401);
  });

  it("admin/agent endpoints reject the service principal (no privilege escalation)", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read"],
    });
    // Admin mutation probe.
    const adminRes = await callTrpc(
      "/taskboard.approve",
      serviceHeaders(issued),
      { input: { id: 1 } },
    );
    expect(adminRes.status).toBe(401);
    // General (weak, unbound) task mutation probe.
    const weakRes = await callTrpc(
      "/taskboard.progress",
      serviceHeaders(issued),
      { input: { id: 1, progress: 50 } },
    );
    expect(weakRes.status).toBe(401);
  });

  it("service principal cannot use protected general-router procedures", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"],
    });
    // authedQuery (agent/user) endpoints reject the service principal.
    const dispatchRes = await callTrpc(
      "/taskboard.dispatch",
      serviceHeaders(issued),
      { taskId: 1 },
    );
    expect(dispatchRes.status).toBe(401);
  });

  it("audit rows carry key_id, originSystem and a redacted prefix — never the token", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    await callTrpc("/beidouExternal.create", serviceHeaders(issued), CREATE_BODY);
    await callTrpc("/beidouExternal.create", serviceHeaders(issued), {
      ...CREATE_BODY,
      origin_system: "xuanji",
    });
    // Denied service call (malformed token with a valid key id).
    await callTrpc("/beidouExternal.create", { authorization: "Bearer wrong-token", "x-tg-service-key-id": issued.keyId }, CREATE_BODY);
    // Agent-key probe is NOT a service call → no service-key audit row.
    await callTrpc("/beidouExternal.create", { "x-api-key": "tg-agent-key" }, CREATE_BODY);

    const rows = shared.db.rowsByName("service_key_audit_log");
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const dump = JSON.stringify(row);
      expect(dump).not.toContain(issued.token);
      expect(String(row.tokenPrefix ?? "").length).toBeLessThanOrEqual(8);
      expect(String(row.tokenPrefix ?? "")).not.toContain(issued.token);
    }
    const reasons = rows.map((r) => String(r.reason ?? ""));
    expect(reasons).toContain("ok");
    expect(reasons).toContain("malformed_token");
    expect(rows.some((r) => r.decision === "denied")).toBe(true);
  });

  it("frozen raw-body signature contract: sign/verify round trip, replay rejection, skew and size limits", async () => {
    const secret = "qa-callback-secret";
    const keyId = "cbk_1";
    const body = JSON.stringify({ taskId: "TG-1", state: "done" });
    const { headers } = signRawBody({ keyId, secret, body });

    expect(headers["x-tg-key-id"]).toBe(keyId);
    expect(headers["x-tg-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["x-tg-nonce"]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(headers["x-tg-timestamp"]).toMatch(/^\d+$/);

    const ok = verifyRawBodySignature({
      headers,
      rawBody: body,
      resolveSecret: (k) => (k === keyId ? secret : null),
    });
    expect(ok.valid).toBe(true);

    // Tampered body (same byte length) with a fresh signature → mismatch.
    const tamperedHeaders = signRawBody({ keyId, secret, body }).headers;
    const tampered = verifyRawBodySignature({
      headers: tamperedHeaders,
      rawBody: body.replace("done", "fail"),
      resolveSecret: (k) => (k === keyId ? secret : null),
    });
    expect(tampered.valid).toBe(false);
    expect(tampered.reason).toBe("signature_mismatch");

    // Replay of the same nonce → rejected even with the correct body.
    const replay = verifyRawBodySignature({
      headers,
      rawBody: body,
      resolveSecret: (k) => (k === keyId ? secret : null),
    });
    expect(replay.valid).toBe(false);
    expect(replay.reason).toBe("nonce_replayed");

    // Fresh nonce → accepted again.
    const fresh = signRawBody({ keyId, secret, body });
    const freshOk = verifyRawBodySignature({
      headers: fresh.headers,
      rawBody: body,
      resolveSecret: (k) => (k === keyId ? secret : null),
    });
    expect(freshOk.valid).toBe(true);
  });

  it("nonce format is base64url-encoded 16 random bytes (22 chars, no padding)", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(nonce.endsWith("=")).toBe(false);
    const decoded = Buffer.from(nonce, "base64url");
    expect(decoded).toHaveLength(16);
  });
});
