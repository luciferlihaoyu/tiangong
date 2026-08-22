import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletedTaskView } from "../../api/lib/xuanji-sync";
import type { Db } from "../../api/lib/xuanji-sync";

// ─── Mock 两个归档接收端（finalize 的全部下游），验证 helper 自身的编排行为 ───
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

/** db 哨兵：验证原样透传给两个 sync，不做任何改写 */
const dbSentinel = { __db: true } as unknown as Db;

const completedTask: CompletedTaskView = {
  id: 19,
  taskId: "T-FIN01",
  name: "计算 17*23",
  description: "只回答数字结果",
  input: JSON.stringify({ payload: "计算并返回 17*23" }),
  output: "391",
  agentId: 16,
  status: "done",
  lifecycleStatus: "completed",
};

describe("finalizeCompletedTask（任务完成统一归档入口）", () => {
  beforeEach(() => {
    syncMocks.syncTaskMemoryToXuanji.mockReset().mockResolvedValue({ synced: true, reason: "written" });
    syncMocks.syncTaskArtifactsToAlist.mockReset().mockResolvedValue({ synced: true, reason: "uploaded" });
  });

  it("Given a completed task, When finalize runs, Then syncTaskMemoryToXuanji and syncTaskArtifactsToAlist are each called once, in that order, with (db, task) forwarded unchanged", async () => {
    // When
    await finalizeCompletedTask(dbSentinel, completedTask);

    // Then: 两个 sync 各被调用一次
    expect(syncMocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(1);
    expect(syncMocks.syncTaskArtifactsToAlist).toHaveBeenCalledTimes(1);
    // 传参：db 与 task 原样透传
    expect(syncMocks.syncTaskMemoryToXuanji).toHaveBeenCalledWith(dbSentinel, completedTask);
    expect(syncMocks.syncTaskArtifactsToAlist).toHaveBeenCalledWith(dbSentinel, completedTask);
    // 顺序：先璇玑记忆，后 AList 上传（与原内部 Runner 行为一致）
    const xuanjiOrder = syncMocks.syncTaskMemoryToXuanji.mock.invocationCallOrder[0];
    const alistOrder = syncMocks.syncTaskArtifactsToAlist.mock.invocationCallOrder[0];
    expect(xuanjiOrder).toBeDefined();
    expect(alistOrder).toBeDefined();
    expect(xuanjiOrder!).toBeLessThan(alistOrder!);
  });

  it("Given the Xuanji sync rejects, When finalize runs, Then it does not throw and the AList sync still runs", async () => {
    // Given: 璇玑 mock 直接 reject（模拟未来 sync 行为变化破坏非致命保证）
    syncMocks.syncTaskMemoryToXuanji.mockRejectedValue(new Error("xuanji down"));

    // When / Then: helper 自身兜底，不向完成路径抛错
    await expect(finalizeCompletedTask(dbSentinel, completedTask)).resolves.toBeUndefined();
    expect(syncMocks.syncTaskArtifactsToAlist).toHaveBeenCalledTimes(1);
  });

  it("Given the AList sync rejects, When finalize runs, Then it does not throw and the Xuanji sync has already run", async () => {
    // Given: AList mock 直接 reject
    syncMocks.syncTaskArtifactsToAlist.mockRejectedValue(new Error("alist down"));

    // When / Then
    await expect(finalizeCompletedTask(dbSentinel, completedTask)).resolves.toBeUndefined();
    expect(syncMocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(1);
  });
});
