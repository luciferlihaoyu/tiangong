/**
 * 任务 3.2：协作汇总报告 LLM 总结增强（集成层，默认关）
 *
 * 覆盖：
 *   - 开关关闭：autoSummarizeCollab 完全不动 LLM 路径，行为与 HEAD 一致
 *   - 开关开启 + LLM 成功：summary 文本头部插入 ## AI 总结 段 + recordExternalUsage 记账
 *   - 开关开启 + LLM 抛错 / 返回 null：降级到原模板，无 ## AI 总结 段、无冒泡
 *
 * 默认关：TIANGONG_SUMMARY_LLM_ENABLED 严格等于 "true" 才走 LLM；其他值（含未设置、false、TRUE 等）一律 OFF。
 *
 * 注意：summarizer 模块在本文件中整体 mock（vi.mock 顶层注册，对整个文件生效），
 * 对 summarizeCollabWithTianshu 自身的单元测试（未配置返回 null / 超时不抛错 / usage
 * 提取）见 tests/api/summarizer.test.ts —— 该文件不走 mock，直接覆盖真实实现。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock summarizer 模块（autoSummarizeCollab 集成层测试不调真实 LLM）───
const summarizerMocks = vi.hoisted(() => ({
  summarizeCollabWithTianshu: vi.fn(),
}));

vi.mock("../../api/lib/summarizer", () => ({
  summarizeCollabWithTianshu: summarizerMocks.summarizeCollabWithTianshu,
}));

// ─── Mock recordExternalUsage（记账走公共 helper，解耦 DB）───
const externalUsageMocks = vi.hoisted(() => ({
  recordExternalUsage: vi.fn(),
  microsToCents: vi.fn((c: number) => Math.round(c / 10000)),
}));

vi.mock("../../api/lib/external-usage", () => ({
  recordExternalUsage: externalUsageMocks.recordExternalUsage,
  microsToCents: externalUsageMocks.microsToCents,
}));

// ─── Mock database（沿用 collab-summary.test.ts 的 FIFO select 队列模式）───
const dbMocks = vi.hoisted(() => {
  let selectResults: ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>> = [];
  const updateSets: Array<Readonly<Record<string, unknown>>> = [];
  const insertValues: Array<Readonly<Record<string, unknown>>> = [];

  const consumeSelectResult = (): ReadonlyArray<Readonly<Record<string, unknown>>> => {
    const result = selectResults[0] ?? [];
    selectResults = selectResults.slice(1);
    return result;
  };

  const chained = (value: ReadonlyArray<Readonly<Record<string, unknown>>>) => ({
    where: vi.fn(() => chained(value)),
    orderBy: vi.fn(() => chained(value)),
    limit: vi.fn(() => Promise.resolve(value)),
    then: (
      onFulfilled: (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) => unknown
    ) => Promise.resolve(value).then(onFulfilled),
  });

  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => chained(consumeSelectResult())) })),
    update: vi.fn(() => ({
      set: vi.fn((values: Readonly<Record<string, unknown>>) => {
        updateSets.push(values);
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Readonly<Record<string, unknown>>) => {
        insertValues.push(values);
        return Promise.resolve({ insertId: 1 });
      }),
    })),
  };

  return {
    db,
    updateSets,
    insertValues,
    queueSelectResults: (results: ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>>) => {
      selectResults = results;
    },
    pendingSelects: (): number => selectResults.length,
    clearAll: () => {
      updateSets.length = 0;
      insertValues.length = 0;
    },
  };
});

vi.mock("../../api/queries/connection", () => ({ getDb: () => dbMocks.db }));

// ─── Mock 归档接收端 + finalize helper（与 collab-summary.test.ts 一致）───
const syncMocks = vi.hoisted(() => ({
  syncTaskMemoryToXuanji: vi.fn(),
  syncTaskArtifactsToAlist: vi.fn(),
}));

vi.mock("../../api/lib/xuanji-sync", () => ({
  syncTaskMemoryToXuanji: syncMocks.syncTaskMemoryToXuanji,
}));

vi.mock("../../api/lib/alist-sync", () => ({
  syncTaskArtifactsToAlist: syncMocks.syncTaskArtifactsToAlist,
}));

import { autoSummarizeCollab } from "../../api/lib/task-validator";

// ─── 测试数据（与 collab-summary.test.ts 同形）───
const parentRow: Readonly<Record<string, unknown>> = {
  id: 100,
  taskId: "TG-SUM100",
  name: "市场调研汇总",
  description: "汇总子任务结果",
  input: JSON.stringify({ payload: "做一次市场调研" }),
  output: null,
  agentId: 9,
  status: "running",
  lifecycleStatus: "working",
  parentTaskId: null,
};

const childRowA: Readonly<Record<string, unknown>> = {
  id: 101,
  taskId: "C2S-01",
  name: "子任务一",
  parentTaskId: 100,
  agentId: 2,
  status: "done",
  output: "结果一".repeat(50), // ~150 字
  error: null,
};
const childRowB: Readonly<Record<string, unknown>> = {
  id: 102,
  taskId: "C2S-02",
  name: "子任务二",
  parentTaskId: 100,
  agentId: 3,
  status: "done",
  output: "结果二".repeat(50),
  error: null,
};

const agentRows: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  { id: 2, name: "Agent 甲" },
  { id: 3, name: "Agent 乙" },
];

/** happy path 4 次 select：幂等闸 / 父任务 / 子任务 / agent */
const happyPathSelects = (): ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>> => [
  [], // 幂等闸
  [parentRow], // 父任务
  [childRowA, childRowB], // 子任务
  agentRows,
];

describe("autoSummarizeCollab 集成 LLM 总结（开关关闭 / 默认）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.clearAll();
    syncMocks.syncTaskMemoryToXuanji.mockReset().mockResolvedValue({ synced: true, reason: "written" });
    syncMocks.syncTaskArtifactsToAlist.mockReset().mockResolvedValue({ synced: true, reason: "uploaded" });
  });

  it("Given TIANGONG_SUMMARY_LLM_ENABLED 未设置（默认）, When autoSummarizeCollab, Then 完全不动 LLM 路径", async () => {
    // Given: 默认 env（未 stub），TLSE 必为 undefined
    delete process.env.TIANGONG_SUMMARY_LLM_ENABLED;
    dbMocks.queueSelectResults(happyPathSelects());

    // When
    const result = await autoSummarizeCollab(100);

    // Then: 汇总正常生成，但 LLM 模块零调用、记账零调用
    expect(result).not.toBeNull();
    expect(summarizerMocks.summarizeCollabWithTianshu).not.toHaveBeenCalled();
    expect(externalUsageMocks.recordExternalUsage).not.toHaveBeenCalled();

    // Then: 父任务 output 无 ## AI 总结 段（保持 HEAD 行为）
    const parentOutput = String(dbMocks.updateSets[0]?.output ?? "");
    expect(parentOutput).not.toContain("## AI 总结");
    // Then: 保留原模板特征字段
    expect(parentOutput).toContain("## 协作任务汇总: 市场调研汇总");
    expect(parentOutput).toContain("2/2 完成");
  });

  it("Given TIANGONG_SUMMARY_LLM_ENABLED=false（其他非 'true' 值）, When autoSummarizeCollab, Then 仍关闭", async () => {
    // Given
    process.env.TIANGONG_SUMMARY_LLM_ENABLED = "false";
    dbMocks.queueSelectResults(happyPathSelects());

    // When
    await autoSummarizeCollab(100);

    // Then: 不调 LLM、不记账、文本无 AI 总结
    expect(summarizerMocks.summarizeCollabWithTianshu).not.toHaveBeenCalled();
    expect(externalUsageMocks.recordExternalUsage).not.toHaveBeenCalled();
    const parentOutput = String(dbMocks.updateSets[0]?.output ?? "");
    expect(parentOutput).not.toContain("## AI 总结");
  });
});

describe("autoSummarizeCollab 集成 LLM 总结（开关开启）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.clearAll();
    syncMocks.syncTaskMemoryToXuanji.mockReset().mockResolvedValue({ synced: true, reason: "written" });
    syncMocks.syncTaskArtifactsToAlist.mockReset().mockResolvedValue({ synced: true, reason: "uploaded" });
    process.env.TIANGONG_SUMMARY_LLM_ENABLED = "true";
  });

  it("Given 开关开 + LLM 返回文本 + 用量, When autoSummarizeCollab, Then 文本头部插入 ## AI 总结 段, 且位置在标题之后、状态计数之前", async () => {
    // Given
    summarizerMocks.summarizeCollabWithTianshu.mockResolvedValueOnce({
      text: "两个子任务均已完成，市场调研整体结论积极。",
      usage: { promptTokens: 200, completionTokens: 80, cachedPromptTokens: 50 },
      model: "deepseek-v3",
    });
    dbMocks.queueSelectResults(happyPathSelects());

    // When
    const result = await autoSummarizeCollab(100);

    // Then: 成功返回
    expect(result).not.toBeNull();
    expect(summarizerMocks.summarizeCollabWithTianshu).toHaveBeenCalledTimes(1);

    // Then: 父任务 output 头部含 AI 总结段、且位置正确
    const parentOutput = String(dbMocks.updateSets[0]?.output ?? "");
    const aiSummaryIdx = parentOutput.indexOf("## AI 总结");
    const titleIdx = parentOutput.indexOf("## 协作任务汇总");
    const statusIdx = parentOutput.indexOf("子任务: 2/2 完成");
    expect(aiSummaryIdx).toBeGreaterThanOrEqual(0);
    expect(titleIdx).toBeGreaterThanOrEqual(0);
    expect(statusIdx).toBeGreaterThan(titleIdx);
    // AI 总结段必须夹在标题与状态计数之间
    expect(aiSummaryIdx).toBeGreaterThan(titleIdx);
    expect(aiSummaryIdx).toBeLessThan(statusIdx);
    // AI 总结段内容含 LLM 返回文本
    expect(parentOutput).toContain("两个子任务均已完成");

    // Then: 验证传给 summarizer 的参数：2 条子任务摘要
    const callArg = summarizerMocks.summarizeCollabWithTianshu.mock.calls[0]?.[0];
    expect(callArg).toBeDefined();
    expect(Array.isArray(callArg)).toBe(true);
    expect(callArg).toHaveLength(2);
    expect(callArg?.[0]).toMatchObject({
      taskId: "C2S-01",
      name: "子任务一",
      status: "done",
    });

    // Then: recordExternalUsage 被调一次，参数含 taskId=parent.id(100)、source="summary_llm"、正确 tokens/model
    expect(externalUsageMocks.recordExternalUsage).toHaveBeenCalledTimes(1);
    const usageCall = externalUsageMocks.recordExternalUsage.mock.calls[0];
    expect(usageCall?.[0]).toBe(dbMocks.db); // db
    expect(usageCall?.[1]).toMatchObject({
      taskId: 100,
      model: "deepseek-v3",
      promptTokens: 200,
      completionTokens: 80,
      cachedPromptTokens: 50,
      source: "summary_llm",
    });
    // agentId 取自 parent.agentId = 9
    expect(usageCall?.[1]?.agentId).toBe(9);
  });

  it("Given 开关开 + LLM 抛错, When autoSummarizeCollab, Then 降级到原模板（无 ## AI 总结）, 不向调用方抛错", async () => {
    // Given
    summarizerMocks.summarizeCollabWithTianshu.mockRejectedValueOnce(new Error("upstream timeout"));
    dbMocks.queueSelectResults(happyPathSelects());

    // When / Then: 不抛错、返回正常结果
    const result = await autoSummarizeCollab(100);
    expect(result).not.toBeNull();

    // Then: 父任务 output 无 ## AI 总结 段；保留原模板特征
    const parentOutput = String(dbMocks.updateSets[0]?.output ?? "");
    expect(parentOutput).not.toContain("## AI 总结");
    expect(parentOutput).toContain("## 协作任务汇总: 市场调研汇总");

    // Then: 记账未触发（LLM 失败无 usage 可记）
    expect(externalUsageMocks.recordExternalUsage).not.toHaveBeenCalled();
  });

  it("Given 开关开 + LLM 返回 null（未配置 / 解析失败）, When autoSummarizeCollab, Then 同样降级到原模板", async () => {
    // Given
    summarizerMocks.summarizeCollabWithTianshu.mockResolvedValueOnce(null);
    dbMocks.queueSelectResults(happyPathSelects());

    // When
    const result = await autoSummarizeCollab(100);
    expect(result).not.toBeNull();

    // Then: 无 AI 总结段、无记账
    const parentOutput = String(dbMocks.updateSets[0]?.output ?? "");
    expect(parentOutput).not.toContain("## AI 总结");
    expect(parentOutput).toContain("## 协作任务汇总: 市场调研汇总");
    expect(externalUsageMocks.recordExternalUsage).not.toHaveBeenCalled();
  });

  it("Given 开关开 + LLM 成功但无 usage 字段, When autoSummarizeCollab, Then 仍插入 AI 总结段, 记账被调但 tokens 全 0", async () => {
    // Given: 部分 LLM 实现不返回 usage（fallback 路径，不算异常）
    summarizerMocks.summarizeCollabWithTianshu.mockResolvedValueOnce({
      text: "简要总结",
      usage: null,
      model: "deepseek-v3",
    });
    dbMocks.queueSelectResults(happyPathSelects());

    // When
    await autoSummarizeCollab(100);

    // Then: 文本插入成功
    expect(String(dbMocks.updateSets[0]?.output ?? "")).toContain("## AI 总结");
    // Then: 记账仍被触发（业务希望每次 LLM 调用都留痕，哪怕 usage 缺失）
    expect(externalUsageMocks.recordExternalUsage).toHaveBeenCalledTimes(1);
    const usageCall = externalUsageMocks.recordExternalUsage.mock.calls[0]?.[1];
    expect(usageCall?.promptTokens).toBe(0);
    expect(usageCall?.completionTokens).toBe(0);
  });

  it("Given 开关开 + 记账函数自身抛错, When autoSummarizeCollab, Then 仍完成汇总（记账失败不影响主流程）", async () => {
    // Given
    summarizerMocks.summarizeCollabWithTianshu.mockResolvedValueOnce({
      text: "总结",
      usage: { promptTokens: 100, completionTokens: 50 },
      model: "deepseek-v3",
    });
    externalUsageMocks.recordExternalUsage.mockImplementationOnce(() => {
      throw new Error("DB down");
    });
    dbMocks.queueSelectResults(happyPathSelects());

    // When / Then: 不冒泡
    const result = await autoSummarizeCollab(100);
    expect(result).not.toBeNull();
    // 文本仍含 AI 总结
    expect(String(dbMocks.updateSets[0]?.output ?? "")).toContain("## AI 总结");
  });

  it("Given 开关开 + 父任务 agentId 为 null, When autoSummarizeCollab, Then 记账 agentId=0（固定归属）", async () => {
    // Given: 父任务无 agent
    const orphanParent = { ...parentRow, agentId: null };
    dbMocks.queueSelectResults([
      [], // 幂等闸
      [orphanParent], // 父任务
      [childRowA, childRowB],
      agentRows,
    ]);
    summarizerMocks.summarizeCollabWithTianshu.mockResolvedValueOnce({
      text: "总结",
      usage: { promptTokens: 100, completionTokens: 50 },
      model: "deepseek-v3",
    });

    // When
    await autoSummarizeCollab(100);

    // Then: 记账 agentId=0
    expect(externalUsageMocks.recordExternalUsage).toHaveBeenCalledTimes(1);
    expect(externalUsageMocks.recordExternalUsage.mock.calls[0]?.[1]?.agentId).toBe(0);
  });

  // 3.2 评审 minor：子任务数 > 50 跳过 LLM 路径（成本 / token 上限防御）
  it("Given 开关开 + 51 个子任务, When autoSummarizeCollab, Then 完全不走 LLM、不记账，沿用原机械模板", async () => {
    // Given: 51 个已终态的子任务（模拟大批量协作场景）
    const largeChildren = Array.from({ length: 51 }, (_, i) => ({
      id: 200 + i,
      taskId: `C2S-L${i.toString().padStart(2, "0")}`,
      name: `子任务${i}`,
      parentTaskId: 100,
      agentId: 2,
      status: "done" as const,
      output: `结果${i}`,
      error: null,
    }));
    dbMocks.queueSelectResults([
      [], // 幂等闸
      [parentRow], // 父任务
      largeChildren, // 51 个子任务
      agentRows,
    ]);

    // When
    const result = await autoSummarizeCollab(100);

    // Then: 汇总正常完成、但 LLM 零调用、记账零调用
    expect(result).not.toBeNull();
    expect(summarizerMocks.summarizeCollabWithTianshu).not.toHaveBeenCalled();
    expect(externalUsageMocks.recordExternalUsage).not.toHaveBeenCalled();

    // Then: 父任务 output 无 ## AI 总结 段（沿用原模板）
    const parentOutput = String(dbMocks.updateSets[0]?.output ?? "");
    expect(parentOutput).not.toContain("## AI 总结");
    // Then: 51 个子任务的标题全部出现在汇总里（机械模板照常工作）
    expect(parentOutput).toContain("51/51 完成");
    expect(parentOutput).toContain("子任务0");
    expect(parentOutput).toContain("子任务50");
  });
});
