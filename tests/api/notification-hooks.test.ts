/**
 * 通知中心 NC-3：notifyLessonRecorded helper + 6 失败教训挂点接入
 *
 * 覆盖：
 *   - notifyLessonRecorded 单元：payload 构造（title/body/metadata.channel/截断）、
 *     error=null 回退、agentId/taskId 透传
 *   - 6 挂点集成（mock recordNotification 断言调用；主流程行为由既有 xuanji-lesson 测试保证）：
 *     a. task-writeback 失败回写（reportTaskProgress status=failed）
 *     b. taskboard reject
 *     c. a2a.fail / d. a2a.timeout
 *     e. task-runner 主路径（终态失败）
 *     f. task-runner catch 兜底（广播抛错）
 *     g. lifecycle sweeper 超时终态
 *
 * 挂点测试只断言 notifyLessonRecorded → recordNotification 以正确 payload 被调用；
 * 主流程（落 failed 终态等）由既有测试保障，本文件 mock 掉 xuanji/notification 隔离关注点。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mock notification（recordNotification spy）───
const notifyMocks = vi.hoisted(() => ({
  recordNotification: vi.fn().mockResolvedValue(undefined),
  findDuplicateNotification: vi.fn().mockResolvedValue(false),
}));
vi.mock("../../api/lib/notification", () => ({
  recordNotification: notifyMocks.recordNotification,
  findDuplicateNotification: notifyMocks.findDuplicateNotification,
}));

// ─── Mock xuanji-sync（挂点主流程的教训写璇玑 no-op）───
const xuanjiMocks = vi.hoisted(() => ({
  syncTaskLessonToXuanji: vi.fn().mockResolvedValue({ synced: true, reason: "written" }),
  syncTaskMemoryToXuanji: vi.fn().mockResolvedValue({ synced: true, reason: "written" }),
}));
const alistMocks = vi.hoisted(() => ({
  syncTaskArtifactsToAlist: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../api/lib/alist-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/alist-sync")>()),
  syncTaskArtifactsToAlist: alistMocks.syncTaskArtifactsToAlist,
}));

vi.mock("../../api/lib/xuanji-sync", () => ({
  syncTaskLessonToXuanji: xuanjiMocks.syncTaskLessonToXuanji,
  syncTaskMemoryToXuanji: xuanjiMocks.syncTaskMemoryToXuanji,
}));

// ─── Mock database（queueSelectResults 模式，照抄 xuanji-lesson.test.ts）───
type AnyRow = Readonly<Record<string, unknown>>;
const dbMocks = vi.hoisted(() => {
  let selectResults: ReadonlyArray<ReadonlyArray<AnyRow>> = [];
  const updateSets: ReadonlyArray<Readonly<Record<string, unknown>>> = [];
  const insertValues: ReadonlyArray<Readonly<Record<string, unknown>>> = [];

  const consumeSelectResult = (): ReadonlyArray<AnyRow> => {
    const result = selectResults[0] ?? [];
    selectResults = selectResults.slice(1);
    return result;
  };
  const chained = (value: ReadonlyArray<AnyRow>) => ({
    where: vi.fn(() => chained(value)),
    orderBy: vi.fn(() => chained(value)),
    limit: vi.fn(() => Promise.resolve(value)),
    then: (onFulfilled: (rows: ReadonlyArray<AnyRow>) => unknown) => Promise.resolve(value).then(onFulfilled),
  });
  const db = {
    select: vi.fn(() => ({ from: vi.fn(() => chained(consumeSelectResult())) })),
    update: vi.fn(() => ({
      set: vi.fn((values: Readonly<Record<string, unknown>>) => {
        updateSets.push(values);
        // 真实驱动（node:sqlite 适配器）的 update 结果是 { changes, lastInsertRowid }，
        // 不是 []。返回 [] 会让需要判 `changes === 1` 的 CAS 转移（applyTaskTransition）
        // 误判成冲突——桩比生产"松"同样会让测试失去意义。
        return { where: vi.fn(() => Promise.resolve({ changes: 1, lastInsertRowid: 0 })) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Readonly<Record<string, unknown>>) => {
        insertValues.push(values);
        return Promise.resolve({ insertId: 1 });
      }),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
  };
  return {
    db,
    updateSets,
    insertValues,
    queueSelectResults: (results: ReadonlyArray<ReadonlyArray<AnyRow>>) => {
      selectResults = results;
    },
    clearAll: () => {
      updateSets.length = 0;
      insertValues.length = 0;
    },
  };
});
vi.mock("../../api/queries/connection", () => ({ getDb: () => dbMocks.db }));

// §3-4：终态动作改为持久入队（队列 mock；worker 的接收端载荷由真实 SQLite 测试覆盖）
const finalizeQueueMocks = vi.hoisted(() => ({
  enqueueTaskFinalize: vi.fn().mockResolvedValue({ enqueued: true }),
}));
vi.mock("../../api/lib/finalize-actions", () => ({
  enqueueTaskFinalize: finalizeQueueMocks.enqueueTaskFinalize,
}));

// ─── Router 外围 side-effect mock（照抄 external-writeback / taskboard-flow / xuanji-lesson）───
const wsMocks = vi.hoisted(() => ({
  broadcastToDashboard: vi.fn(),
  broadcast: vi.fn(),
  sendToAgent: vi.fn(),
  isOnline: vi.fn(() => false),
}));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));

vi.mock("../../api/lib/collaboration-events", () => ({
  emitCollabSummaryForTask: vi.fn().mockResolvedValue(undefined),
}));
// Phase B §3-2：失败/取消/超时的终态动作统一走 finalizeFailedTask，sweeper 不再自己内联
// 通知。这里保留真实 finalizeFailedTask（只桩 finalizeCompletedTask），才能验证
// "超时终态 → 失败教训通知（channel=lifecycle.sweeper）"这条链路真的还在。
vi.mock("../../api/lib/task-finalize", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/task-finalize")>()),
  finalizeCompletedTask: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../api/lib/password", () => ({
  hashPassword: vi.fn(async (s: string) => `hashed_${s}`),
  verifyPassword: vi.fn(async (s: string, h: string) => h === `hashed_${s}`),
}));
vi.mock("../../api/lib/taskboard-notify", () => ({
  sendMailboxNotification: vi.fn().mockResolvedValue(undefined),
  broadcastTaskNotification: vi.fn().mockResolvedValue(undefined),
  autoPromoteParentTask: vi.fn().mockResolvedValue(undefined),
  checkAndUnblockDependencies: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../api/lib/task-concurrency", () => ({
  acquireTaskSlot: vi.fn().mockResolvedValue({ acquired: true }),
  releaseTaskSlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../api/lib/executor-cancellation", () => ({
  registerExecutor: vi.fn(() => ({ aborted: false })),
  unregisterExecutor: vi.fn(),
  requestExecutorCancellation: vi.fn(() => true),
}));

import { taskboardRouter } from "../../api/taskboard-router";
import { a2aRouter } from "../../api/a2a-router";
import { reportTaskProgress } from "../../api/lib/task-writeback";
import { sweepTaskTimeouts } from "../../api/lib/sweepers/task-lifecycle";
import { createCallerFactory } from "../../api/middleware";
import { notifyLessonRecorded } from "../../api/lib/notification-hooks";
import type { TaskForLessonNotify } from "../../api/lib/notification-hooks";

// TaskRunner 的 CONFIG 在模块加载时读环境变量。command 模式且不配置任何命令时
// executeCommand 立即返回 success=false（"not configured"），充当挂点测试的失败执行体。
process.env.TIANGONG_TASK_RUNNER_MODE = "command";
delete process.env.TIANGONG_TASK_RUNNER_COMMAND;
delete process.env.TIANGONG_TASK_RUNNER_EXEC_FILE;
delete process.env.TIANGONG_TASK_RUNNER_EXEC_ARGS_JSON;
const { taskRunner } = await import("../../api/lib/task-runner");

const taskboardCaller = createCallerFactory(taskboardRouter);
const a2aCaller = createCallerFactory(a2aRouter);

function mockCtx(overrides: Readonly<Record<string, unknown>> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.clearAll();
});

// ─── 单元：notifyLessonRecorded ───

describe("notifyLessonRecorded（NC-3 单元）", () => {
  const task: TaskForLessonNotify = {
    id: 21,
    taskId: "T-LESSON01",
    name: "调用外部网关生成摘要",
    agentId: 16,
    error: "模型网关 502：上游不可用",
  };

  it("Given 终态失败任务, When notifyLessonRecorded, Then 以正确 payload 调 recordNotification", async () => {
    await notifyLessonRecorded(dbMocks.db as never, task, "task-runner.execute");

    expect(notifyMocks.recordNotification).toHaveBeenCalledTimes(1);
    const input = notifyMocks.recordNotification.mock.calls[0]?.[1];
    expect(input).toMatchObject({
      agentId: 16,
      type: "lesson_recorded",
      taskId: 21,
      title: "已记录失败教训：调用外部网关生成摘要",
    });
    expect(String(input?.body ?? "")).toContain("task-runner.execute");
    expect(String(input?.body ?? "")).toContain("模型网关 502：上游不可用");
    expect(String(input?.body ?? "")).toContain("search_xuanji");
    expect(input?.metadata).toMatchObject({
      taskKey: "T-LESSON01",
      channel: "task-runner.execute",
      error: "模型网关 502：上游不可用",
    });
  });

  it("Given error=null, When notifyLessonRecorded, Then body 用未记录失败原因回退", async () => {
    await notifyLessonRecorded(dbMocks.db as never, { ...task, error: null }, "task-writeback");

    const input = notifyMocks.recordNotification.mock.calls[0]?.[1];
    expect(String(input?.body ?? "")).toContain("未记录失败原因");
    expect(input?.metadata?.error).toBe("");
  });

  it("Given error 超长, When notifyLessonRecorded, Then body 截断 200 / metadata.error 截断 500", async () => {
    const longError = "E".repeat(600);
    await notifyLessonRecorded(dbMocks.db as never, { ...task, error: longError }, "a2a.fail");

    const input = notifyMocks.recordNotification.mock.calls[0]?.[1];
    expect(String(input?.body ?? "")).toContain("E".repeat(200));
    expect(String(input?.body ?? "")).not.toContain("E".repeat(201));
    expect(input?.metadata?.error).toHaveLength(500);
  });

  it("Given agentId=null（system 任务）, When notifyLessonRecorded, Then agentId 透传 null（由 recordNotification 跳过）", async () => {
    await notifyLessonRecorded(dbMocks.db as never, { ...task, agentId: null }, "lifecycle.sweeper");
    const input = notifyMocks.recordNotification.mock.calls[0]?.[1];
    expect(input?.agentId).toBeNull();
  });
});

// ─── 挂点 a：task-writeback 失败回写 ───

describe("挂点：task-writeback 失败回写触发 lesson_recorded 通知", () => {
  const externalTask: AnyRow = {
    id: 19,
    taskId: "T-SYNC01",
    name: "计算 17*23",
    description: "只回答数字结果",
    input: null,
    output: null,
    agentId: 16,
    status: "running",
    lifecycleStatus: "working",
    boardStatus: "running",
    progress: 95,
    error: null,
    originSystem: null,
  };

  it("Given 外部执行体回写 status=failed, When reportTaskProgress, Then 通知 agent 16 / task 19 / channel=task-writeback", async () => {
    dbMocks.queueSelectResults([
      [externalTask], // reportTaskProgress 首查任务行
      [externalTask], // 尾部广播再查任务行
    ]);

    const result = await reportTaskProgress(dbMocks.db as never, {
      id: 19,
      progress: 100,
      status: "failed",
      error: "dsh 执行体退出码 1",
    }, { apiKeyAgentId: -1 });

    expect(result.success).toBe(true);
    // §3-4：挂点 = 入队（载荷由 finalize-actions worker 展开，真实 SQLite 断言见 finalize-actions.test.ts）
    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: 19, taskPublicId: "T-SYNC01", outcome: "failed", errorChannel: "task-writeback", errorText: "dsh 执行体退出码 1" }),
    );
  });
});

// ─── 挂点 b：taskboard reject ───

describe("挂点：taskboard.reject 触发 lesson_recorded 通知", () => {
  const reviewTask: AnyRow = {
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

  it("Given 审阅中的任务被驳回, When reject 附理由, Then 通知 agent 2 / task 40 / channel=taskboard.reject 且驳回理由进 error", async () => {
    // 第 1 行供路由读取，第 2 行供转移服务写入前重读
    dbMocks.queueSelectResults([[reviewTask], [reviewTask]]);

    const result = await taskboardCaller(mockCtx()).reject({ taskId: 40, agentId: 7, reason: "数据口径错误" });

    expect(result.success).toBe(true);
    // §3-4：驳回挂点 = 入队（task_rejected 通知仍由路由自身直接记）
    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: 40, taskPublicId: "TG-040", outcome: "failed", errorChannel: "taskboard.reject" }),
    );
    const enqueueInput = finalizeQueueMocks.enqueueTaskFinalize.mock.calls[0]?.[1] as { errorText?: string } | undefined;
    expect(String(enqueueInput?.errorText ?? "")).toContain("人工驳回");
    expect(String(enqueueInput?.errorText ?? "")).toContain("数据口径错误");
  });
});

// ─── 挂点 c/d：a2a fail / timeout ───

describe("挂点：a2a.fail / a2a.timeout 触发 lesson_recorded 通知", () => {
  const workingTask: AnyRow = {
    id: 50,
    taskId: "T-A2A01",
    name: "a2a 任务一",
    description: "a2a 通道测试",
    input: null,
    output: null,
    agentId: 16,
    status: "running",
    lifecycleStatus: "working",
    originSystem: null,
    parentTaskId: null,
    // 真实行必有修订号：§3-3 转移服务用它做 CAS
    stateRevision: 1,
  };

  it("Given a2a 任务 working, When a2a.fail, Then 通知 channel=a2a.fail", async () => {
    dbMocks.queueSelectResults([
      [workingTask], // a2a.fail 首查任务行
      [workingTask], // §3-3 转移服务读行做 CAS
      [], // 通知防抖检查
    ]);

    const result = await a2aCaller(mockCtx()).fail({ taskId: 50, error: "模型网关 502", agentId: 16 });

    expect(result.success).toBe(true);
    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: 50, taskPublicId: "T-A2A01", outcome: "failed", errorChannel: "a2a.fail", errorText: "模型网关 502" }),
    );
  });

  it("Given a2a 任务 working, When a2a.timeout 附 note, Then 通知 channel=a2a.timeout 且带 a2a timeout 标识", async () => {
    dbMocks.queueSelectResults([
      [workingTask], // a2a.timeout 首查任务行
      [workingTask], // §3-3 转移服务读行做 CAS
      [], // 通知防抖检查
    ]);

    const result = await a2aCaller(mockCtx()).timeout({ taskId: 50, note: "上游 30s 无响应" });

    expect(result.success).toBe(true);
    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: 50, taskPublicId: "T-A2A01", outcome: "failed", errorChannel: "a2a.timeout" }),
    );
    const timeoutInput = finalizeQueueMocks.enqueueTaskFinalize.mock.calls[0]?.[1] as { errorText?: string } | undefined;
    expect(String(timeoutInput?.errorText ?? "")).toContain("a2a timeout");
    expect(String(timeoutInput?.errorText ?? "")).toContain("上游 30s 无响应");
  });
});

// ─── 挂点 e/f：task-runner 终态失败（主路径 + catch 兜底）───

describe("挂点：task-runner 终态失败触发 lesson_recorded 通知", () => {
  const runnerTask: AnyRow = {
    id: 31,
    taskId: "T-LESSON1",
    name: "爬取外部数据源",
    description: "从第三方 API 拉取行情",
    input: null,
    output: null,
    agentId: null,
    status: "queued",
    lifecycleStatus: "queued",
    progress: 0,
    retryCount: 3,
    maxRetries: 3,
    timeoutMs: 5_000,
    originSystem: null,
    parentTaskId: null,
    workerLeaseGeneration: 0,
    workerLeaseToken: null,
    expectedOutputSchema: null,
  };
  const claimedRow: AnyRow = { status: "running", progress: 10, lifecycleStatus: "claimed" };

  it("Given 重试已耗尽且执行失败（主路径）, When claimAndExecute, Then 通知 channel=task-runner.execute", async () => {
    dbMocks.queueSelectResults([[claimedRow]]);

    await (taskRunner as unknown as { claimAndExecute(task: AnyRow): Promise<void> }).claimAndExecute(runnerTask);

    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "failed", errorChannel: "task-runner.execute" }),
    );
    const execInput = finalizeQueueMocks.enqueueTaskFinalize.mock.calls[0]?.[1] as { errorText?: string } | undefined;
    expect(String(execInput?.errorText ?? "")).toContain("not configured");
  });

  it("Given 执行过程意外抛错（catch 兜底）且重试已耗尽, When claimAndExecute, Then 通知 channel=task-runner.catch", async () => {
    dbMocks.queueSelectResults([[claimedRow]]);
    wsMocks.broadcastToDashboard.mockImplementationOnce(() => {
      throw new Error("broadcast boom");
    });

    await (taskRunner as unknown as { claimAndExecute(task: AnyRow): Promise<void> }).claimAndExecute(runnerTask);

    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "failed", errorChannel: "task-runner.catch" }),
    );
    const catchInput = finalizeQueueMocks.enqueueTaskFinalize.mock.calls[0]?.[1] as { errorText?: string } | undefined;
    expect(String(catchInput?.errorText ?? "")).toContain("Runner internal error");
  });

  it("Given 重试未耗尽, When 执行失败, Then 不通知（等待重派后的终态失败）", async () => {
    dbMocks.queueSelectResults([[claimedRow]]);

    await (taskRunner as unknown as { claimAndExecute(task: AnyRow): Promise<void> }).claimAndExecute({
      ...runnerTask,
      retryCount: 0,
      maxRetries: 3,
    });

    expect(notifyMocks.recordNotification).not.toHaveBeenCalled();
  });
});

// ─── 挂点 g：lifecycle sweeper 超时终态 ───

describe("挂点：lifecycle sweeper 超时终态触发 lesson_recorded 通知", () => {
  const now = new Date("2025-01-01T00:00:00.000Z");
  const expiredTask: AnyRow = {
    id: 60,
    taskId: "TG-SWEEP1",
    name: "超时任务",
    description: null,
    input: null,
    output: null,
    agentId: 3,
    status: "running",
    lifecycleStatus: "working",
    retryCount: 3,
    maxRetries: 3,
    timeoutMs: 5_000,
    claimedAt: new Date("2024-12-31T23:00:00.000Z"),
    updatedAt: new Date("2024-12-31T23:00:00.000Z"),
    workerLeaseExpiresAt: new Date(now.getTime() - 1_000),
    workerLeaseGeneration: 0,
    originSystem: null,
    stateRevision: 1,
  };

  it("Given running 任务超时且重试耗尽, When sweepTaskTimeouts, Then 通知 channel=lifecycle.sweeper", async () => {
    dbMocks.queueSelectResults([
      [expiredTask], // running 扫描
      [expiredTask], // §3-3 转移服务读行做 CAS
      [], // retry_storm 检查（未达阈值）
    ]);

    await sweepTaskTimeouts(dbMocks.db as never, now);

    expect(finalizeQueueMocks.enqueueTaskFinalize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: 60, taskPublicId: "TG-SWEEP1", outcome: "failed", errorChannel: "lifecycle.sweeper" }),
    );
    const sweepInput = finalizeQueueMocks.enqueueTaskFinalize.mock.calls[0]?.[1] as { errorText?: string } | undefined;
    expect(String(sweepInput?.errorText ?? "")).toContain("任务超时未响应");
  });
});
