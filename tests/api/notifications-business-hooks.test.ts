/**
 * 通知中心 NC-5：5 处业务钩子
 *   C-1 审批通过 → task_approved（review→done 落库后 + 预执行审批放行 blocked→ready）
 *   C-2 人工驳回 → task_rejected
 *   C-3 外部失败回写 → task_failed（成功回写不触发，见负例）
 *   C-5 预算熔断 → budget_exhausted（notifyBudgetExhausted，24h 防抖）
 *
 * 与 NC-3 的 lesson_recorded 教训通知不同，NC-5 走真实 recordNotification
 * （FakeDb 真实写库），断言 notifications 表里实际落的行，覆盖类型/归属/窗口。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeDb } from "./helpers/fake-db";
import { tasks, agents, notifications } from "@db/schema";
import { mergeTaskMetadata } from "../../api/lib/task-metadata";

const db = createFakeDb();

vi.mock("../../api/queries/connection", () => ({ getDb: () => db }));
vi.mock("../../api/ws-manager", () => ({
  wsManager: { broadcastToDashboard: vi.fn(), broadcast: vi.fn(), sendToAgent: vi.fn(), isOnline: vi.fn(() => false) },
}));
vi.mock("../../api/lib/collaboration-events", () => ({
  emitCollabSummaryForTask: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../api/lib/task-finalize", () => ({
  finalizeCompletedTask: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../api/lib/password", () => ({
  hashPassword: vi.fn(async (s: string) => `hashed_${s}`),
  verifyPassword: vi.fn(async (s: string, h: string) => h === `hashed_${s}`),
}));
vi.mock("../../api/lib/xuanji-sync", () => ({
  XUANJI_MEMORY_ARTIFACT_TYPE: "xuanji_memory",
  XUANJI_LESSON_ARTIFACT_TYPE: "xuanji_lesson",
  syncTaskMemoryToXuanji: vi.fn().mockResolvedValue({ synced: true, reason: "written" }),
  syncTaskLessonToXuanji: vi.fn().mockResolvedValue({ synced: true, reason: "written" }),
}));
vi.mock("../../api/lib/taskboard-notify", () => ({
  sendMailboxNotification: vi.fn().mockResolvedValue(undefined),
  broadcastTaskNotification: vi.fn().mockResolvedValue(undefined),
  autoPromoteParentTask: vi.fn().mockResolvedValue(undefined),
  checkAndUnblockDependencies: vi.fn().mockResolvedValue(undefined),
}));

import { taskboardRouter } from "../../api/taskboard-router";
import { createCallerFactory } from "../../api/middleware";
import { reportTaskProgress } from "../../api/lib/task-writeback";
import { claimNextTask } from "../../api/lib/task-claim";
import { notifyBudgetExhausted, BUDGET_NOTIFY_DEDUP_WINDOW_MS } from "../../api/lib/notification-hooks";
import { buildApprovalPatch } from "../../api/lib/execution-gate";

const taskboardCaller = createCallerFactory(taskboardRouter);
// approve / reject 走 adminQuery：需登录的 admin 用户
function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}
function notifRows(type: string) {
  return db.rowsOfTable(notifications).filter((r) => r.type === type);
}

beforeEach(() => {
  db.reset();
});

// ─── C-1 / C-2：taskboard approve / reject ───

describe("NC-5 业务钩子：taskboard approve / reject", () => {
  const reviewTask = {
    id: 40,
    taskId: "TG-040",
    name: "汇总周报",
    description: "汇总本周进展",
    input: null,
    output: "周报草稿",
    agentId: 2,
    status: "running",
    lifecycleStatus: "submitted",
    boardStatus: "review",
    reviewerId: null,
    originSystem: null,
    parentTaskId: null,
  };

  it("C-1 审批通过（review→done 落库后）→ 记一条 task_approved（归属被审批任务 agent）", async () => {
    await db.insert(tasks).values(reviewTask);

    const res = await taskboardCaller(mockCtx()).approve({ taskId: 40, agentId: 7, comment: "OK" });

    expect(res.success).toBe(true);
    const rows = notifRows("task_approved");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: 2, taskId: 40, type: "task_approved" });
    expect(rows[0]?.metadata).toMatchObject({ action: "approve", reviewerAgentId: 7 });
  });

  it("C-1 预执行审批放行（blocked→ready）→ 记一条 task_approved（action=approve_execution）", async () => {
    const blockedInput = mergeTaskMetadata(
      null,
      buildApprovalPatch(
        { taskId: "TG-041", name: "高风险外部操作", description: "执行外部高风险操作", agentId: 3, input: null } as never,
        { requiresApproval: true, riskTypes: ["github_push"] }
      )
    );
    await db.insert(tasks).values({
      ...reviewTask,
      id: 41,
      taskId: "TG-041",
      name: "高风险外部操作",
      agentId: 3,
      input: blockedInput,
      status: "blocked",
      lifecycleStatus: "blocked",
      boardStatus: "blocked",
      boardNotes: null,
      output: null,
    });

    const res = await taskboardCaller(mockCtx()).approve({ taskId: 41, agentId: 7, comment: "风险可接受" });

    expect(res.success).toBe(true);
    expect(res.requeued).toBe(true);
    const rows = notifRows("task_approved");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: 3, taskId: 41, type: "task_approved" });
    expect(rows[0]?.metadata).toMatchObject({ action: "approve_execution", reviewerAgentId: 7 });
  });

  it("C-2 人工驳回 → 记一条 task_rejected（驳回理由进 body/metadata）", async () => {
    await db.insert(tasks).values(reviewTask);

    const res = await taskboardCaller(mockCtx()).reject({ taskId: 40, agentId: 7, reason: "数据口径错误" });

    expect(res.success).toBe(true);
    const rows = notifRows("task_rejected");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: 2, taskId: 40, type: "task_rejected" });
    expect(String(rows[0]?.body ?? "")).toContain("数据口径错误");
    expect(rows[0]?.metadata).toMatchObject({ action: "reject", reviewerAgentId: 7, reason: "数据口径错误" });
  });
});

// ─── C-3：外部失败回写 task_failed ───

describe("NC-5 业务钩子：外部失败回写 task_failed", () => {
  const externalTask = {
    id: 19,
    taskId: "T-SYNC01",
    name: "计算 17*23",
    description: "只回答数字结果",
    input: null,
    output: null,
    agentId: 16,
    status: "running",
    lifecycleStatus: "working",
    progress: 95,
    error: null,
    originSystem: null,
  };

  it("C-3 外部回写 status=failed → 记一条 task_failed（终态失败）", async () => {
    await db.insert(tasks).values(externalTask);

    const result = await reportTaskProgress(db as never, {
      id: 19,
      progress: 100,
      status: "failed",
      error: "dsh 执行体退出码 1",
    }, { apiKeyAgentId: -1 });

    expect(result.success).toBe(true);
    const rows = notifRows("task_failed");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: 16, taskId: 19, type: "task_failed" });
    expect(String(rows[0]?.metadata?.error ?? "")).toContain("dsh 执行体退出码 1");
  });

  it("C-3 负例：外部回写 status=done → 不记 task_failed（也无关 lesson_recorded）", async () => {
    await db.insert(tasks).values(externalTask);

    const result = await reportTaskProgress(db as never, {
      id: 19,
      progress: 100,
      status: "done",
      output: "391",
    }, { apiKeyAgentId: -1 });

    expect(result.success).toBe(true);
    expect(notifRows("task_failed")).toHaveLength(0);
    expect(notifRows("lesson_recorded")).toHaveLength(0);
  });
});

// ─── C-5：预算熔断 budget_exhausted ───

describe("NC-5 业务钩子：预算熔断 budget_exhausted", () => {
  it("C-5 claimNextTask 预算耗尽 → 返回 budget_exhausted 并记一条通知（24h 窗口 metadata）", async () => {
    await db.insert(agents).values({ id: 5, name: "agent5", budgetCents: 100, spentCents: 150 });

    const result = await claimNextTask(db as never, 5);

    expect(result).toMatchObject({ task: null, reason: "budget_exhausted" });
    const rows = notifRows("budget_exhausted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ agentId: 5, taskId: null, type: "budget_exhausted" });
    expect(rows[0]?.metadata).toMatchObject({ budgetCents: 100, spentCents: 150 });
  });

  it("C-5 notifyBudgetExhausted 24h 防抖：同 agent 重复调用只落一行（BUDGET_NOTIFY_DEDUP_WINDOW_MS=24h）", async () => {
    await notifyBudgetExhausted(db as never, { id: 5, name: "agent5", budgetCents: 100, spentCents: 150 });
    await notifyBudgetExhausted(db as never, { id: 5, name: "agent5", budgetCents: 100, spentCents: 150 });

    expect(notifRows("budget_exhausted")).toHaveLength(1);
    expect(BUDGET_NOTIFY_DEDUP_WINDOW_MS).toBe(86_400_000);
  });

  it("C-5 claimNextTask 预算未耗尽 → 不记 budget_exhausted 通知", async () => {
    await db.insert(agents).values({ id: 6, name: "agent6", budgetCents: 100, spentCents: 10 });

    await claimNextTask(db as never, 6);

    expect(notifRows("budget_exhausted")).toHaveLength(0);
  });
});
