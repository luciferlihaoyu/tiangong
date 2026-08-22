import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock database（沿用 xuanji-sync.test.ts 的 FIFO select 队列模式）───
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

// ─── Mock 两个归档接收端：观察父任务双归档被触发，且不让真实连接器碰 mock db ───
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

import { finalizeCompletedTask } from "../../api/lib/task-finalize";
import { wsManager } from "../../api/ws-manager";

const mockDb = dbMocks.db as unknown as Parameters<typeof finalizeCompletedTask>[0];
type FinalizeView = Parameters<typeof finalizeCompletedTask>[1];

/** 父任务行（update 前读出的 DB 行，root 任务：parentTaskId=null → 汇总后不再向上链） */
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

/** 两个均已终态（done）的子任务行 */
const childRowA: Readonly<Record<string, unknown>> = {
  id: 101,
  taskId: "C2S-01",
  name: "子任务一",
  parentTaskId: 100,
  agentId: 2,
  status: "done",
  output: "结果一",
  error: null,
};
const childRowB: Readonly<Record<string, unknown>> = {
  id: 102,
  taskId: "C2S-02",
  name: "子任务二",
  parentTaskId: 100,
  agentId: 3,
  status: "done",
  output: "结果二",
  error: null,
};

const agentRows: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  { id: 2, name: "Agent 甲" },
  { id: 3, name: "Agent 乙" },
];

/** 子任务完成视图：显式携带 parentTaskId（task-runner 传整行时的形态） */
const childViewWithParent: FinalizeView = {
  id: 101,
  taskId: "C2S-01",
  name: "子任务一",
  description: "调研一部分",
  input: null,
  output: "结果一",
  agentId: 2,
  status: "done",
  lifecycleStatus: "completed",
  parentTaskId: 100,
};

/** 子任务完成视图：不携带 parentTaskId（六个既有调用点的形态 → helper 内部 PK 查询补齐） */
const childViewNoParent: FinalizeView = {
  id: 101,
  taskId: "C2S-01",
  name: "子任务一",
  description: "调研一部分",
  input: null,
  output: "结果一",
  agentId: 2,
  status: "done",
  lifecycleStatus: "completed",
};

/** 汇总路径在 db 上的完整 select 序列（happy path，无 PK 补齐查询） */
const happyPathSelects = (): ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>> => [
  [], // autoSummarizeCollab 幂等闸：task_artifacts 中无 collab_summary
  [parentRow], // 父任务行
  [childRowA, childRowB], // 子任务行
  agentRows, // 子任务 agent 名单
];

describe("协作任务自动汇总接线（finalizeCompletedTask → autoSummarizeCollab → 双归档）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.clearAll();
    syncMocks.syncTaskMemoryToXuanji.mockReset().mockResolvedValue({ synced: true, reason: "written" });
    syncMocks.syncTaskArtifactsToAlist.mockReset().mockResolvedValue({ synced: true, reason: "uploaded" });
  });

  it("Given 完成视图携带 parentTaskId 且全部兄弟子任务终态, When finalize, Then 父任务被写汇总、collab_summary artifact 插入、父任务双归档触发", async () => {
    // Given
    dbMocks.queueSelectResults(happyPathSelects());

    // When
    await finalizeCompletedTask(mockDb, childViewWithParent);

    // Then: 父任务 output/status/progress 被更新为汇总
    expect(dbMocks.updateSets).toHaveLength(1);
    const parentUpdate = dbMocks.updateSets[0];
    expect(String(parentUpdate?.output ?? "")).toContain("协作任务汇总: 市场调研汇总");
    expect(String(parentUpdate?.output ?? "")).toContain("2/2 完成");
    expect(parentUpdate?.status).toBe("done");
    expect(parentUpdate?.progress).toBe(100);

    // Then: collab_summary artifact 落库（content 正文 + markdown，走 AList 的 .md 通道）
    const summaryArtifacts = dbMocks.insertValues.filter((v) => v.type === "collab_summary");
    expect(summaryArtifacts).toHaveLength(1);
    const artifact = summaryArtifacts[0];
    expect(artifact?.taskId).toBe(100);
    expect(artifact?.agentId).toBe(9);
    expect(artifact?.name).toBe("collab-summary-TG-SUM100");
    expect(String(artifact?.content ?? "")).toContain("协作任务汇总");
    expect(artifact?.mimeType).toBe("text/markdown");
    expect(artifact?.jsonPayload).toBeUndefined();

    // Then: collab_summary 事件广播一次
    expect(wsManager.broadcastToDashboard).toHaveBeenCalledTimes(1);
    expect(wsManager.broadcastToDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ type: "collab_summary", parentTaskId: 100, overallStatus: "done", total: 2 })
    );

    // Then: 两个 sync 先子任务后父任务各一次——父任务双归档由此触发
    for (const syncMock of [syncMocks.syncTaskMemoryToXuanji, syncMocks.syncTaskArtifactsToAlist]) {
      expect(syncMock).toHaveBeenCalledTimes(2);
      expect(syncMock.mock.calls[0]?.[1]?.id).toBe(101); // 先：子任务自身
      const parentCall = syncMock.mock.calls[1];
      expect(parentCall?.[1]?.id).toBe(100); // 后：父任务（汇总视图）
      expect(String(parentCall?.[1]?.output ?? "")).toContain("协作任务汇总");
      expect(parentCall?.[1]?.status).toBe("done");
    }
    // 队列全部耗尽：父任务（root）不再触发额外查询，无循环
    expect(dbMocks.pendingSelects()).toBe(0);
  });

  it("Given 完成视图不携带 parentTaskId, When finalize, Then helper 内部 PK 查询补齐并仍触发针对正确父任务的汇总", async () => {
    // Given: 首个 select 结果是 PK 补齐查询的返回
    dbMocks.queueSelectResults([[{ parentTaskId: 100 }], ...happyPathSelects()]);

    // When
    await finalizeCompletedTask(mockDb, childViewNoParent);

    // Then: 汇总针对父任务 100 落库 + 广播
    expect(String(dbMocks.updateSets[0]?.output ?? "")).toContain("协作任务汇总: 市场调研汇总");
    expect(wsManager.broadcastToDashboard).toHaveBeenCalledWith(
      expect.objectContaining({ type: "collab_summary", parentTaskId: 100 })
    );
    expect(dbMocks.insertValues.some((v) => v.type === "collab_summary" && v.taskId === 100)).toBe(true);
    // 父任务双归档被触发
    expect(syncMocks.syncTaskMemoryToXuanji.mock.calls.some((call) => call[1]?.id === 100)).toBe(true);
    expect(syncMocks.syncTaskArtifactsToAlist.mock.calls.some((call) => call[1]?.id === 100)).toBe(true);
    expect(dbMocks.pendingSelects()).toBe(0);
  });

  it("Given 尚有子任务未终态, When finalize, Then 不汇总不广播不插 artifact（原有 no-op 行为保留）", async () => {
    // Given: 子任务二仍在 queued
    const childPending = { ...childRowB, status: "queued" };
    dbMocks.queueSelectResults([
      [{ parentTaskId: 100 }], // PK 补齐查询
      [], // 幂等闸
      [parentRow],
      [childRowA, childPending],
      agentRows,
    ]);

    // When
    await expect(finalizeCompletedTask(mockDb, childViewNoParent)).resolves.toBeUndefined();

    // Then: 仅子任务自身归档，父任务零写入、零广播
    expect(dbMocks.updateSets).toHaveLength(0);
    expect(dbMocks.insertValues.filter((v) => v.type === "collab_summary")).toHaveLength(0);
    expect(wsManager.broadcastToDashboard).not.toHaveBeenCalled();
    expect(syncMocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(1);
    expect(syncMocks.syncTaskArtifactsToAlist).toHaveBeenCalledTimes(1);
    // 流程确实走到了子任务终态判断（而非在幂等闸早退）后才 no-op
    expect(dbMocks.pendingSelects()).toBe(0);
  });

  it("Given 父任务已有 collab_summary artifact（并发重复触发）, When finalize 再次执行, Then 幂等闸直接返回、无重复广播/无重复插入", async () => {
    // Given: 第一次汇总成功（全队列耗尽）
    dbMocks.queueSelectResults(happyPathSelects());
    await finalizeCompletedTask(mockDb, childViewWithParent);
    expect(wsManager.broadcastToDashboard).toHaveBeenCalledTimes(1);
    const insertsAfterFirst = dbMocks.insertValues.filter((v) => v.type === "collab_summary").length;
    expect(insertsAfterFirst).toBe(1);

    // Given: 另一子任务并发完成，但父任务已有 collab_summary 标记
    dbMocks.queueSelectResults([[{ id: 555 }]]); // 幂等闸命中

    // When
    await expect(finalizeCompletedTask(mockDb, { ...childViewWithParent, id: 102, taskId: "C2S-02" })).resolves
      .toBeUndefined();

    // Then: 幂等闸后未消耗任何后续查询（父任务/子任务/agent 均未查）
    expect(dbMocks.pendingSelects()).toBe(0);
    // Then: 无重复广播、无重复插入、无重复父任务更新
    expect(wsManager.broadcastToDashboard).toHaveBeenCalledTimes(1);
    expect(dbMocks.insertValues.filter((v) => v.type === "collab_summary")).toHaveLength(1);
    expect(dbMocks.updateSets).toHaveLength(1);
    // Then: 该子任务自身的双归档仍正常执行。两次 finalize 的 sync 序列：
    //   [子101, 父100(第一次汇总), 子102] —— 第二次没有父任务重复归档
    expect(syncMocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(3);
    expect(syncMocks.syncTaskArtifactsToAlist).toHaveBeenCalledTimes(3);
    expect(syncMocks.syncTaskMemoryToXuanji.mock.calls.some((call) => call[1]?.id === 100 && call[1]?.taskId === "TG-SUM100")).toBe(true);
    expect(syncMocks.syncTaskMemoryToXuanji.mock.calls[2]?.[1]?.id).toBe(102); // 第二次 finalize 只有子任务 102
  });

  it("Given 汇总过程中抛错（广播失败）, When finalize, Then 不向完成路径抛错且子任务自身双归档已完成", async () => {
    // Given: 广播在汇总中途抛错（update/insert 之后）
    dbMocks.queueSelectResults(happyPathSelects());
    vi.mocked(wsManager.broadcastToDashboard).mockImplementationOnce(() => {
      throw new Error("ws down");
    });

    // When / Then: 汇总失败绝不影响完成路径
    await expect(finalizeCompletedTask(mockDb, childViewWithParent)).resolves.toBeUndefined();
    // 子任务自身的两个 sync 已先于汇总执行
    expect(syncMocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(1);
    expect(syncMocks.syncTaskArtifactsToAlist).toHaveBeenCalledTimes(1);
  });
});
