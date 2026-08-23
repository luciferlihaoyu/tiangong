/**
 * 评审 minor ④：recordTianshuUsageForTask 直接单测
 *
 * 背景：recordTianshuUsage 原本是 TaskRunner 私有方法，无直接单测（只能经 claimAndExecute
 * 端到端触发，难以构造天枢响应）。1.4 的 P0 把它改造成同时原子递增 agents.spentCents，但没有
 * 对应测试。本文件抽顶层函数后直接测：
 *   - 解析天枢 raw 响应 usage → 写一行 token_usage（provider=tianshu, source=runner）
 *   - agents.spentCents 原子递增：SQL 为 `COALESCE(spentCents, 0) + ?` 而非 read-modify-write
 *     （通过断言 set 值是 SQL 片段而非预计算数字 + 内联参数为应增美分数来证明）
 *   - 缓存命中字段（prompt_cache_hit_tokens）参与分层计价
 *   - 异常/无 usage/全 0 → 静默 no-op，不抛错
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { recordTianshuUsageForTask } from "../../api/lib/task-runner";
import type { DbRow } from "./helpers/fake-db";

// ─── 按表名路由的 mock db（可断言 SQL 参数，照抄 external-writeback.test.ts 模式） ───
const mocks = vi.hoisted(() => {
  const TABLE_NAME = Symbol.for("drizzle:Name");
  const state = {
    rows: {} as Record<string, DbRow[]>,
    insertCalls: [] as Array<{ table: string; values: Record<string, unknown> }>,
    updateCalls: [] as Array<{ table: string; set: Record<string, unknown>; where: unknown }>,
    failNextTokenUsageInsert: false,
  };
  const rowsOf = (table: string): DbRow[] => state.rows[table] ?? [];

  const makeChain = (table: string): any => {
    const chain: Record<string, unknown> = {
      where: () => chain,
      orderBy: () => chain,
      limit: () => chain,
      then: (onDone: (rows: DbRow[]) => unknown) => Promise.resolve(rowsOf(table)).then(onDone),
    };
    return chain;
  };

  const mockDb = {
    select: vi.fn(() => ({
      from: vi.fn((table: any) => makeChain(table[TABLE_NAME] as string)),
    })),
    insert: vi.fn((table: any) => ({
      values: vi.fn((values: Record<string, unknown>) => {
        const name = table[TABLE_NAME] as string;
        if (name === "token_usage" && state.failNextTokenUsageInsert) {
          state.failNextTokenUsageInsert = false;
          return Promise.reject(new Error("forced token_usage insert failure"));
        }
        state.insertCalls.push({ table: name, values });
        return Promise.resolve({ insertId: 1 });
      }),
    })),
    update: vi.fn((table: any) => ({
      set: vi.fn((set: Record<string, unknown>) => ({
        where: vi.fn((where: unknown) => {
          state.updateCalls.push({ table: table[TABLE_NAME] as string, set, where });
          return Promise.resolve({ affectedRows: 1 });
        }),
      })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve({ affectedRows: 0 })) })),
  };

  return { state, mockDb };
});

const { state, mockDb } = mocks;

vi.mock("../../api/queries/connection", () => ({ getDb: () => mocks.mockDb }));

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

vi.mock("../../api/lib/task-concurrency", () => ({
  acquireTaskSlot: vi.fn().mockResolvedValue({ acquired: true }),
  releaseTaskSlot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../api/lib/executor-cancellation", () => ({
  registerExecutor: vi.fn(() => ({ aborted: false })),
  unregisterExecutor: vi.fn(),
  requestExecutorCancellation: vi.fn(() => true),
}));

vi.mock("../../api/connectors/xuanji/service", () => ({
  createXuanjiClient: vi.fn(),
}));

// ─── 定价行：input $0.001/1K，output $0.002/1K，cached $0.0001/1K（统一价，非分层） ───
// 注意：mock 的 select 直接透传存储行（drizzle 属性名），故用 camelCase 属性键。
function seedPricing(model = "test-model") {
  state.rows.model_pricing = [
    { model, inputPrice: "0.001", outputPrice: "0.002", cachedInputPrice: "0.0001", notes: null },
  ];
}

/** 从 drizzle SQL chunk 树中提取绑定参数值（跳过列与字符串片段） */
function sqlParams(node: unknown): unknown[] {
  const out: unknown[] = [];
  const visit = (n: unknown): void => {
    if (n === null || n === undefined) return;
    const t = typeof n;
    if (t === "string") return; // 文本片段
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
    if (Array.isArray(obj.value) && obj.value.length > 0 && typeof obj.value[0] === "string") return;
    if ("value" in obj) {
      out.push(obj.value);
      return;
    }
  };
  visit(node);
  return out;
}

/** 从 drizzle SQL chunk 树中提取文本片段（断言 SQL 形态：COALESCE + "+" 原子递增） */
function sqlText(node: unknown): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(sqlText).join("");
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.queryChunks)) return sqlText(obj.queryChunks);
  if (Array.isArray(obj.value) && obj.value.length > 0 && typeof obj.value[0] === "string") {
    return (obj.value as string[]).join("");
  }
  return "";
}

beforeEach(() => {
  vi.clearAllMocks();
  state.rows = {};
  state.insertCalls = [];
  state.updateCalls = [];
});

describe("recordTianshuUsageForTask（天枢用量记账直接单测）", () => {
  it("写一行 token_usage（provider=tianshu, source=runner）+ agents.spentCents 原子递增 300 美分", async () => {
    seedPricing();
    const raw = JSON.stringify({
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
      choices: [{ message: { content: "ok" } }],
    });

    await recordTianshuUsageForTask(raw, "test-model", { id: 7, taskId: "TG-TIANSHU1", agentId: 5 }, mockDb);

    // token_usage 恰好 1 行：1M uncached × $0.001/1K = $1 + 1M completion × $0.002/1K = $2 → $3
    const usageInsert = state.insertCalls.find((c) => c.table === "token_usage");
    expect(state.insertCalls.filter((c) => c.table === "token_usage")).toHaveLength(1);
    expect(usageInsert?.values).toMatchObject({
      model: "test-model",
      provider: "tianshu",
      source: "runner",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      totalTokens: 2_000_000,
      cachedPromptTokens: 0,
      uncachedPromptTokens: 1_000_000,
      callCount: 1,
      costCents: 300,
      costMicros: 3_000_000,
      taskId: 7,
      agentId: 5,
    });

    // spentCents 原子递增：SQL 是 COALESCE(spentCents, 0) + 300 的片段，而非 read-modify-write 预计算数字
    const agentUpdate = state.updateCalls.find((c) => c.table === "agents");
    expect(agentUpdate).toBeDefined();
    expect(typeof agentUpdate?.set.spentCents).not.toBe("number");
    expect(sqlText(agentUpdate?.set.spentCents)).toContain("COALESCE");
    expect(sqlText(agentUpdate?.set.spentCents)).toContain("+");
    expect(sqlParams(agentUpdate?.set.spentCents)).toContain(300);
    // where id=5（任务所属 agent）
    expect(sqlParams(agentUpdate?.where)).toContain(5);
  });

  it("缓存命中（prompt_cache_hit_tokens）参与分层计价并扣除缓存成本", async () => {
    seedPricing();
    const raw = JSON.stringify({
      usage: {
        prompt_tokens: 1_000_000,
        completion_tokens: 1_000_000,
        prompt_cache_hit_tokens: 400_000,
      },
      choices: [{ message: { content: "ok" } }],
    });

    await recordTianshuUsageForTask(raw, "test-model", { id: 7, taskId: "TG-TIANSHU1", agentId: 5 }, mockDb);

    // cached 400K × $0.0001/1K = $0.04；uncached 600K × $0.001/1K = $0.6；completion = $2 → $2.64
    const usageInsert = state.insertCalls.find((c) => c.table === "token_usage");
    expect(usageInsert?.values).toMatchObject({
      cachedPromptTokens: 400_000,
      uncachedPromptTokens: 600_000,
      costMicros: 2_640_000,
    });
    const agentUpdate = state.updateCalls.find((c) => c.table === "agents");
    expect(sqlParams(agentUpdate?.set.spentCents)).toContain(264);
  });

  it("usage 缺失 / 全 0 / 无 agentId 时静默 no-op，不写任何行", async () => {
    seedPricing();
    // usage 缺失
    await recordTianshuUsageForTask(JSON.stringify({ choices: [] }), "test-model", { id: 7, taskId: "TG-T1", agentId: 5 }, mockDb);
    // usage 全 0
    await recordTianshuUsageForTask(
      JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0 } }),
      "test-model",
      { id: 7, taskId: "TG-T1", agentId: 5 },
      mockDb
    );
    // 有 usage 但任务无 agentId → 只写 token_usage，不递增任何 agent 预算
    await recordTianshuUsageForTask(
      JSON.stringify({ usage: { prompt_tokens: 1_000, completion_tokens: 1_000 } }),
      "test-model",
      { id: 7, taskId: "TG-T1", agentId: null },
      mockDb
    );

    expect(state.insertCalls.filter((c) => c.table === "token_usage")).toHaveLength(1);
    const lastInsert = state.insertCalls.find((c) => c.table === "token_usage");
    expect(lastInsert?.values.agentId).toBeUndefined();
    expect(state.updateCalls.filter((c) => c.table === "agents")).toHaveLength(0);
  });

  it("解析失败 / DB 抛错时静默 no-op，绝不向调用方抛错", async () => {
    seedPricing();
    // 非法 JSON
    await expect(
      recordTianshuUsageForTask("not-json{{{", "test-model", { id: 7, taskId: "TG-T1", agentId: 5 }, mockDb)
    ).resolves.toBeUndefined();
    // DB 抛错（token_usage insert 被拒）
    state.failNextTokenUsageInsert = true;
    await expect(
      recordTianshuUsageForTask(
        JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 100 } }),
        "test-model",
        { id: 7, taskId: "TG-T1", agentId: 5 },
        mockDb
      )
    ).resolves.toBeUndefined();
    // 失败被吞掉：不产生任何成功入账
    expect(state.insertCalls.filter((c) => c.table === "token_usage")).toHaveLength(0);
  });
});
