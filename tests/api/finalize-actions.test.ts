/**
 * §3-4 可靠投递：任务终态后的内部归档/通知动作持久队列。
 *
 * 原状况：终态写入路径直接调 finalizeCompletedTask/finalizeFailedTask——各步骤
 * "尽力而为"（吞错记日志），AList/璇玑抖一下动作就**永久丢失**。
 * 现状况：终态路径只**入队**（同 (task_id, state_revision) 去重），finalize-actions
 * sweeper 用有期限租约领取执行；可重试失败按退避重试，重试耗尽进死信——
 * 「执行完成与归档完成分开」。
 *
 * 语义至少一次：各接收端自带幂等（璇玑 type 键/AList 重复检查/通知防抖）。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const mocks = vi.hoisted(() => ({
  syncTaskMemoryToXuanji: vi.fn(),
  syncTaskLessonToXuanji: vi.fn(),
  syncTaskArtifactsToAlist: vi.fn(),
  autoSummarizeCollab: vi.fn(),
}));
const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({
  broadcastToDashboard: vi.fn(),
  broadcastToTask: vi.fn(),
  sendToAgent: vi.fn(),
}));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));

vi.mock("../../api/lib/xuanji-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/xuanji-sync")>()),
  syncTaskMemoryToXuanji: mocks.syncTaskMemoryToXuanji,
  syncTaskLessonToXuanji: mocks.syncTaskLessonToXuanji,
}));
vi.mock("../../api/lib/alist-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/alist-sync")>()),
  syncTaskArtifactsToAlist: mocks.syncTaskArtifactsToAlist,
}));
vi.mock("../../api/lib/task-validator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/task-validator")>()),
  autoSummarizeCollab: mocks.autoSummarizeCollab,
}));

import { enqueueTaskFinalize, runDueFinalizeActions } from "../../api/lib/finalize-actions";
import { taskboardRouter } from "../../api/taskboard-router";
import { createCallerFactory } from "../../api/middleware";

const boardCaller = createCallerFactory(taskboardRouter);
const adminCtx = { req: undefined, user: { id: 1, role: "admin" }, apiKeyAgentId: -1 } as never;

const NOW = new Date("2026-09-26T08:00:00Z");
let testDb: TestDb;

async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-FZ-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "可靠投递测试任务",
      description: "desc",
      status: "running",
      lifecycleStatus: "reviewing",
      boardStatus: "review",
      priority: 0,
      ...overrides,
    })
    .returning({ id: schema.tasks.id });
  return rows[0].id;
}

async function actionRows(taskId: number) {
  return testDb.db.select().from(schema.taskFinalizeActions).where(eq(schema.taskFinalizeActions.taskId, taskId));
}

beforeEach(() => {
  testDb = createTestDb();
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  mocks.syncTaskMemoryToXuanji.mockReset().mockResolvedValue({ synced: true, reason: "written" });
  mocks.syncTaskLessonToXuanji.mockReset().mockResolvedValue({ synced: true, reason: "written" });
  mocks.syncTaskArtifactsToAlist.mockReset().mockResolvedValue({ synced: false, reason: "nothing_to_upload" });
  mocks.autoSummarizeCollab.mockReset().mockResolvedValue(null);
  for (const fn of Object.values(wsMocks)) fn.mockReset();
});

afterEach(() => {
  testDb.dispose();
});

describe("§3-4 可靠投递：终态动作持久队列", () => {
  it("终态路径只入队：taskboard.reject 产生动作行，归档不在路由内直接发生", async () => {
    const id = await seedTask();

    await boardCaller(adminCtx).reject({ taskId: id, agentId: 1, reason: "质量不达标" });

    const rows = await actionRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("failed");
    expect(rows[0].errorChannel).toBe("taskboard.reject");
    expect(rows[0].stateRevision).toBe(2);
    // 执行与归档分开：路由本身不触发任何接收端
    expect(mocks.syncTaskLessonToXuanji).not.toHaveBeenCalled();
  });

  it("入队幂等：同一终态写入重复入队只有一行", async () => {
    const id = await seedTask();
    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-FZ-X", outcome: "failed", now: NOW });
    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-FZ-X", outcome: "failed", now: NOW });
    expect(await actionRows(id)).toHaveLength(1);
  });

  it("worker 全步骤到位 → 收档 done，接收端恰执行一次", async () => {
    const id = await seedTask();
    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-FZ-X", outcome: "completed", now: NOW });

    const summary = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 1000));

    expect(summary.claimed).toBe(1);
    expect(summary.done).toBe(1);
    const rows = await actionRows(id);
    expect(rows[0].doneAt).toEqual(expect.any(Date));
    expect(rows[0].leaseExpiresAt).toBeNull();
    expect(mocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(1);
    // 再跑一遍：已收档不再领取（不重复归档）
    const again = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 2000));
    expect(again.claimed).toBe(0);
    expect(mocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(1);
  });

  it("可重试失败 → 退避重试，不收档、不立即重领", async () => {
    const id = await seedTask();
    mocks.syncTaskLessonToXuanji.mockResolvedValue({ synced: false, reason: "write_failed" });
    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-FZ-X", outcome: "failed", errorText: "外部执行失败", now: NOW });

    const summary = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 1000));

    expect(summary.retried).toBe(1);
    // 载荷正确：教训收到终态 error 文案
    expect(mocks.syncTaskLessonToXuanji.mock.calls[0]?.[1]?.error).toBe("外部执行失败");
    const rows = await actionRows(id);
    expect(rows[0].doneAt).toBeNull();
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].lastError).toContain("xuanji_lesson");
    expect(rows[0].nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
    // 退避未到期 → 不领取
    const early = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 2000));
    expect(early.claimed).toBe(0);
    // 到期后重跑：mock 恢复 → 收档
    mocks.syncTaskLessonToXuanji.mockResolvedValue({ synced: true, reason: "written" });
    const later = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 120_000));
    expect(later.done).toBe(1);
    expect((await actionRows(id))[0].doneAt).toEqual(expect.any(Date));
  });

  it("永久性原因（not_configured）→ 直接收档，不烧重试次数", async () => {
    const id = await seedTask();
    mocks.syncTaskLessonToXuanji.mockResolvedValue({ synced: false, reason: "not_configured" });
    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-FZ-X", outcome: "failed", now: NOW });

    const summary = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 1000));

    expect(summary.done).toBe(1);
    const rows = await actionRows(id);
    expect(rows[0].doneAt).toEqual(expect.any(Date));
    expect(rows[0].attempts).toBe(0);
  });

  it("重试耗尽 → 死信（dead_letter_at + last_error），不再静默", async () => {
    const id = await seedTask();
    mocks.syncTaskLessonToXuanji.mockResolvedValue({ synced: false, reason: "write_failed" });
    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-FZ-X", outcome: "failed", now: NOW });
    await testDb.db
      .update(schema.taskFinalizeActions)
      .set({ attempts: 4 })
      .where(eq(schema.taskFinalizeActions.taskId, id));

    const summary = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 1000));

    expect(summary.deadLettered).toBe(1);
    const rows = await actionRows(id);
    expect(rows[0].deadLetterAt).toEqual(expect.any(Date));
    expect(rows[0].lastError).toContain("xuanji_lesson");
  });

  it("租约未过期（他人在处理）→ 不领取", async () => {
    const id = await seedTask();
    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-FZ-X", outcome: "failed", now: NOW });
    await testDb.db
      .update(schema.taskFinalizeActions)
      .set({ leaseExpiresAt: new Date(NOW.getTime() + 30_000) })
      .where(eq(schema.taskFinalizeActions.taskId, id));

    const summary = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 1000));

    expect(summary.claimed).toBe(0);
    expect(mocks.syncTaskLessonToXuanji).not.toHaveBeenCalled();
  });

  it("任务行已被清理 → 动作按 task_missing 收档，不算失败", async () => {
    const id = await seedTask();
    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-FZ-X", outcome: "failed", now: NOW });
    await testDb.db.delete(schema.tasks).where(eq(schema.tasks.id, id));

    const summary = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 1000));

    expect(summary.done).toBe(1);
    const rows = await actionRows(id);
    expect(rows[0].doneAt).toEqual(expect.any(Date));
    expect(rows[0].lastError).toBe("task_missing");
  });

  it("失败教训通知：有归属落库；重试语义由 recordNotificationOrThrow 报告", async () => {
    const agentRows = await testDb.db
      .insert(schema.agents)
      .values({ agentId: "a-fz", name: "投递测试 Agent", system: "openclaw", status: "online" })
      .returning({ id: schema.agents.id });
    const id = await seedTask({ agentId: agentRows[0].id });
    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-FZ-X", outcome: "failed", errorChannel: "unit", errorText: "外部执行失败", now: NOW });

    await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 1000));

    const notes = await testDb.db.select().from(schema.notifications).where(eq(schema.notifications.taskId, id));
    expect(notes).toHaveLength(1);
    expect(notes[0].type).toBe("lesson_recorded");
    expect(notes[0].metadata).toMatchObject({ channel: "unit" });
  });
});
