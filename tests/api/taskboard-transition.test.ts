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
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn(), broadcastToTask: vi.fn(), sendToAgent: vi.fn() }));
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
  wsMocks.sendToAgent.mockReset();
  gateMocks.checkCompletionGate.mockReset().mockResolvedValue({ allowed: true, reasons: [] } as never);
  gateMocks.parkTaskForApproval.mockReset().mockResolvedValue(undefined as never);
  for (const fn of Object.values(syncMocks)) fn.mockReset().mockResolvedValue({ ok: true } as never);
});

afterEach(() => {
  testDb.dispose();
});

describe("§3-3 切片 6：看板认领", () => {
  it("claim：认领写齐 board/status/agentId/心跳并递增修订号", async () => {
    const agentId = await seedAgent();
    const id = await seedTask({ status: "queued", boardStatus: "ready", lifecycleStatus: "created" });

    await createBoardCaller(mockCtx()).claim({ taskId: id, agentId });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("running");
    expect(row.status).toBe("running");
    expect(row.agentId).toBe(agentId);
    expect(row.claimedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });
});

describe("§3-3 切片 5：看板剩余写入（submit/updateStatus/审批三件套/submitForReview）", () => {
  it("submit：running→review 落 reviewAt/reviewerId/output，修订号 1→2", async () => {
    const agentId = await seedAgent();
    // 审稿人推导链：父任务 agent > 派发人 > null——这里给派发人，reviewerId 应取到它
    const id = await seedTask({
      boardStatus: "running",
      agentId,
      status: "running",
      dispatcherAgentId: agentId,
    });

    await createBoardCaller(mockCtx()).submit({ taskId: id, agentId, output: "结果内容" });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("review");
    expect(row.reviewAt).toEqual(expect.any(Date));
    expect(row.reviewerId).toBe(agentId);
    expect(row.output).toBe("结果内容");
    expect(row.stateRevision).toBe(2);
  });

  it("updateStatus(to=done)：status=done + completedAt，修订号递增", async () => {
    const id = await seedTask({ boardStatus: "review", status: "running" });

    await createBoardCaller(mockCtx()).updateStatus({ taskId: id, agentId: 1, boardStatus: "done" });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("done");
    expect(row.status).toBe("done");
    expect(row.completedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("updateStatus(to=failed)：status=failed + failedAt，修订号递增", async () => {
    const id = await seedTask({ boardStatus: "running", status: "running" });

    await createBoardCaller(mockCtx()).updateStatus({ taskId: id, agentId: 1, boardStatus: "failed" });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("failed");
    expect(row.status).toBe("failed");
    expect(row.failedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("approve（review 且 lifecycle=reviewing）：生命周期推导 completed——修复 status=done 但 lifecycle 停在 reviewing 的投影错位", async () => {
    const id = await seedTask({ boardStatus: "review", status: "running", lifecycleStatus: "reviewing" });

    await createBoardCaller(mockCtx()).approve({ taskId: id, agentId: 1 });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("done");
    expect(row.status).toBe("done");
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.completedAt).toEqual(expect.any(Date));
    expect(row.reviewResult).toBe("approved");
    expect(row.stateRevision).toBe(2);
  });

  it("approve（板式老流程，lifecycle 停在中间态）：生命周期不动、只补终态投影，修订号递增", async () => {
    const id = await seedTask({ boardStatus: "review", status: "running", lifecycleStatus: "working" });

    await createBoardCaller(mockCtx()).approve({ taskId: id, agentId: 1 });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("done");
    expect(row.status).toBe("done");
    // 状态机不允许 working→completed：老流程的生命周期保持原样（不误拒），只保证结果状态一致
    expect(row.lifecycleStatus).toBe("working");
    expect(row.stateRevision).toBe(2);
  });

  it("reject：生命周期/结果/板三投影同次写齐 failed，修订号递增", async () => {
    const id = await seedTask({ boardStatus: "review", status: "running", lifecycleStatus: "reviewing" });

    await createBoardCaller(mockCtx()).reject({ taskId: id, agentId: 1, reason: "质量不达标" });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("failed");
    expect(row.status).toBe("failed");
    expect(row.lifecycleStatus).toBe("failed");
    expect(row.failedAt).toEqual(expect.any(Date));
    expect(row.reviewResult).toBe("rejected");
    expect(row.stateRevision).toBe(2);
  });

  it("requestChanges：review→running，修订号递增", async () => {
    const id = await seedTask({ boardStatus: "review", status: "running", lifecycleStatus: "reviewing" });

    await createBoardCaller(mockCtx()).requestChanges({ taskId: id, agentId: 1, reason: "再补一版" });

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("running");
    expect(row.status).toBe("running");
    expect(row.reviewResult).toBe("changes_requested");
    expect(row.stateRevision).toBe(2);
  });

  it("submitForReview（已提交结果）：进入 reviewing，修订号递增", async () => {
    const id = await seedTask({ boardStatus: "running", status: "running", lifecycleStatus: "submitted" });

    const res = await createBoardCaller(mockCtx()).submitForReview({ taskId: id });

    expect(res.success).toBe(true);
    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("reviewing");
    expect(row.stateRevision).toBe(2);
  });

  it("submitForReview（从严裁决）：尚未提交结果 → 拒绝且一个字段都不写", async () => {
    const id = await seedTask({ boardStatus: "running", status: "running", lifecycleStatus: "working" });
    const before = await taskRow(id);

    await expect(createBoardCaller(mockCtx()).submitForReview({ taskId: id })).rejects.toThrow(
      /submit.*result|先提交结果/i
    );

    const after = await taskRow(id);
    expect(after.lifecycleStatus).toBe(before.lifecycleStatus);
    expect(after.stateRevision).toBe(before.stateRevision);
  });

  it("submitForReview（任务不存在）：明确报错而不是静默成功", async () => {
    await expect(createBoardCaller(mockCtx()).submitForReview({ taskId: 999999 })).rejects.toThrow(
      "Task not found"
    );
  });
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
