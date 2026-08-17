/**
 * Phase 1 管理工具面测试：
 * - 只读 ops/usage/events/guard 工具对所有有效 Key 开放
 * - cancel_task 走状态机、不扩大既有权限
 * - 管理写工具（预算 / guard 白名单 / 授权 / 撤销）需要 Key permissions 含 admin
 * - guard 白名单与授权禁止 MCP Key 为绑定 Agent 自我授权
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db";

const connMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../../api/queries/connection", () => ({ getDb: connMocks.getDb }));

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getMcpServer,
  parsePermissions,
  type McpToolContext,
} from "../../api/mcp/server";
import * as schema from "@db/schema";

const ADMIN_CTX: McpToolContext = { apiKeyId: 7, agentId: null, permissions: ["admin"] };
const PLAIN_CTX: McpToolContext = { apiKeyId: 3, agentId: null, permissions: [] };
const AGENT_BOUND_CTX: McpToolContext = { apiKeyId: 9, agentId: 16, permissions: ["admin"] };

let db: FakeDb;

async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext = PLAIN_CTX
): Promise<{ isError: boolean; payload: Record<string, any> }> {
  const server = getMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-ops-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) };
  } finally {
    await client.close();
  }
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

beforeEach(() => {
  db = createFakeDb();
  connMocks.getDb.mockReturnValue(db);
});

describe("parsePermissions", () => {
  it("parses JSON array convention from mcp.createKey", () => {
    expect(parsePermissions('["admin","ops"]')).toEqual(["admin", "ops"]);
  });

  it("falls back to comma/whitespace splitting", () => {
    expect(parsePermissions("admin, ops write")).toEqual(["admin", "ops", "write"]);
  });

  it("falls back to splitting on malformed JSON", () => {
    expect(parsePermissions('["admin"')).toEqual(['["admin"']);
  });

  it("returns empty list for null/empty input", () => {
    expect(parsePermissions(null)).toEqual([]);
    expect(parsePermissions("   ")).toEqual([]);
    expect(parsePermissions(undefined)).toEqual([]);
  });
});

describe("read-only ops tools", () => {
  it("ops_agent_status computes heartbeatOk and budgetUsed", async () => {
    await db.insert(schema.agents).values({
      agentId: "a1",
      name: "琼霄",
      status: "online",
      lastHeartbeat: new Date(),
      spentCents: 250,
      budgetCents: 1000,
    });
    await db.insert(schema.agents).values({
      agentId: "a2",
      name: "羲和",
      status: "idle",
      lastHeartbeat: hoursAgo(1),
      spentCents: 0,
      budgetCents: 0,
    });

    const { payload } = await callTool("ops_agent_status", {});
    expect(payload.success).toBe(true);
    const byName = Object.fromEntries(payload.agents.map((a: any) => [a.name, a]));
    expect(byName["琼霄"].heartbeatOk).toBe(true);
    expect(byName["琼霄"].budgetUsed).toBe(25);
    expect(byName["羲和"].heartbeatOk).toBe(false);
    expect(byName["羲和"].budgetUsed).toBe(0);
  });

  it("ops_task_stats counts statuses", async () => {
    const base = { name: "t", taskId: "T-X", createdAt: new Date(), updatedAt: new Date() };
    await db.insert(schema.tasks).values({ ...base, taskId: "T-1", status: "queued" });
    await db.insert(schema.tasks).values({ ...base, taskId: "T-2", status: "running" });
    await db.insert(schema.tasks).values({ ...base, taskId: "T-3", status: "done" });
    await db.insert(schema.tasks).values({ ...base, taskId: "T-4", status: "done" });
    await db.insert(schema.tasks).values({ ...base, taskId: "T-5", status: "failed" });

    const { payload } = await callTool("ops_task_stats", {});
    expect(payload.stats).toEqual({ queued: 1, pending: 0, running: 1, done: 2, failed: 1 });
    expect(payload.total).toBe(5);
  });

  it("ops_recent_tasks returns newest first respecting limit", async () => {
    const base = { name: "t", status: "done" };
    await db.insert(schema.tasks).values({ ...base, taskId: "T-OLD", createdAt: hoursAgo(48), updatedAt: hoursAgo(48) });
    await db.insert(schema.tasks).values({ ...base, taskId: "T-MID", createdAt: hoursAgo(24), updatedAt: hoursAgo(24) });
    await db.insert(schema.tasks).values({ ...base, taskId: "T-NEW", createdAt: hoursAgo(1), updatedAt: hoursAgo(1) });

    const { payload } = await callTool("ops_recent_tasks", { limit: 2 });
    expect(payload.tasks.map((t: any) => t.taskId)).toEqual(["T-NEW", "T-MID"]);
  });

  it("ops_today_overview aggregates agents, today tasks and usage", async () => {
    await db.insert(schema.agents).values({ agentId: "a1", name: "后土", status: "busy" });
    await db.insert(schema.tasks).values({ taskId: "T-TODAY", name: "today", status: "done", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(schema.tasks).values({ taskId: "T-YESTERDAY", name: "old", status: "done", createdAt: hoursAgo(48), updatedAt: hoursAgo(48) });
    await db.insert(schema.tokenUsage).values({
      model: "deepseek-v4-pro",
      totalTokens: 1000,
      costCents: 50,
      callCount: 1,
      highCostModel: "false",
      createdAt: new Date(),
    });
    await db.insert(schema.tokenUsage).values({
      model: "4sapi/gpt-5.5-high",
      totalTokens: 200,
      costCents: 300,
      callCount: 2,
      highCostModel: "true",
      createdAt: new Date(),
    });

    const { payload } = await callTool("ops_today_overview", {});
    expect(payload.agents).toEqual({ online: 0, busy: 1, idle: 0 });
    expect(payload.tasks.done).toBe(1);
    expect(payload.usage.totalTokens).toBe(1200);
    expect(payload.usage.costCents).toBe(350);
    expect(payload.usage.highCostCount).toBe(2);
  });

  it("usage_recent filters by highCostOnly, model and limit", async () => {
    await db.insert(schema.tokenUsage).values({ model: "m1", totalTokens: 10, costCents: 1, callCount: 1, highCostModel: "false", agentId: 1, createdAt: hoursAgo(2) });
    await db.insert(schema.tokenUsage).values({ model: "m2", totalTokens: 20, costCents: 200, callCount: 1, highCostModel: "true", agentId: 1, createdAt: hoursAgo(1) });
    await db.insert(schema.tokenUsage).values({ model: "m2", totalTokens: 30, costCents: 300, callCount: 1, highCostModel: "true", agentId: 2, createdAt: new Date() });

    const highOnly = await callTool("usage_recent", { highCostOnly: true });
    expect(highOnly.payload.calls).toHaveLength(2);
    expect(highOnly.payload.calls.every((c: any) => c.highCostModel === "true")).toBe(true);

    const byAgent = await callTool("usage_recent", { agentId: 1, highCostOnly: true });
    expect(byAgent.payload.calls).toHaveLength(1);
    expect(byAgent.payload.calls[0].model).toBe("m2");

    const limited = await callTool("usage_recent", { limit: 1 });
    expect(limited.payload.calls).toHaveLength(1);
    expect(limited.payload.calls[0].createdAt <= new Date().toISOString()).toBe(true);
  });

  it("usage_cost_summary aggregates by model within window", async () => {
    await db.insert(schema.tokenUsage).values({ model: "m1", totalTokens: 100, costCents: 10, callCount: 1, createdAt: hoursAgo(24) });
    await db.insert(schema.tokenUsage).values({ model: "m1", totalTokens: 50, costCents: 5, callCount: 2, createdAt: hoursAgo(12) });
    await db.insert(schema.tokenUsage).values({ model: "m2", totalTokens: 70, costCents: 7, callCount: 1, createdAt: hoursAgo(48 * 30) });

    const { payload } = await callTool("usage_cost_summary", { days: 7 });
    expect(payload.models.m1).toEqual({ totalTokens: 150, callCount: 3, costCents: 15 });
    expect(payload.models.m2).toBeUndefined();
    expect(payload.totals).toEqual({ totalTokens: 150, callCount: 3, costCents: 15 });
  });

  it("list_recent_events merges sources by time desc and filters by kind", async () => {
    await db.insert(schema.auditEvents).values({ entityType: "task", entityId: 1, event: "task.cancelled", actorUserId: 1, createdAt: hoursAgo(3) });
    await db.insert(schema.taskMessages).values({ taskId: 1, eventType: "progress", content: "x".repeat(200), fromAgentId: 1, toAgentId: 2, createdAt: hoursAgo(2) });
    await db.insert(schema.tokenUsage).values({ model: "m1", totalTokens: 10, costCents: 1, callCount: 1, createdAt: hoursAgo(1) });

    const all = await callTool("list_recent_events", { limit: 10 });
    expect(all.payload.events).toHaveLength(3);
    expect(all.payload.events.map((e: any) => e.kind)).toEqual(["usage", "task", "audit"]);
    const taskEvent = all.payload.events.find((e: any) => e.kind === "task");
    expect(taskEvent.contentPreview).toHaveLength(120);

    const auditOnly = await callTool("list_recent_events", { kind: "audit" });
    expect(auditOnly.payload.events).toHaveLength(1);
    expect(auditOnly.payload.events[0].summary).toBe("task.cancelled");
  });

  it("guard_status excludes expired auths and lists allowlist", async () => {
    await db.insert(schema.modelAllowlist).values({ agentId: 1, model: "m-high", reason: "ok", createdBy: "admin" });
    await db.insert(schema.highCostModelAuth).values({ agentId: 2, model: "m-high", reason: "r", authorizedBy: "admin", active: "true", expiresAt: null });
    await db.insert(schema.highCostModelAuth).values({ agentId: 3, model: "m-high", reason: "r", authorizedBy: "admin", active: "true", expiresAt: hoursAgo(24) });
    await db.insert(schema.highCostModelAuth).values({ agentId: 4, model: "m-high", reason: "r", authorizedBy: "admin", active: "false", expiresAt: null });

    const { payload } = await callTool("guard_status", {});
    expect(payload.allowlist).toHaveLength(1);
    expect(payload.activeAuths).toHaveLength(1);
    expect(payload.activeAuths[0].agentId).toBe(2);
    expect(payload.knownHighCostModels.length).toBeGreaterThan(0);
  });
});

describe("guard_check", () => {
  it("allows low-cost models without any authorization", async () => {
    const { payload } = await callTool("guard_check", { model: "deepseek-v4-flash", costCents: 1 });
    expect(payload.allowed).toBe(true);
    expect(payload.reason).toBe("low_cost_model");
  });

  it("denies known high-cost model with no agent context", async () => {
    const { payload } = await callTool("guard_check", { model: "4sapi/gpt-5.5-high" });
    expect(payload.allowed).toBe(false);
    expect(payload.reason).toBe("high_cost_not_authorized");
  });

  it("denies high-cost by cost threshold even for unknown model", async () => {
    const { payload } = await callTool("guard_check", { model: "custom-model", agentId: 1, costCents: 100 });
    expect(payload.allowed).toBe(false);
    expect(payload.highCost).toBe(true);
  });

  it("allows when allowlisted", async () => {
    await db.insert(schema.modelAllowlist).values({ agentId: 1, model: "m-high", reason: "approved", createdBy: "admin" });
    const { payload } = await callTool("guard_check", { model: "m-high", agentId: 1, costCents: 500 });
    expect(payload.allowed).toBe(true);
    expect(payload.reason).toBe("allowlisted");
  });

  it("allows when an active non-expired auth exists", async () => {
    await db.insert(schema.highCostModelAuth).values({
      agentId: 1, model: "m-high", reason: "r", authorizedBy: "admin",
      active: "true", expiresAt: new Date(Date.now() + 3_600_000),
    });
    const { payload } = await callTool("guard_check", { model: "m-high", agentId: 1, costCents: 500 });
    expect(payload.allowed).toBe(true);
    expect(payload.reason).toBe("authorized");
  });

  it("denies when auth is expired", async () => {
    await db.insert(schema.highCostModelAuth).values({
      agentId: 1, model: "m-high", reason: "r", authorizedBy: "admin",
      active: "true", expiresAt: hoursAgo(1),
    });
    const { payload } = await callTool("guard_check", { model: "m-high", agentId: 1, costCents: 500 });
    expect(payload.allowed).toBe(false);
  });
});

describe("cancel_task", () => {
  it("marks a queued task failed with cancellation note", async () => {
    await db.insert(schema.tasks).values({ taskId: "T-1", name: "t", status: "queued", createdAt: new Date(), updatedAt: new Date() });

    const { payload } = await callTool("cancel_task", { taskId: 1, reason: "重复创建" });
    expect(payload.success).toBe(true);

    const rows = db.rowsOfTable(schema.tasks);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toBe("[cancelled] 重复创建");
  });

  it("rejects cancelling a task in terminal state", async () => {
    await db.insert(schema.tasks).values({ taskId: "T-1", name: "t", status: "done", createdAt: new Date(), updatedAt: new Date() });
    const { payload } = await callTool("cancel_task", { taskId: 1 });
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("终态");
  });

  it("rejects unknown task id", async () => {
    const { payload } = await callTool("cancel_task", { taskId: 999 });
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("任务不存在");
  });
});

describe("admin-gated write tools", () => {
  it("set_agent_budget is denied without admin permission", async () => {
    await db.insert(schema.agents).values({ agentId: "a1", name: "后土" });
    const { payload } = await callTool("set_agent_budget", { agentId: 1, budgetCents: 5000 }, PLAIN_CTX);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("admin");
    expect(db.rowsOfTable(schema.agents)[0].budgetCents).toBeUndefined();
  });

  it("set_agent_budget succeeds with admin permission", async () => {
    await db.insert(schema.agents).values({ agentId: "a1", name: "后土" });
    const { payload } = await callTool("set_agent_budget", { agentId: 1, budgetCents: 5000 }, ADMIN_CTX);
    expect(payload.success).toBe(true);
    expect(db.rowsOfTable(schema.agents)[0].budgetCents).toBe(5000);
  });

  it("guard_add_allowlist is denied without admin permission", async () => {
    const { payload } = await callTool("guard_add_allowlist", { agentId: 1, model: "m-high" }, PLAIN_CTX);
    expect(payload.success).toBe(false);
    expect(db.rowsOfTable(schema.modelAllowlist)).toHaveLength(0);
  });

  it("guard_add_allowlist blocks self-grant for the bound agent", async () => {
    const { payload } = await callTool("guard_add_allowlist", { agentId: 16, model: "m-high" }, AGENT_BOUND_CTX);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("自我授权");
    expect(db.rowsOfTable(schema.modelAllowlist)).toHaveLength(0);
  });

  it("guard_add_allowlist allows admin key to grant another agent", async () => {
    const { payload } = await callTool("guard_add_allowlist", { agentId: 16, model: "m-high", reason: "联调" }, ADMIN_CTX);
    expect(payload.success).toBe(true);
    const rows = db.rowsOfTable(schema.modelAllowlist);
    expect(rows).toHaveLength(1);
    expect(rows[0].createdBy).toBe("mcp-key:7");
  });

  it("guard_create_auth blocks self-grant", async () => {
    const { payload } = await callTool(
      "guard_create_auth",
      { agentId: 16, model: "m-high", reason: "r" },
      AGENT_BOUND_CTX
    );
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("自我授权");
  });

  it("guard_create_auth stores expiry and enables guard_check", async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = await callTool(
      "guard_create_auth",
      { agentId: 16, model: "m-high", reason: "压测需要", expiresAt },
      ADMIN_CTX
    );
    expect(created.payload.success).toBe(true);

    const check = await callTool("guard_check", { model: "m-high", agentId: 16, costCents: 999 });
    expect(check.payload.allowed).toBe(true);
    expect(check.payload.reason).toBe("authorized");
  });

  it("guard_revoke_auth deactivates and re-blocks the model", async () => {
    await db.insert(schema.highCostModelAuth).values({
      agentId: 16, model: "m-high", reason: "r", authorizedBy: "admin", active: "true", expiresAt: null,
    });

    const denied = await callTool("guard_revoke_auth", { id: 1 }, PLAIN_CTX);
    expect(denied.payload.success).toBe(false);

    const revoked = await callTool("guard_revoke_auth", { id: 1 }, ADMIN_CTX);
    expect(revoked.payload.success).toBe(true);

    const check = await callTool("guard_check", { model: "m-high", agentId: 16, costCents: 999 });
    expect(check.payload.allowed).toBe(false);
  });
});
