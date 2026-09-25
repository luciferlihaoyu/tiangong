/**
 * Phase B §3-3 切片 4（成功链）：task-runner 的 submitted→completed 写入也必须递增修订号。
 *
 * 与 task-runner-transition.test.ts（失败链）分开成两个文件：Runner 的 CONFIG 在模块
 * 加载时读环境变量并冻结，一份文件只能是一种执行体配置。这里用 argv 模式跑
 * `/bin/echo runner-ok`（退出码 0），驱动完整成功链：
 *
 *   queued/dispatched --领取--> running/claimed --working--> 25
 *   --提交--> running/submitted(95, output) --自动复核--> done/completed(100)
 *
 * 期望修订号 1→2（领取）→3（working）→4（提交）→5（完成）。
 * 单独成文件还因为：此前**成功终态**（completed）恰是制品封存器入队外部回调的地方，
 * 修订号在这里断了会让下一条事件撞 (task_id, state_revision) 唯一索引。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

process.env.TIANGONG_TASK_RUNNER_MODE = "command";
process.env.TIANGONG_TASK_RUNNER_EXEC_FILE = "/bin/echo";
process.env.TIANGONG_TASK_RUNNER_EXEC_ARGS_JSON = '["runner-ok"]';

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
      taskId: `T-RUNC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "执行成功链测试任务",
      description: "desc",
      status: "queued",
      lifecycleStatus: "dispatched",
      boardStatus: "ready",
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

describe("§3-3 切片 4：task-runner 成功链的每次状态写入都递增修订号", () => {
  it("queued/dispatched 一次 tick 走完 领取→working→提交→完成，修订号 1→5", async () => {
    const id = await seedTask();

    await taskRunner.runOnce();

    const row = await taskRow(id);
    expect(row.status).toBe("done");
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.completedAt).toEqual(expect.any(Date));
    expect(row.progress).toBe(100);
    expect(String(row.output ?? "")).toContain("runner-ok");
    // 关键断言：领取(2) working(3) 提交(4) 完成(5)——实现前停在 1
    expect(row.stateRevision).toBe(5);
  });

  it("完成的任务走统一归档（璇玑记忆），且不改回状态", async () => {
    const id = await seedTask();

    await taskRunner.runOnce();

    expect(syncMocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(1);
    const row = await taskRow(id);
    expect(row.status).toBe("done");
    expect(row.stateRevision).toBe(5);

    // 再次 tick：终态任务不会再被执行，修订号不动
    await taskRunner.runOnce();
    const after = await taskRow(id);
    expect(after.stateRevision).toBe(5);
  });
});
