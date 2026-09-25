/**
 * Phase B §3-3 切片 4：内部执行主链路（task-runner）的状态写入必须递增修订号。
 *
 * 此前 `TaskRunner` 的执行方法全是 private，测试里只 import 过模块、从未调用——
 * 这条**最常走的路径**没有任何覆盖其状态写入的测试。本文件配合新加的 `runOnce()`
 * 测试缝，用 command 模式且**不配置任何执行体**（executeCommand 立即返回
 * success=false "not configured"，不起子进程）驱动完整失败链：
 *
 *   pending/created --自动派发--> queued/dispatched --领取--> running/claimed
 *   --working--> 25 --执行失败--> failed/failed
 *
 * 期望每次状态写入都递增修订号：1→2（派发）→3（领取）→4（working）→5（失败）。
 * 实现前应当是断言级 RED（修订号停在 1）。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

process.env.TIANGONG_TASK_RUNNER_MODE = "command";
delete process.env.TIANGONG_TASK_RUNNER_EXEC_FILE;
delete process.env.TIANGONG_TASK_RUNNER_EXEC_ARGS_JSON;
delete process.env.TIANGONG_TASK_RUNNER_COMMAND;

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn(), broadcastToTask: vi.fn() }));
const collabMocks = vi.hoisted(() => ({ emitCollabSummaryForTask: vi.fn() }));
const syncMocks = vi.hoisted(() => ({
  syncTaskLessonToXuanji: vi.fn(),
  syncTaskMemoryToXuanji: vi.fn(),
  syncTaskArtifactsToAlist: vi.fn(),
  autoSummarizeCollab: vi.fn(),
}));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));
vi.mock("../../api/lib/collaboration-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/collaboration-events")>()),
  emitCollabSummaryForTask: collabMocks.emitCollabSummaryForTask,
}));
vi.mock("../../api/lib/xuanji-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/xuanji-sync")>()),
  syncTaskLessonToXuanji: syncMocks.syncTaskLessonToXuanji,
  syncTaskMemoryToXuanji: syncMocks.syncTaskMemoryToXuanji,
}));
vi.mock("../../api/lib/alist-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/alist-sync")>()),
  syncTaskArtifactsToAlist: syncMocks.syncTaskArtifactsToAlist,
}));
vi.mock("../../api/lib/task-validator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/task-validator")>()),
  autoSummarizeCollab: syncMocks.autoSummarizeCollab,
}));

const { taskRunner } = await import("../../api/lib/task-runner");

let testDb: TestDb;

async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-RUN-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "执行链路测试任务",
      description: "desc",
      status: "pending",
      priority: 0,
      ...overrides,
    })
    .returning({ id: schema.tasks.id });
  return rows[0].id;
}

async function taskRow(id: number) {
  const rows = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return rows[0];
}

beforeEach(() => {
  testDb = createTestDb();
  conn.getDb.mockReturnValue(testDb.db);
  wsMocks.broadcastToDashboard.mockReset();
  for (const fn of Object.values(syncMocks)) fn.mockReset().mockResolvedValue({ ok: true } as never);
  collabMocks.emitCollabSummaryForTask.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  testDb.dispose();
});

describe("§3-3 切片 4：task-runner 失败链的每次状态写入都递增修订号", () => {
  it("pending/created 一次 tick 走完 派发→领取→working→失败，修订号 1→5", async () => {
    const id = await seedTask({ lifecycleStatus: "created", boardStatus: "triage" });
    expect((await taskRow(id)).stateRevision).toBe(1);

    await taskRunner.runOnce();

    const row = await taskRow(id);
    expect(row.status).toBe("failed");
    expect(row.lifecycleStatus).toBe("failed");
    expect(row.failedAt).toEqual(expect.any(Date));
    expect(String(row.error ?? "")).toContain("not configured");
    // 链路上的盖章都还在
    expect(row.dispatchedAt).toEqual(expect.any(Date));
    expect(row.claimedAt).toEqual(expect.any(Date));
    // 失败路径不清租约（与现状一致，清理由 sweeper 负责）
    expect(row.workerLeaseToken).toEqual(expect.any(String));
    // 关键断言：派发(2) 领取(3) working(4) 失败(5)——实现前停在 1
    expect(row.stateRevision).toBe(5);
  });

  it("queued 任务直接从领取开始：claim→working→失败，修订号 1→4", async () => {
    const id = await seedTask({ status: "queued", lifecycleStatus: "dispatched", boardStatus: "ready" });

    await taskRunner.runOnce();

    const row = await taskRow(id);
    expect(row.status).toBe("failed");
    expect(row.lifecycleStatus).toBe("failed");
    expect(row.stateRevision).toBe(4);
  });

  it("已被别人领取的 running 任务不被二次执行（守卫仍在）", async () => {
    const id = await seedTask({
      status: "running",
      lifecycleStatus: "working",
      workerLeaseToken: "lease-others",
    });
    const before = await taskRow(id);

    await taskRunner.runOnce();

    const after = await taskRow(id);
    expect(after.status).toBe(before.status);
    expect(after.lifecycleStatus).toBe(before.lifecycleStatus);
    expect(after.workerLeaseToken).toBe("lease-others");
    expect(after.stateRevision).toBe(before.stateRevision);
  });
});
