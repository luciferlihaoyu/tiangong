/**
 * t2-2：createTask 无执行人即拒 + 接受 idempotencyKey。
 *
 * 背景（历史 #61/#62/#198）：`agent_id IS NULL` 且没有任何归属声明的"通用任务"
 * 不被内建 Runner 的任何跳过条件命中 → 天宫自己下场用 mode=tianshu 执行，
 * 而天枢没有对应模型渠道 → 必然 503 ×重试后 failed。全库曾 23/68 个任务是这个形状。
 * 结论：**派单必须带执行人**（数字 agentId 或 requestedAgentId 至少一个），
 * 服务端在入口直接拒绝，而不是等执行链炸掉。
 *
 * 同时补上 createTask 的幂等键：tasks.idempotency_key 列与复合唯一索引
 * （origin_system, idempotency_key）早已存在（北斗外部建单链路在用），
 * 本切片只是把这条能力开放给 orch.createTask / MCP create_task：
 * 同 key 重复建单不报错，返回已存在任务的同一形状（reused: true）。
 *
 * 用真实 SQLite（helpers/test-db）而不是 fake-db：fake-db 的 insert 返回值是
 * MySQL 形状、唯一冲突判定也是手写的简化规则，历史上正是它掩盖过真实驱动的 bug
 * （见 beidou-external-real.test.ts 的教训说明）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({
  broadcastToDashboard: vi.fn(),
  broadcastToTask: vi.fn(),
  sendToAgent: vi.fn(),
}));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));

import { orchestrationRouter } from "../../api/orchestration-router";
import { getMcpServer, type McpToolContext } from "../../api/mcp/server";
import { createCallerFactory } from "../../api/middleware";

const orchCaller = createCallerFactory(orchestrationRouter);
/** 登录态上下文：orch.createTask 是 authedQuery，这里只要过鉴权门 */
const adminCtx = { req: undefined, user: { id: 1, role: "admin" }, apiKeyAgentId: -1 } as never;

/** Key 绑定 Agent 17（模拟 dsh-runner 专属 Key）；t2-3 用它验证 created_by_agent_id */
const AGENT_BOUND_CTX: McpToolContext = { apiKeyId: 9, agentId: 17, permissions: [] };
const ENV_KEY_CTX: McpToolContext = { apiKeyId: 3, agentId: null, permissions: [] };

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  for (const fn of Object.values(wsMocks)) fn.mockReset();
});

afterEach(() => {
  testDb.dispose();
});

/* eslint-disable @typescript-eslint/no-explicit-any -- 工具回执是自由 JSON，断言处按需取字段 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext = ENV_KEY_CTX,
): Promise<{ isError: boolean; payload: Record<string, any> }> {
  const server = getMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "create-task-gate-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) };
  } finally {
    await client.close();
  }
}

function taskRows() {
  return testDb.db.select().from(schema.tasks).all() as Array<Record<string, unknown>>;
}

let seq = 0;
const nextTaskId = () => `TG-T22-${(seq++).toString().padStart(3, "0")}`;

describe("t2-2 createTask 执行人闸门", () => {
  it("a) 无 agentId 也无 requestedAgentId → BAD_REQUEST，且不落库", async () => {
    const caller = orchCaller(adminCtx);
    let caught: unknown = null;
    try {
      await caller.createTask({ taskId: nextTaskId(), name: "无执行人任务" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    const err = caught as { code?: string; message?: string };
    expect(err.code).toBe("BAD_REQUEST");
    // message 必须讲清"为什么"——引用历史事故编号，防止有人把它当回归再放开
    expect(err.message).toMatch(/t2-2/);
    expect(err.message).toMatch(/requestedAgentId/);
    expect(err.message).toMatch(/#61\/#62\/#198/);
    expect(taskRows()).toHaveLength(0);
  });

  it("b) 带 requestedAgentId（无数字 agentId）→ 正常创建，归属写进 input metadata", async () => {
    const caller = orchCaller(adminCtx);
    const res = await caller.createTask({
      taskId: nextTaskId(),
      name: "指名 dsh 的任务",
      requestedAgentId: "dsh",
    });
    expect(res.success).toBe(true);
    expect(typeof res.id).toBe("number");

    const rows = taskRows();
    expect(rows).toHaveLength(1);
    const input = rows[0].input as string;
    expect(input).toContain("\"selectedAgentId\":\"dsh\"");
  });

  it("b2) 带数字 agentId（无 requestedAgentId）→ 正常创建", async () => {
    const caller = orchCaller(adminCtx);
    const res = await caller.createTask({
      taskId: nextTaskId(),
      name: "直派任务",
      agentId: 7,
    });
    expect(res.success).toBe(true);
    expect(taskRows()).toHaveLength(1);
  });

  it("c) 同 idempotencyKey 两次 → 第二次返回同一任务号，tasks 表只有 1 行", async () => {
    const caller = orchCaller(adminCtx);
    const key = "idem-t22-repeat";
    const first = await caller.createTask({
      taskId: nextTaskId(),
      name: "幂等首建",
      agentId: 7,
      idempotencyKey: key,
    });
    expect(first.success).toBe(true);
    expect(first.reused).not.toBe(true);

    const second = await caller.createTask({
      taskId: nextTaskId(),
      name: "幂等重放（不同 taskId 也应命中同一 key）",
      agentId: 7,
      idempotencyKey: key,
    });
    expect(second.success).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.taskId).toBe(first.taskId);
    expect(second.reused).toBe(true);

    const rows = taskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(key);
    // 幂等键落在既有复合唯一索引的首列上，否则 NULL 互不冲突、约束形同虚设
    expect(rows[0].originSystem).toBe("tiangong");
  });

  it("c2) 不传 idempotencyKey → 行为不变（可连续建两单，key 列为 NULL）", async () => {
    const caller = orchCaller(adminCtx);
    const a = await caller.createTask({ taskId: nextTaskId(), name: "普通单 A", agentId: 7 });
    const b = await caller.createTask({ taskId: nextTaskId(), name: "普通单 B", agentId: 7 });
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(a.id).not.toBe(b.id);
    const rows = taskRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.idempotencyKey === null)).toBe(true);
  });

  it("c3) 带依赖 + 同 idempotencyKey 重放 → 仍复用原任务，不产生第二行", async () => {
    const caller = orchCaller(adminCtx);
    const dep = await caller.createTask({ taskId: nextTaskId(), name: "前置任务", agentId: 7 });
    const key = "idem-t22-deps";
    const first = await caller.createTask({
      taskId: nextTaskId(),
      name: "带依赖首建",
      agentId: 7,
      dependsOn: [dep.id as number],
      idempotencyKey: key,
    });
    expect(first.success).toBe(true);
    const second = await caller.createTask({
      taskId: nextTaskId(),
      name: "带依赖重放",
      agentId: 7,
      dependsOn: [dep.id as number],
      idempotencyKey: key,
    });
    expect(second.reused).toBe(true);
    expect(second.id).toBe(first.id);
    expect(taskRows()).toHaveLength(2); // 前置 + 本任务，重放不多建
  });

  it("d) MCP create_task 无执行人 → 明确错误文本，不落库", async () => {
    const res = await callTool("create_task", { name: "MCP 无执行人" });
    expect(res.payload.success).toBe(false);
    expect(String(res.payload.error)).toMatch(/requestedAgentId/);
    expect(String(res.payload.error)).toMatch(/#61\/#62\/#198/);
    expect(taskRows()).toHaveLength(0);
  });

  it("d2) MCP create_task 带 requestedAgentId → 成功；同 idempotencyKey 重放 → 同一任务号", async () => {
    const first = await callTool("create_task", {
      name: "MCP 指名任务",
      requestedAgentId: "dsh",
      idempotencyKey: "mcp-idem-t22",
    });
    expect(first.payload.success).toBe(true);
    const id = first.payload.task.id;
    expect(first.payload.task.name).toBe("MCP 指名任务");

    const second = await callTool("create_task", {
      name: "MCP 指名任务（重放）",
      requestedAgentId: "dsh",
      idempotencyKey: "mcp-idem-t22",
    });
    expect(second.payload.success).toBe(true);
    expect(second.payload.task.id).toBe(id);
    expect(second.payload.reused).toBe(true);
    expect(taskRows()).toHaveLength(1);
  });

  it("d3) MCP create_task 带数字 agentId → 放行", async () => {
    const res = await callTool("create_task", { name: "MCP 直派", agentId: 7 });
    expect(res.payload.success).toBe(true);
    expect(taskRows()).toHaveLength(1);
  });

  it("d4) MCP create_task 工具描述不再宣称「通用任务任意 agent 可认领」", async () => {
    const server = getMcpServer(ENV_KEY_CTX);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "create-task-desc-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const createTask = tools.tools.find((t) => t.name === "create_task");
      expect(createTask).toBeDefined();
      const desc = String(createTask!.description ?? "");
      expect(desc).not.toContain("不指定 = 通用任务");
      expect(desc).toContain("必须指定");
    } finally {
      await client.close();
    }
  });
});

describe("t2-3 tasks.created_by_agent_id", () => {
  it("MCP create_task（Key 绑定 Agent）→ created_by_agent_id = 调用方 agent id", async () => {
    const res = await callTool(
      "create_task",
      { name: "谁建的单", requestedAgentId: "dsh" },
      AGENT_BOUND_CTX,
    );
    expect(res.payload.success).toBe(true);
    const rows = taskRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].createdByAgentId).toBe(17);
  });

  it("MCP create_task（env-only Key，无绑定 Agent）→ 列留 NULL，绝不抛错", async () => {
    const res = await callTool("create_task", { name: "匿名建单", requestedAgentId: "dsh" }, ENV_KEY_CTX);
    expect(res.payload.success).toBe(true);
    expect(taskRows()[0].createdByAgentId).toBeNull();
  });

  it("tRPC orch.createTask 带 API Key 身份 → created_by_agent_id = ctx.apiKeyAgentId", async () => {
    const caller = orchCaller({
      req: undefined,
      user: null,
      apiKeyAgentId: 12,
      servicePrincipal: null,
    } as never);
    const res = await caller.createTask({
      taskId: nextTaskId(),
      name: "API Key 建单",
      agentId: 7,
    });
    expect(res.success).toBe(true);
    expect(taskRows()[0].createdByAgentId).toBe(12);
  });

  it("tRPC orch.createTask 仅登录用户（无 Key 绑定）→ 列留 NULL，不抛错", async () => {
    const caller = orchCaller(adminCtx);
    const res = await caller.createTask({ taskId: nextTaskId(), name: "UI 建单", agentId: 7 });
    expect(res.success).toBe(true);
    expect(taskRows()[0].createdByAgentId).toBeNull();
  });

  it("旧库升级：缺列的 tasks 表经版本化迁移 0003 补上 created_by_agent_id 且数据不丢", async () => {
    const raw = testDb.raw;
    raw.exec(`ALTER TABLE tasks DROP COLUMN "created_by_agent_id"`);
    const cols = (raw.prepare(`PRAGMA table_info("tasks")`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain("created_by_agent_id");
    raw.prepare(
      `INSERT INTO tasks (task_id, name, status, lifecycle_status) VALUES ('TG-T23-OLD', '老库任务', 'done', 'completed')`,
    ).run();

    // 生产注册表（auto-migrate 会 side-effect import 它）+ 真实迁移执行器
    const { runSchemaMigrations, listRegisteredSchemaMigrations } = await import(
      "../../api/lib/schema-migrations"
    );
    await import("../../api/lib/migrations-register");
    expect(listRegisteredSchemaMigrations()).toContain("0003-tasks-created-by-agent-id");

    const run = runSchemaMigrations(raw);
    expect(run.failures).toEqual([]);
    expect(run.applied).toContain("0003-tasks-created-by-agent-id");

    const after = (raw.prepare(`PRAGMA table_info("tasks")`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(after).toContain("created_by_agent_id");
    const row = raw
      .prepare(`SELECT task_id, name, created_by_agent_id FROM tasks WHERE task_id = 'TG-T23-OLD'`)
      .get() as Record<string, unknown>;
    expect(row.name).toBe("老库任务");
    expect(row.created_by_agent_id).toBeNull();

    // 幂等：重跑跳过，不再执行
    const rerun = runSchemaMigrations(raw);
    expect(rerun.applied).not.toContain("0003-tasks-created-by-agent-id");
    expect(rerun.skipped).toContain("0003-tasks-created-by-agent-id");
  });
});
