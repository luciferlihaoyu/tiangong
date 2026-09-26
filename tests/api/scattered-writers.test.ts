/**
 * Phase B §3-3 切片 6：**库层**零散写入统一走转移服务。
 *
 * 覆盖（13 处）：4 个 sweeper（blocked 恢复 / 失败重派 / 派发滞留回收 / 超时重派）、
 * 协作解锁（unblockReadyCollabTasks）、审批停放（parkTaskForApproval）、看板联动三处
 * （父任务自动升审 / 子任务失败阻塞父 / 依赖完成解封）、父任务自动汇总（autoSummarizeCollab）、
 * 外部执行体回写（reportTaskProgress）、认领（claimNextTask）。
 *
 * 实现前应当是断言级 RED（修订号停在 1）。其中 reportTaskProgress 的"纯进度回写"用例
 * 是**边界文档测试**：不带状态/生命周期的回写不是状态转移，保持原写入（不递增修订号），
 * 与心跳（lastHeartbeatAt）同一先例——这条现在就该是绿的，转换后也必须保持绿。
 *
 * 路由层端点（mcp 3 处 / orchestration 3 处 / dag / mailbox / auto-approve）留下一轮。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({
  broadcastToDashboard: vi.fn(),
  broadcastToTask: vi.fn(),
  sendToAgent: vi.fn(),
}));
const summarizerMocks = vi.hoisted(() => ({ summarizeCollabWithTianshu: vi.fn() }));
const collabMocks = vi.hoisted(() => ({ emitCollabSummaryForTask: vi.fn() }));
const syncMocks = vi.hoisted(() => ({
  syncTaskLessonToXuanji: vi.fn(),
  syncTaskMemoryToXuanji: vi.fn(),
  syncTaskArtifactsToAlist: vi.fn(),
}));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));
// setup.ts 对 collaboration-events 只有 emitCollabSummaryForTask 的全局 mock；
// 本文件要直驱真实的 unblockReadyCollabTasks，用 importOriginal 部分覆盖。
vi.mock("../../api/lib/collaboration-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/collaboration-events")>()),
  emitCollabSummaryForTask: collabMocks.emitCollabSummaryForTask,
}));
vi.mock("../../api/lib/summarizer", () => ({
  summarizeCollabWithTianshu: summarizerMocks.summarizeCollabWithTianshu,
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

import { sweepBlockedRecovery } from "../../api/lib/sweepers/blocked-recovery";
import { sweepTaskRetry } from "../../api/lib/sweepers/task-retry";
import { sweepDispatchClaim } from "../../api/lib/sweepers/task-dispatch-claim";
import { sweepTaskTimeouts } from "../../api/lib/sweepers/task-lifecycle";
import { unblockReadyCollabTasks } from "../../api/lib/collaboration-events";
import { parkTaskForApproval } from "../../api/lib/execution-gate";
import { autoPromoteParentTask, checkAndUnblockDependencies } from "../../api/lib/taskboard-notify";
import { autoSummarizeCollab } from "../../api/lib/task-validator";
import { reportTaskProgress } from "../../api/lib/task-writeback";
import { claimNextTask } from "../../api/lib/task-claim";

let testDb: TestDb;
const NOW = new Date("2026-09-24T12:00:00Z");
const LONG_AGO = new Date(NOW.getTime() - 10 * 24 * 3600 * 1000);

async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-SC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "零散写入测试任务",
      description: "desc",
      priority: 0,
      ...overrides,
    })
    .returning({ id: schema.tasks.id });
  return rows[0].id;
}

async function seedAgent(): Promise<number> {
  const rows = await testDb.db
    .insert(schema.agents)
    .values({ agentId: "a-sc", name: "零散测试 Agent", system: "openclaw", status: "online" })
    .returning({ id: schema.agents.id });
  return rows[0].id;
}

async function taskRow(id: number) {
  const rows = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return rows[0];
}

beforeEach(() => {
  testDb = createTestDb();
  collabMocks.emitCollabSummaryForTask.mockReset().mockResolvedValue(undefined);
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  summarizerMocks.summarizeCollabWithTianshu.mockReset().mockResolvedValue(null);
  for (const fn of Object.values(syncMocks)) fn.mockReset().mockResolvedValue({ ok: true } as never);
  for (const fn of Object.values(wsMocks)) fn.mockReset();
});

afterEach(() => {
  testDb.dispose();
});

describe("§3-3 切片 6：库层零散写入递增修订号", () => {
  it("sweepBlockedRecovery：恢复板状态并清 blockedAt，修订号 1→2", async () => {
    const id = await seedTask({ status: "pending", boardStatus: "blocked", blockedAt: LONG_AGO });
    await testDb.db.insert(schema.taskMessages).values({
      taskId: id,
      eventType: "system",
      content: "Blocked",
      metadata: JSON.stringify({ action: "block", previousBoardStatus: "todo" }),
    });

    await sweepBlockedRecovery(testDb.db as never, NOW);

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("todo");
    expect(row.blockedAt).toBeNull();
    expect(row.stateRevision).toBe(2);
  });

  it("sweepTaskRetry：终态 failed 重派（restart 例外），修订号 1→2", async () => {
    const id = await seedTask({
      status: "failed",
      lifecycleStatus: "failed",
      boardStatus: "failed",
      failedAt: LONG_AGO,
      retryCount: 0,
      maxRetries: 3,
    });

    await sweepTaskRetry(testDb.db as never, NOW);

    const row = await taskRow(id);
    expect(row.status).toBe("queued");
    expect(row.lifecycleStatus).toBe("queued");
    expect(row.error).toBeNull();
    expect(row.retryCount).toBe(1);
    expect(row.stateRevision).toBe(2);
  });

  it("sweepDispatchClaim：滞留派发回收为 queued，修订号 1→2", async () => {
    const id = await seedTask({
      status: "running",
      lifecycleStatus: "dispatched",
      dispatchedAt: LONG_AGO,
    });

    await sweepDispatchClaim(testDb.db as never, NOW);

    const row = await taskRow(id);
    expect(row.status).toBe("queued");
    expect(row.stateRevision).toBe(2);
  });

  it("sweepTaskTimeouts 重派分支：超时未重试耗尽 → queued 并清租约，修订号 1→2", async () => {
    const id = await seedTask({
      status: "running",
      lifecycleStatus: "working",
      workerLeaseToken: "lease-t",
      workerLeaseGeneration: 1,
      workerLeaseExpiresAt: LONG_AGO,
      retryCount: 0,
      maxRetries: 3,
    });

    await sweepTaskTimeouts(testDb.db as never, NOW);

    const row = await taskRow(id);
    expect(row.status).toBe("queued");
    expect(row.lifecycleStatus).toBe("queued");
    expect(row.workerLeaseToken).toBeNull();
    expect(row.stateRevision).toBe(2);
  });

  it("unblockReadyCollabTasks：依赖完成的 pending 子任务转 queued，修订号 1→2", async () => {
    const parent = await seedTask({ status: "done", lifecycleStatus: "completed" });
    const depDone = await seedTask({ status: "done", lifecycleStatus: "completed" });
    const child = await seedTask({ status: "pending", lifecycleStatus: "created", parentTaskId: parent });
    await testDb.db.insert(schema.taskDependencies).values({ taskId: child, dependsOnTaskId: depDone });

    await unblockReadyCollabTasks(parent);

    const row = await taskRow(child);
    expect(row.status).toBe("queued");
    expect(row.stateRevision).toBe(2);
  });

  it("parkTaskForApproval：停放为 pending+blocked，修订号 1→2", async () => {
    const id = await seedTask({ status: "queued", lifecycleStatus: "created" });
    const row = await taskRow(id);

    await parkTaskForApproval(testDb.db as never, row as never, {
      requiresApproval: true,
      riskTypes: ["github_push"],
    } as never);

    const after = await taskRow(id);
    expect(after.status).toBe("pending");
    expect(after.boardStatus).toBe("blocked");
    expect(String(after.boardNotes ?? "")).toContain("github_push");
    expect(after.blockedAt).toEqual(expect.any(Date));
    expect(after.stateRevision).toBe(2);
  });

  it("autoPromoteParentTask：子任务全部完成 → 父任务升审，修订号 1→2", async () => {
    const parent = await seedTask({ status: "running", lifecycleStatus: "working", boardStatus: "running" });
    const child = await seedTask({ status: "done", boardStatus: "done", parentTaskId: parent });

    await autoPromoteParentTask(child);

    const row = await taskRow(parent);
    expect(row.boardStatus).toBe("review");
    expect(row.reviewAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("autoPromoteParentTask：子任务失败 → 父任务阻塞，修订号 1→2", async () => {
    const parent = await seedTask({ status: "running", lifecycleStatus: "working", boardStatus: "running" });
    const child = await seedTask({ status: "failed", boardStatus: "failed", parentTaskId: parent });

    await autoPromoteParentTask(child);

    const row = await taskRow(parent);
    expect(row.boardStatus).toBe("blocked");
    expect(row.blockedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("checkAndUnblockDependencies：依赖完成 → 阻塞任务解封为 todo，修订号 1→2", async () => {
    const doneTask = await seedTask({ status: "done", boardStatus: "done", lifecycleStatus: "completed" });
    const blocked = await seedTask({ status: "pending", boardStatus: "blocked" });
    await testDb.db.insert(schema.taskDependencies).values({ taskId: blocked, dependsOnTaskId: doneTask });

    await checkAndUnblockDependencies(doneTask);

    const row = await taskRow(blocked);
    expect(row.boardStatus).toBe("todo");
    expect(row.stateRevision).toBe(2);
  });

  it("autoSummarizeCollab：父任务汇总落 output+status+progress，修订号 1→2", async () => {
    const parent = await seedTask({ status: "running", lifecycleStatus: "working", boardStatus: "review" });
    await seedTask({ status: "done", output: "子任务结论甲", parentTaskId: parent });
    await seedTask({ status: "done", output: "子任务结论乙", parentTaskId: parent });

    await autoSummarizeCollab(parent);

    const row = await taskRow(parent);
    expect(String(row.output ?? "")).toContain("子任务结论甲");
    expect(row.status).toBe("done");
    expect(row.progress).toBe(100);
    expect(row.stateRevision).toBe(2);
  });

  it("reportTaskProgress：带 status=done 的回写是状态转移，修订号 1→2", async () => {
    const id = await seedTask({ status: "running", lifecycleStatus: "working", agentId: null });

    const result = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "done", output: "完成产物" } as never,
      { apiKeyAgentId: null } as never
    );
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.status).toBe("done");
    expect(row.stateRevision).toBe(2);
  });

  it("reportTaskProgress：纯进度回写不是状态转移，不递增修订号（边界文档）", async () => {
    const id = await seedTask({ status: "running", lifecycleStatus: "working" });

    const result = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 60 } as never,
      { apiKeyAgentId: null } as never
    );
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.progress).toBe(60);
    expect(row.status).toBe("running");
    expect(row.stateRevision).toBe(1);
  });

  it("claimNextTask：认领写齐 running/claimed/agentId 并递增修订号；二次认领落空", async () => {
    const agentId = await seedAgent();
    const id = await seedTask({ status: "queued", lifecycleStatus: "created", priority: 5 });

    const first = await claimNextTask(testDb.db as never, agentId);
    expect(first.task?.id).toBe(id);

    const row = await taskRow(id);
    expect(row.status).toBe("running");
    expect(row.lifecycleStatus).toBe("claimed");
    expect(row.agentId).toBe(agentId);
    expect(row.claimedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);

    const second = await claimNextTask(testDb.db as never, agentId);
    expect(second.task).toBeNull();
    expect((await taskRow(id)).stateRevision).toBe(2);
  });
});
