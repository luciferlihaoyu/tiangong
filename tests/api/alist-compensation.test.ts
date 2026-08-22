import { beforeEach, describe, expect, it, vi } from "vitest";
import { tasks, taskArtifacts } from "@db/schema";

// ─── FakeDb（真实评估 drizzle where 条件）+ mocked alist-sync ───
// 与 sweepers.test.ts 的 queued-results mock 不同：这里的场景需要 where 条件
// （lookback 窗口、or(lifecycle/status)、幂等 type 检查）被真正求值，因此用
// tests/api/helpers/fake-db.ts 的求值型 fake。
const shared = vi.hoisted(() => ({ db: null as unknown as import("./helpers/fake-db").FakeDb }));

vi.mock("../../api/queries/connection", async () => {
  const mod = await import("./helpers/fake-db");
  mod.fakeDbRegistry.instance = mod.createFakeDb();
  shared.db = mod.fakeDbRegistry.instance;
  return { getDb: () => mod.fakeDbRegistry.instance };
});

const alistMocks = vi.hoisted(() => ({
  syncTaskArtifactsToAlist: vi.fn(async () => ({ synced: true, reason: "uploaded" as const })),
}));

vi.mock("../../api/lib/alist-sync", () => ({
  ALIST_SYNC_ARTIFACT_TYPE: "alist_sync",
  syncTaskArtifactsToAlist: alistMocks.syncTaskArtifactsToAlist,
}));

import { sweepAlistCompensation } from "../../api/lib/sweepers/alist-compensation";
import { sweeperConfig } from "../../api/lib/sweepers/config";
import { getDb } from "../../api/queries/connection"; // value import：触发上面的 mock 工厂，确保 FakeDb 已建
import type { Db } from "../../api/lib/sweepers/db";

const mockDb = () => getDb() as unknown as Db;
const NOW = new Date("2026-08-08T12:00:00.000Z");

/** 完成任务行（updatedAt 默认在 lookback 窗口内：1 小时前） */
function seedCompletedTask(id: number, taskId: string, updatedAt: Date = new Date(NOW.getTime() - 3_600_000)): void {
  void shared.db.insert(tasks).values({
    id,
    taskId,
    name: `Task ${id}`,
    status: "done",
    lifecycleStatus: "completed",
    output: "ok",
    agentId: null,
    updatedAt,
  });
}

function syncedTaskIds(): number[] {
  return alistMocks.syncTaskArtifactsToAlist.mock.calls.map((call) => (call[1] as Readonly<{ id: number }>).id);
}

// ─── sweepAlistCompensation ───
describe("sweepAlistCompensation", () => {
  beforeEach(() => {
    shared.db.reset();
    alistMocks.syncTaskArtifactsToAlist.mockClear();
  });

  it("syncs a completed task inside the lookback window that lacks an alist_sync marker", async () => {
    // Given: 一个完成任务，无 alist_sync 标记
    seedCompletedTask(1, "T-AL-1");

    // When
    await sweepAlistCompensation(mockDb(), NOW);

    // Then: 恰好补传一次，收到的是该任务行
    expect(alistMocks.syncTaskArtifactsToAlist).toHaveBeenCalledTimes(1);
    const call = alistMocks.syncTaskArtifactsToAlist.mock.calls[0] as unknown as Readonly<[unknown, Readonly<{ id: number; taskId: string }>]>;
    expect(call[1]).toMatchObject({ id: 1, taskId: "T-AL-1" });
  });

  it("skips tasks that already carry an alist_sync artifact", async () => {
    // Given: 一个已有 alist_sync 标记，一个没有
    seedCompletedTask(10, "T-HAS-MARK");
    seedCompletedTask(11, "T-NO-MARK");
    void shared.db.insert(taskArtifacts).values({
      taskId: 10,
      type: "alist_sync",
      name: "AList: /tasks/T-HAS-MARK",
    });

    // When
    await sweepAlistCompensation(mockDb(), NOW);

    // Then: 只补传缺标记的那个
    expect(syncedTaskIds()).toEqual([11]);
  });

  it("ignores completed tasks whose updatedAt is older than the lookback window", async () => {
    // Given: 一个窗口外（lookback 之外 1 分钟）+ 一个窗口内
    const stale = new Date(NOW.getTime() - sweeperConfig.alistRetryLookbackMs - 60_000);
    seedCompletedTask(20, "T-TOO-OLD", stale);
    seedCompletedTask(21, "T-FRESH");

    // When
    await sweepAlistCompensation(mockDb(), NOW);

    // Then: 只有窗口内的任务被补传
    expect(syncedTaskIds()).toEqual([21]);
  });

  it("syncs at most MAX_SYNC=5 candidates when more are pending", async () => {
    // Given: 6 个待补任务（FakeDb 不截断查询结果，正好验证 sweeper 侧的 MAX_SYNC 截断）
    for (let i = 1; i <= 6; i++) {
      seedCompletedTask(i, `T-CAP-${i}`, new Date(NOW.getTime() - i * 600_000));
    }

    // When
    await sweepAlistCompensation(mockDb(), NOW);

    // Then: 只补前 5 个（updatedAt 升序的前 5 行）
    expect(syncedTaskIds()).toEqual([1, 2, 3, 4, 5]);
  });
});
