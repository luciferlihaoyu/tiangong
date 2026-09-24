/**
 * Phase B §3-3 切片 3：看板里"既可测又能生产自证"的状态写入改走单一转移服务。
 *
 * 为什么挑这五条（block / unblock / submitForReview / dispatch / retry）：
 * `approve` / `reject` / `requestChanges` 走的是 `adminQuery`（需要用户会话而不是 API Key），
 * 生产上无法由 Agent 身份驱动，因此**拿不到生产证据**，留到后续切片单独处理；
 * `heartbeat`（只写 lastHeartbeatAt）与 `promote`（只写 priority）根本不是状态变更，保持原样。
 *
 * 本切片里 `retry` 是关键一处：它会**故意**把终态任务拉回 `queued`，这是状态机"终态不可逆"
 * 规则的一个**有意例外**（重试语义），所以服务需要一个显式的 `restart` 开关，
 * 而不是把规则悄悄放宽给所有调用方。
 *
 * 本文件在实现前应当是断言级 RED（修订号停在 1，且 retry 需要 restart 通道）。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn(), broadcastToTask: vi.fn() }));
const gateMocks = vi.hoisted(() => ({ checkCompletionGate: vi.fn(), parkTaskForApproval: vi.fn() }));
const syncMocks = vi.hoisted(() => ({
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

import { taskboardRouter } from "../../api/taskboard-router";
import { createCallerFactory } from "../../api/middleware";

const createBoardCaller = createCallerFactory(taskboardRouter);

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
    .values({ agentId: "a-board", name: "看板测试 Agent", system: "openclaw", status: "online" })
    .returning({ id: schema.agents.id });
  return rows[0].id;
}

async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-BOARD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "看板转移测试任务",
      description: "desc",
      status: "queued",
      boardStatus: "triage",
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
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  wsMocks.broadcastToDashboard.mockReset();
  wsMocks.broadcastToTask.mockReset();
  gateMocks.checkCompletionGate.mockReset().mockResolvedValue({ allowed: true, reasons: [] } as never);
  gateMocks.parkTaskForApproval.mockReset().mockResolvedValue(undefined as never);
  for (const fn of Object.values(syncMocks)) fn.mockReset().mockResolvedValue({ ok: true } as never);
});

afterEach(() => {
  testDb.dispose();
});

describe("§3-3 切片 3：看板状态写入必须递增修订号并保持一致投影", () => {
  it("block：落 blocked + blockedAt + 备注，修订号 1→2", async () => {
    const agentId = await seedAgent();
    const id = await seedTask();

    await createBoardCaller(mockCtx()).block({ taskId: id, agentId, reason: "等上游接口" });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("blocked");
    expect(row.blockedAt).toEqual(expect.any(Date));
    expect(row.boardNotes).toBe("等上游接口");
    expect(row.stateRevision).toBe(2);
  });

  it("unblock：按历史消息里的 previousBoardStatus 还原，修订号递增", async () => {
    const agentId = await seedAgent();
    const id = await seedTask({ boardStatus: "blocked" });
    // unblock 从 task_messages 里推断"阻断前的板状态"，所以要先把 block 的历史消息放进去
    await testDb.db.insert(schema.taskMessages).values({
      taskId: id,
      fromAgentId: agentId,
      eventType: "system",
      content: "Blocked",
      metadata: JSON.stringify({ action: "block", previousBoardStatus: "triage", agentId }),
    });

    await createBoardCaller(mockCtx()).unblock({ taskId: id, agentId });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("triage");
    expect(row.stateRevision).toBe(2);
  });

  it("dispatch：queued → 生命周期 dispatched 并盖章 dispatchedAt，修订号递增", async () => {
    const id = await seedTask({ boardStatus: "ready", status: "queued" });

    await createBoardCaller(mockCtx()).dispatch({ taskId: id });

    const row = await taskRow(id);
    expect(row.status).toBe("queued");
    expect(row.lifecycleStatus).toBe("dispatched");
    expect(row.dispatchedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("retry：把终态拉回 queued 是状态机的**有意例外**，同时清掉失败痕迹并递增修订号", async () => {
    const agentId = await seedAgent();
    const id = await seedTask({
      boardStatus: "failed",
      status: "failed",
      lifecycleStatus: "failed",
      agentId,
      retryCount: 0,
      maxRetries: 3,
      error: "上一次失败原因",
      failedAt: new Date("2026-09-20T00:00:00Z"),
    });

    await createBoardCaller(mockCtx()).retry({ taskId: id, agentId });

    const row = await taskRow(id);
    expect(row.status).toBe("queued");
    expect(row.lifecycleStatus).toBe("queued");
    expect(row.boardStatus).toBe("ready");
    expect(row.error).toBeNull();
    expect(row.failedAt).toBeNull();
    expect(row.stateRevision).toBe(2);
  });
});
