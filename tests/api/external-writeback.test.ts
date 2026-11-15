/**
 * 任务 1.4 + 1.5：外部执行路径的用量记账 / 预算停放 / 长产物通道
 *
 * 覆盖：
 *   - task.updateProgress 带 usage 完成 → token_usage 插入 + agents.spentCents 原子递增
 *   - 微美元 → 美分换算（microsToCents）边界
 *   - task.updateProgress 带 artifacts → task_artifacts 插入（type=external_output）
 *   - MCP Key 与任务认领人不符 → usage/artifacts 提交 FORBIDDEN
 *   - agent.claimTask / agent.updateHeartbeat 预算耗尽 → 不认领 + reason
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { markSystemReady } from "./helpers/test-db";

// ─── 假 DB：helpers/fake-db（读会真正求值 WHERE；写落内存行）+ 写路径 spy ───
// 历史教训（2026-11-16 评审）：本文件曾用"按表名返回整表、where() 空操作"的表级桩，
// 单飞闸新增一次投影查询后它把 queued 行当 running 行 → 认领恒返 agent_busy；
// 而当时用手写的"投影式 select 恒返 []"判别补救——brand 名单抄错（SchemaTable/MySqlTable
// 对 sqliteTable 恒不命中）退化成全局规则，构成**误绿**（变异实验：无关投影查询被吞也全绿）。
// 现在读写统一走 FakeDb：任何新增查询按真实 WHERE 语义过滤，无需再补桩。
type AnyRow = Record<string, unknown>;
type Call4 = { table: string; values: unknown };

const TABLE_NAME = Symbol.for("drizzle:Name");

// FakeDb 实例在 vi.mock 工厂里构造（async import），经共享 holder 暴露给用例
// （照 task-concurrency.test.ts 的惯用法）。
const shared = vi.hoisted(() => ({ db: null as unknown as import("./helpers/fake-db").FakeDb }));

vi.mock("../../api/queries/connection", async () => {
  const mod = await import("./helpers/fake-db");
  mod.fakeDbRegistry.instance = mod.createFakeDb();
  shared.db = mod.fakeDbRegistry.instance;
  // getDb 返回带写路径 spy 的 instrumentedDb（下方定义；工厂在测试体求值时才被调用）
  return { getDb: () => getInstrumentedDb() };
});

const fakeDb = shared.db;

const state = {
  insertCalls: [] as Call4[],
  updateCalls: [] as Array<{ table: string; set: AnyRow; where: unknown }>,
  failNextTokenUsageInsert: false,
  tokenUsageInsertAttempted: false,
};

// 写路径包一层 spy：保留"SQL 形状断言"（COALESCE 原子递增等）与失败注入能力，
// 同时把写入落到 FakeDb 内存行（Object.assign 语义与 FakeDb.update 一致）。
let instrumentedDb: import("./helpers/fake-db").FakeDb | null = null;
function getInstrumentedDb(): import("./helpers/fake-db").FakeDb {
  if (!instrumentedDb) {
    instrumentedDb = Object.create(fakeDb) as import("./helpers/fake-db").FakeDb;
    instrumentedDb.insert = ((table: any) => ({
      values: async (values: unknown) => {
        const name = table[TABLE_NAME] as string;
        if (name === "token_usage") {
          state.tokenUsageInsertAttempted = true;
          if (state.failNextTokenUsageInsert) {
            state.failNextTokenUsageInsert = false;
            throw new Error("forced token_usage insert failure");
          }
        }
        state.insertCalls.push({ table: name, values });
        return (fakeDb.insert(table) as any).values(values);
      },
    }) as never);
    instrumentedDb.update = ((table: any) => ({
      set: (set: AnyRow) => ({
        where: async (where: unknown) => {
          state.updateCalls.push({ table: table[TABLE_NAME], set, where });
          return (fakeDb.update(table) as any).set(set).where(where);
        },
      }),
    }) as never);
  }
  return instrumentedDb;
}

vi.mock("../../api/ws-manager", () => ({
  wsManager: {
    broadcastToDashboard: vi.fn(),
    broadcast: vi.fn(),
    sendToAgent: vi.fn(),
    isOnline: vi.fn(() => false),
  },
}));

vi.mock("../../api/lib/collaboration-events", () => ({
  emitCollabSummaryForTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../api/lib/task-finalize", () => ({
  finalizeCompletedTask: vi.fn().mockResolvedValue(undefined),
}));

// §3-4：回写路径改为持久入队（队列模块整体 mock，避免真实队列碰假 DB）
const finalizeQueueMocks = vi.hoisted(() => ({
  enqueueTaskFinalize: vi.fn().mockResolvedValue({ enqueued: true }),
}));
vi.mock("../../api/lib/finalize-actions", () => ({
  enqueueTaskFinalize: finalizeQueueMocks.enqueueTaskFinalize,
}));

vi.mock("../../api/lib/password", () => ({
  hashPassword: vi.fn(async (s: string) => `hashed_${s}`),
  verifyPassword: vi.fn(async (s: string, h: string) => h === `hashed_${s}`),
}));

import { taskboardRouter } from "../../api/taskboard-router";
import { agentRouter } from "../../api/agent-router";
import { finalizeCompletedTask } from "../../api/lib/task-finalize";
import { createCallerFactory } from "../../api/middleware";

const taskCaller = createCallerFactory(taskboardRouter);
const agentCaller = createCallerFactory(agentRouter);

/** 从 drizzle SQL chunk 树中提取绑定参数值（Param.value 与内联原始值），跳过列与字符串片段 */
function sqlParams(node: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (n: unknown): void => {
    if (n === null || n === undefined) return;
    const t = typeof n;
    if (t === "string") return; // 文本片段
    // drizzle 对可安全内联的原始值（数字等）直接作为 chunk 放入 queryChunks
    if (t === "number" || t === "boolean" || t === "bigint" || n instanceof Date) {
      out.push(n);
      return;
    }
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    const obj = n as Record<string, unknown>;
    if (Array.isArray(obj.queryChunks)) {
      (obj.queryChunks as unknown[]).forEach(visit);
      return;
    }
    // drizzle StringChunk: { value: string[] } — 文本片段，跳过
    if (Array.isArray(obj.value) && obj.value.length > 0 && typeof obj.value[0] === "string") return;
    if ("value" in obj) {
      out.push(obj.value);
      return;
    }
  };
  visit(node);
  return out;
}

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

/** 常用任务行：id=7, agentId=5, 低风险（不触发完成闸门） */
function seedTask(overrides: AnyRow = {}) {
  fakeDb.tables.get("tasks")!.push({
    id: 7,
    task_id: "TG-EXT1",
    name: "external writeback task",
    description: null,
    input: null,
    output: null,
    agent_id: 5,
    status: "running",
    lifecycle_status: "working",
    state_revision: 1,
    origin_system: null,
    ...overrides,
  });
}

/** 定价行：input $0.001/1K，output $0.002/1K，cached $0.0001/1K（统一价，非分层） */
function seedPricing(model = "test-model") {
  fakeDb.tables.get("model_pricing")!.push({
    model,
    inputPrice: "0.001",
    outputPrice: "0.002",
    cachedInputPrice: "0.0001",
    notes: null,
  });
}

beforeEach(() => {
  // Phase B §2 起认领有就绪闸门；本文件测的是预算/记账/产物通道，需先声明系统已就绪
  markSystemReady();
  vi.clearAllMocks();
  fakeDb.reset();
  state.insertCalls = [];
  state.updateCalls = [];
  state.failNextTokenUsageInsert = false;
  state.tokenUsageInsertAttempted = false;
});

// ─── A. 微美元 → 美分换算（1 美分 = 10,000 微美元） ───
describe("microsToCents 换算", () => {
  it.each([
    [12345, 1], // 1.2345 美分 → 四舍五入 1
    [4999, 0], // 0.4999 美分 → 0
    [15000, 2], // 1.5 美分 → 半数进位 2
    [0, 0],
    [3000000, 300],
  ])("%d 微美元 → %d 美分", async (micros, cents) => {
    const mod = await import("../../api/lib/external-usage");
    expect(mod.microsToCents(micros)).toBe(cents);
  });
});

// ─── B. updateProgress usage 记账 ───
describe("updateProgress 外部用量记账", () => {
  it("完成时带 usage → 写 token_usage 并原子递增 spentCents", async () => {
    seedTask();
    seedPricing();

    const caller = taskCaller(mockCtx());
    const result = await caller.progress({
      id: 7,
      progress: 100,
      status: "done",
      lifecycleStatus: "completed",
      output: "ok",
      usage: { model: "test-model", promptTokens: 1_000_000, completionTokens: 1_000_000 },
    });

    expect(result.success).toBe(true);

    // token_usage 插入值：1M uncached × $0.001/1K = $1 + 1M completion × $0.002/1K = $2 → $3
    // costMicros = 3,000,000；换算 300 美分
    const usageInsert = state.insertCalls.find((c) => c.table === "token_usage");
    expect(usageInsert).toBeDefined();
    expect(usageInsert?.values).toMatchObject({
      model: "test-model",
      provider: "external",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
      cachedPromptTokens: 0,
      uncachedPromptTokens: 1_000_000,
      callCount: 1,
      costCents: 300,
      costMicros: 3_000_000,
      source: "external",
      taskId: 7,
      agentId: 5,
    });

    // agents.spentCents 原子递增：COALESCE(spentCents,0) + 300，where id=5
    const agentUpdate = state.updateCalls.find((c) => c.table === "agents");
    expect(agentUpdate).toBeDefined();
    expect(agentUpdate?.set.spentCents).toBeDefined();
    expect(sqlParams(agentUpdate?.set.spentCents)).toContain(300);
    expect(sqlParams(agentUpdate?.where)).toContain(5);

    // §3-4：完成路径入队统一归档动作（由 finalize-actions worker 执行）
    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("cachedPromptTokens 参与分层计价（缓存折扣）", async () => {
    seedTask();
    seedPricing();

    const caller = taskCaller(mockCtx());
    await caller.progress({
      id: 7,
      progress: 100,
      status: "done",
      lifecycleStatus: "completed",
      usage: { model: "test-model", promptTokens: 1_000_000, completionTokens: 1_000_000, cachedPromptTokens: 400_000 },
    });

    // cached 400K × $0.0001/1K = $0.04；uncached 600K × $0.001/1K = $0.6；completion = $2 → $2.64
    const usageInsert = state.insertCalls.find((c) => c.table === "token_usage");
    expect(usageInsert?.values).toMatchObject({
      cachedPromptTokens: 400_000,
      uncachedPromptTokens: 600_000,
      costMicros: 2_640_000,
    });
    expect(sqlParams(state.updateCalls.find((c) => c.table === "agents")?.set.spentCents)).toContain(264);
  });

  it("记账抛错不影响任务完成", async () => {
    seedTask();
    seedPricing();
    state.failNextTokenUsageInsert = true;

    const caller = taskCaller(mockCtx());
    const result = await caller.progress({
      id: 7,
      progress: 100,
      status: "done",
      lifecycleStatus: "completed",
      usage: { model: "test-model", promptTokens: 100, completionTokens: 100 },
    });

    expect(state.tokenUsageInsertAttempted).toBe(true); // 确实尝试过记账
    expect(result.success).toBe(true); // 失败被吞掉，完成不受影响
    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("未完成任务带 usage 不记账（只在完成时入账）", async () => {
    seedTask();
    seedPricing();

    const caller = taskCaller(mockCtx());
    const result = await caller.progress({
      id: 7,
      progress: 40,
      status: "running",
      usage: { model: "test-model", promptTokens: 100, completionTokens: 100 },
    });

    expect(result.success).toBe(true);
    expect(state.insertCalls.find((c) => c.table === "token_usage")).toBeUndefined();
  });
});

// ─── B. updateProgress artifacts 通道 + 越权防护 ───
describe("updateProgress 长产物通道", () => {
  it("artifacts 逐条写入 task_artifacts（type=external_output）", async () => {
    seedTask();

    const caller = taskCaller(mockCtx());
    const result = await caller.progress({
      id: 7,
      progress: 60,
      status: "running",
      artifacts: [
        { name: "full-output.md", content: "# 报告\n正文…", mimeType: "text/markdown" },
        { name: "data.json", content: "{\"a\":1}" },
      ],
    });

    expect(result.success).toBe(true);
    const artifactInserts = state.insertCalls.filter((c) => c.table === "task_artifacts");
    expect(artifactInserts).toHaveLength(2);
    expect(artifactInserts[0]?.values).toMatchObject({
      taskId: 7,
      agentId: 5,
      type: "external_output",
      name: "full-output.md",
      content: "# 报告\n正文…",
      mimeType: "text/markdown",
    });
    expect(artifactInserts[1]?.values).toMatchObject({ name: "data.json", mimeType: null });
  });

  it("MCP Key 与任务认领人不符 → artifacts 提交 FORBIDDEN", async () => {
    seedTask();

    const caller = taskCaller(mockCtx({ user: null, apiKeyAgentId: 6 }));
    await expect(
      caller.progress({
        id: 7,
        progress: 100,
        status: "done",
        artifacts: [{ name: "evil.md", content: "spoofed" }],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.insertCalls.find((c) => c.table === "task_artifacts")).toBeUndefined();
  });

  it("MCP Key 与任务认领人不符 → usage 提交 FORBIDDEN", async () => {
    seedTask();
    seedPricing();

    const caller = taskCaller(mockCtx({ user: null, apiKeyAgentId: 6 }));
    await expect(
      caller.progress({
        id: 7,
        progress: 100,
        status: "done",
        usage: { model: "test-model", promptTokens: 10, completionTokens: 10 },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(state.insertCalls.find((c) => c.table === "token_usage")).toBeUndefined();
  });

  it("MCP Key 与认领人匹配 → 产物提交并完成（走 finalize）", async () => {
    seedTask();

    const caller = taskCaller(mockCtx({ user: null, apiKeyAgentId: 5 }));
    const result = await caller.progress({
      id: 7,
      progress: 100,
      status: "done",
      lifecycleStatus: "completed",
      output: "ok",
      artifacts: [{ name: "full-output.md", content: "全文".repeat(10), mimeType: "text/markdown" }],
    });

    expect(result.success).toBe(true);
    expect(state.insertCalls.find((c) => c.table === "task_artifacts")?.values).toMatchObject({
      type: "external_output",
      name: "full-output.md",
    });
    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "completed" }),
    );
  });

  it("artifacts 超限被 zod 拒绝（content > 50000 或条数 > 5）", async () => {
    seedTask();
    const caller = taskCaller(mockCtx());

    await expect(
      caller.progress({
        id: 7,
        progress: 60,
        status: "running",
        artifacts: [{ name: "big.md", content: "x".repeat(50_001) }],
      })
    ).rejects.toThrow();

    await expect(
      caller.progress({
        id: 7,
        progress: 60,
        status: "running",
        artifacts: Array.from({ length: 6 }, (_, i) => ({ name: `a${i}.md`, content: "x" })),
      })
    ).rejects.toThrow();
  });
});

// ─── C. 认领预算熔断（claimTask / updateHeartbeat） ───
describe("认领预算熔断", () => {
  function seedAgents(agent: AnyRow) {
    // FakeDb 底层按 db 列名存储；显式 id=5（否则自动发号成 1，与任务的 agent_id=5 对不上）
    fakeDb.tables.get("agents")!.push({ id: 5, agent_id: "dsh-runner", name: "dsh-runner", system: "dsh", status: "idle", budget_cents: 0, spent_cents: 0, ...agent });
  }
  function seedQueuedTask() {
    fakeDb.tables.get("tasks")!.push({
      id: 9,
      task_id: "TG-Q1",
      name: "low risk queued task",
      description: null,
      input: null,
      output: null,
      agent_id: 5,
      status: "queued",
      lifecycle_status: "queued",
      board_status: null,
      priority: 1,
    });
  }

  it("claimTask：预算耗尽 → 无任务 + budget_exhausted，且不写 tasks", async () => {
    seedAgents({ budget_cents: 100, spent_cents: 150 });
    seedQueuedTask();

    const caller = agentCaller(mockCtx({ user: null, apiKeyAgentId: 5 }));
    const result = await caller.claimTask({ agentId: 5 });

    expect(result.task).toBeNull();
    expect(result.reason).toBe("budget_exhausted");
    // 轻量方案：不改任务状态（不认领、不停放），预算恢复后任务仍可自动认领
    expect(state.updateCalls.filter((c) => c.table === "tasks")).toHaveLength(0);
  });

  it("claimTask：预算正常 → 照常认领", async () => {
    seedAgents({ budget_cents: 1000, spent_cents: 100 });
    seedQueuedTask();

    const caller = agentCaller(mockCtx({ user: null, apiKeyAgentId: 5 }));
    const result = await caller.claimTask({ agentId: 5 });

    expect(result.task).not.toBeNull();
    expect(result.task?.id).toBe(9);
    expect(state.updateCalls.some((c) => c.table === "tasks")).toBe(true);
  });

  it("updateHeartbeat：预算耗尽 → claimedTask=null + claimReason，不停放任务", async () => {
    seedAgents({ budget_cents: 100, spent_cents: 200 });
    seedQueuedTask();

    const caller = agentCaller(mockCtx({ user: null, apiKeyAgentId: 5 }));
    const result = await caller.updateHeartbeat({ id: 5 });

    expect(result.success).toBe(true);
    expect(result.claimedTask).toBeNull();
    expect(result.claimReason).toBe("budget_exhausted");
    // 任务保持 queued（不写 tasks 表，无 boardStatus 停放）
    expect(state.updateCalls.filter((c) => c.table === "tasks")).toHaveLength(0);
  });

  it("updateHeartbeat：budgetCents=0（不限额）→ 照常认领", async () => {
    seedAgents({ budget_cents: 0, spent_cents: 999_999 });
    seedQueuedTask();

    const caller = agentCaller(mockCtx({ user: null, apiKeyAgentId: 5 }));
    const result = await caller.updateHeartbeat({ id: 5 });

    expect(result.claimedTask?.id).toBe(9);
    expect(result.claimReason ?? null).toBeNull();
  });
});
