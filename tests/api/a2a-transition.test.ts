/**
 * Phase B §3-3 切片 2：a2a 的九条状态写入全部改走单一转移服务。
 *
 * 为什么优先做 a2a：`enqueueTaskOutboxEvent` 全仓只有 3 个调用点
 * （`beidou-external-router` 两处、`artifact-sealer` 一处），而这三处**都**递增修订号。
 * 撞唯一索引 `uq_task_outbox_task_revision(task_id, state_revision)` 的真实路径因此是：
 * 外部任务经过北斗/封存占用了修订号 N → 中间被 a2a（或 task-runner）**不递增地**改了状态，
 * 修订号仍是 N → 下一处入队时用到的 N 就撞了。a2a 正是外部集成的状态推进路径。
 *
 * 另一个同类不一致：a2a 的 `cancel` 只改 `lifecycleStatus`、不动粗粒度 `status`
 * （等价于本轮在 MCP 取消里修掉的那个生产缺陷）。
 *
 * 本文件用**真实 SQLite** 驱动真实 `a2aRouter`，断言"每条状态推进都递增修订号"，
 * 因此在实现前应当是断言级 RED（修订号停在 1）。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn(), broadcastToTask: vi.fn() }));
const gateMocks = vi.hoisted(() => ({ checkCompletionGate: vi.fn(), parkTaskForApproval: vi.fn() }));
const xuanjiMocks = vi.hoisted(() => ({
  syncTaskLessonToXuanji: vi.fn(),
  syncTaskMemoryToXuanji: vi.fn(),
  syncTaskArtifactsToAlist: vi.fn(),
  autoSummarizeCollab: vi.fn(),
}));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));
vi.mock("../../api/lib/execution-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/execution-gate")>()),
  checkCompletionGate: gateMocks.checkCompletionGate,
  parkTaskForApproval: gateMocks.parkTaskForApproval,
}));
vi.mock("../../api/lib/xuanji-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/xuanji-sync")>()),
  syncTaskLessonToXuanji: xuanjiMocks.syncTaskLessonToXuanji,
  syncTaskMemoryToXuanji: xuanjiMocks.syncTaskMemoryToXuanji,
}));
vi.mock("../../api/lib/alist-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/alist-sync")>()),
  syncTaskArtifactsToAlist: xuanjiMocks.syncTaskArtifactsToAlist,
}));
vi.mock("../../api/lib/task-validator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/task-validator")>()),
  autoSummarizeCollab: xuanjiMocks.autoSummarizeCollab,
}));

import { a2aRouter } from "../../api/a2a-router";
import { createCallerFactory } from "../../api/middleware";

const createA2aCaller = createCallerFactory(a2aRouter);

function mockCtx(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    req: new Request("http://localhost"),
    user: { id: 1, role: "admin" },
    apiKeyAgentId: -1,
    ...overrides,
  } as never;
}

let testDb: TestDb;

async function seedAgent(): Promise<number> {
  const rows = await testDb.db
    .insert(schema.agents)
    .values({ agentId: "a-a2a", name: "a2a 测试 Agent", system: "openclaw", status: "online" })
    .returning({ id: schema.agents.id });
  return rows[0].id;
}

async function seedTask(agentId: number, lifecycleStatus: string, status = "running"): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-A2A-${lifecycleStatus}-${Math.random().toString(36).slice(2, 7)}`,
      name: "a2a 转移测试任务",
      description: "desc",
      status: status as "running",
      lifecycleStatus,
      priority: 0,
      agentId,
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
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  wsMocks.broadcastToDashboard.mockReset();
  gateMocks.checkCompletionGate.mockReset().mockResolvedValue({ allowed: true, reasons: [] } as never);
  gateMocks.parkTaskForApproval.mockReset().mockResolvedValue(undefined as never);
  for (const fn of Object.values(xuanjiMocks)) fn.mockReset().mockResolvedValue({ ok: true } as never);
});

afterEach(() => {
  testDb.dispose();
});

describe("§3-3 切片 2：a2a 状态推进必须递增修订号并保持一致投影", () => {
  it("dispatch：created → dispatched，status=running，修订号 1→2", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "created", "queued");

    const result = await createA2aCaller(mockCtx()).dispatch({ taskId: id, targetAgentId: agentId });
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("dispatched");
    expect(row.status).toBe("running");
    expect(row.dispatchedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("ack：dispatched → accepted，status 不被改写，修订号递增", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "dispatched");

    const result = await createA2aCaller(mockCtx()).ack({ taskId: id, agentId });
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("accepted");
    expect(row.status).toBe("running");
    expect(row.acceptedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("reportWorking：accepted → working，progress 与修订号一起写", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "accepted");

    const result = await createA2aCaller(mockCtx()).reportWorking({ taskId: id, agentId, progress: 40 });
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("working");
    expect(row.progress).toBe(40);
    expect(row.stateRevision).toBe(2);
  });

  it("markAwaitingResult：working → awaiting_result，修订号递增", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "working");

    const result = await createA2aCaller(mockCtx()).markAwaitingResult({ taskId: id, agentId });
    expect(result.success).toBe(true);
    expect((await taskRow(id)).stateRevision).toBe(2);
  });

  it("submitResult：working → submitted，output 与修订号一起写", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "working");

    const result = await createA2aCaller(mockCtx()).submitResult({ taskId: id, agentId, output: "结论正文" });
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("submitted");
    expect(row.output).toBe("结论正文");
    expect(row.progress).toBe(95);
    expect(row.stateRevision).toBe(2);
  });

  it("review(approved)：submitted → completed，status=done 且 completedAt 与修订号同一次写入", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "submitted");

    const result = await createA2aCaller(mockCtx()).review({ taskId: id, approved: true });
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.status).toBe("done");
    expect(row.progress).toBe(100);
    expect(row.completedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("fail：working → failed，status=failed、failedAt 与修订号一致", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "working");

    const result = await createA2aCaller(mockCtx()).fail({ taskId: id, agentId, error: "外部执行体退出码 1" });
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("failed");
    expect(row.status).toBe("failed");
    expect(row.error).toBe("外部执行体退出码 1");
    expect(row.failedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("timeout：working → timeout，status=failed、timeoutAt 与修订号一致", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "working");

    const result = await createA2aCaller(mockCtx()).timeout({ taskId: id, note: "外部无响应" });
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("timeout");
    expect(row.status).toBe("failed");
    expect(row.timeoutAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("cancel：dispatched → cancelled，粗粒度 status 必须跟着落 failed（原先是各说各话）", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "dispatched");

    const result = await createA2aCaller(mockCtx()).cancel({ taskId: id, note: "上游撤回" });
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("cancelled");
    expect(row.status).toBe("failed");
    expect(row.failedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("非法转移（终态后取消）：拒绝且一个维度都不写、修订号不动", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, "completed", "done");
    const before = await taskRow(id);

    const result = await createA2aCaller(mockCtx()).cancel({ taskId: id });
    expect(result.success).toBe(false);

    const after = await taskRow(id);
    expect(after.lifecycleStatus).toBe(before.lifecycleStatus);
    expect(after.status).toBe(before.status);
    expect(after.stateRevision).toBe(before.stateRevision);
  });
});
