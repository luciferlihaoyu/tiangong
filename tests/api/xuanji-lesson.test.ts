/**
 * 任务 3.1：失败教训写璇玑（质量反哺）
 *
 * 覆盖：
 *   - syncTaskLessonToXuanji 单元：正常写入（title/tags/contentMarkdown 含失败原因）、
 *     xuanji_lesson 幂等（已存在标记跳过）、未配置 no-op、connector 抛错不冒泡、
 *     与成功记忆 xuanji_memory 标记互相独立（同一任务失败教训 + 成功记录可并存）
 *   - 三个挂点（全部走真实 syncTaskLessonToXuanji + mock 连接器工厂）：
 *     a. task-writeback 失败回写（reportTaskProgress status=failed 触发，error 传入与行内回退）
 *     b. taskboard 驳回（reject mutation，驳回理由进教训）
 *     c. task-runner 终态失败（retryCount >= maxRetries 才触发；重试未耗尽不触发）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WriteTaskMemoryRequestSchema, type WriteTaskMemoryRequest } from "../../api/connectors/xuanji/types";
import type { CompletedTaskView } from "../../api/lib/xuanji-sync";

type DbRow = Readonly<Record<string, unknown>>;

// ─── Mock database（照抄 xuanji-sync.test.ts 模式）───
const dbMocks = vi.hoisted(() => {
  let selectResults: ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>> = [];
  const updateSets: ReadonlyArray<Readonly<Record<string, unknown>>> = [];
  const insertValues: ReadonlyArray<Readonly<Record<string, unknown>>> = [];

  const consumeSelectResult = (): ReadonlyArray<Readonly<Record<string, unknown>>> => {
    const result = selectResults[0] ?? [];
    selectResults = selectResults.slice(1);
    return result;
  };

  const chained = (value: ReadonlyArray<Readonly<Record<string, unknown>>>) => ({
    where: vi.fn(() => chained(value)),
    orderBy: vi.fn(() => chained(value)),
    limit: vi.fn(() => Promise.resolve(value)),
    then: (onFulfilled: (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) => unknown) =>
      Promise.resolve(value).then(onFulfilled),
  });

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => chained(consumeSelectResult())),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Readonly<Record<string, unknown>>) => {
        updateSets.push(values);
        return { where: vi.fn(() => Promise.resolve([])) };
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
    queueSelectResults: (results: ReadonlyArray<ReadonlyArray<DbRow>>) => {
      selectResults = results;
    },
    clearAll: () => {
      updateSets.length = 0;
      insertValues.length = 0;
    },
  };
});

vi.mock("../../api/queries/connection", () => ({ getDb: () => dbMocks.db }));

// ─── Mock the Xuanji connector service factory (createXuanjiClient) ───
const xuanjiMocks = vi.hoisted(() => {
  const client = {
    writeTaskMemory: vi.fn(),
    linkArtifact: vi.fn(),
  };
  return { client, createXuanjiClient: vi.fn() };
});

vi.mock("../../api/connectors/xuanji/service", () => ({
  createXuanjiClient: xuanjiMocks.createXuanjiClient,
}));

vi.mock("../../api/ws-manager", () => ({
  wsManager: {
    broadcastToDashboard: vi.fn(),
    broadcast: vi.fn(),
    sendToAgent: vi.fn(),
    isOnline: vi.fn(() => false),
  },
}));

vi.mock("../../api/lib/collaboration-events", () => ({
  emitCollabSummaryForTask: vi.fn().mockResolvedValue(undefined),
}));

// ─── task-runner 挂点测试所需的外围 mock（直接驱动 claimAndExecute）───
vi.mock("../../api/lib/task-concurrency", () => ({
  acquireTaskSlot: vi.fn().mockResolvedValue({ acquired: true }),
  releaseTaskSlot: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../api/lib/executor-cancellation", () => ({
  registerExecutor: vi.fn(() => ({ aborted: false })),
  unregisterExecutor: vi.fn(),
  requestExecutorCancellation: vi.fn(() => true),
}));

import { taskRouter } from "../../api/task-router";
import { taskboardRouter } from "../../api/taskboard-router";
import { createCallerFactory } from "../../api/middleware";
import {
  syncTaskLessonToXuanji,
  syncTaskMemoryToXuanji,
  XUANJI_LESSON_ARTIFACT_TYPE,
  XUANJI_MEMORY_ARTIFACT_TYPE,
} from "../../api/lib/xuanji-sync";

// TaskRunner 的 CONFIG 在模块加载时读环境变量。command 模式且不配置任何命令时
// executeCommand 立即返回 success=false（"not configured"），无需真实子进程——
// 正好充当挂点测试的失败执行体。必须先设 env 再动态 import。
process.env.TIANGONG_TASK_RUNNER_MODE = "command";
delete process.env.TIANGONG_TASK_RUNNER_COMMAND;
delete process.env.TIANGONG_TASK_RUNNER_EXEC_FILE;
delete process.env.TIANGONG_TASK_RUNNER_EXEC_ARGS_JSON;
const { taskRunner } = await import("../../api/lib/task-runner");

const createTaskCaller = createCallerFactory(taskRouter);
const createTaskboardCaller = createCallerFactory(taskboardRouter);

const mockDb = dbMocks.db as unknown as Parameters<typeof syncTaskLessonToXuanji>[0];

const writeMemoryResponse = {
  documentId: 101,
  nodeIds: [1, 2],
  edgeIds: [3],
  chunkCount: 2,
  vectorized: true,
};

function mockCtx(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    req: new Request("http://localhost"),
    user: { id: 1, role: "admin" },
    apiKeyAgentId: -1,
    ...overrides,
  };
}

/** 终态失败的执行类任务：input 为 { payload, metadata } envelope，error 为失败原因 */
const failedView: CompletedTaskView = {
  id: 21,
  taskId: "T-LESSON01",
  name: "调用外部网关生成摘要",
  description: "把当日日志汇总成一段摘要",
  input: JSON.stringify({
    payload: "调用 gateway /summarize 生成当日日志摘要",
    metadata: {
      traceId: "trc_lesson01_abcdefgh",
      taskType: "triage_task",
      origin: { system: "mcp" },
      routing: { candidateAgentIds: [], approvalRequired: false, riskTypes: [] },
      policies: {},
      knowledgeRefs: [],
      artifactRefs: [],
    },
  }),
  output: null,
  agentId: 16,
  status: "failed",
  lifecycleStatus: "failed",
  error: "模型网关 502：上游不可用",
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMocks.clearAll();
  xuanjiMocks.client.writeTaskMemory.mockReset();
  xuanjiMocks.client.linkArtifact.mockReset();
  xuanjiMocks.createXuanjiClient.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── 单元：syncTaskLessonToXuanji ───

describe("syncTaskLessonToXuanji（失败教训写璇玑）", () => {
  it("Given 终态失败任务且璇玑可用, When 写教训, Then writeTaskMemory 收到含失败原因的 lesson 载荷并落 xuanji_lesson 幂等标记", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue(writeMemoryResponse);
    dbMocks.queueSelectResults([[]]); // 幂等检查：无 xuanji_lesson 标记

    // When
    const result = await syncTaskLessonToXuanji(mockDb, failedView);

    // Then
    expect(result.synced).toBe(true);
    expect(result.reason).toBe("written");
    expect(result.documentId).toBe(101);
    expect(xuanjiMocks.client.writeTaskMemory).toHaveBeenCalledTimes(1);
    const writeCall = xuanjiMocks.client.writeTaskMemory.mock.calls[0]?.[0] as WriteTaskMemoryRequest | undefined;
    expect(writeCall).toBeDefined();
    expect(WriteTaskMemoryRequestSchema.safeParse(writeCall).success).toBe(true);
    // title / tags 承载 lesson 语义（璇玑侧不区分 kind）
    expect(writeCall?.memory.title).toBe("失败教训：调用外部网关生成摘要");
    expect(writeCall?.memory.tags).toEqual(expect.arrayContaining(["lesson", "failed", "triage_task"]));
    // 失败原因优先进入 summary 与 contentMarkdown（完整保留）
    expect(String(writeCall?.memory.summary ?? "")).toContain("模型网关 502：上游不可用");
    expect(String(writeCall?.memory.contentMarkdown ?? "")).toContain("模型网关 502：上游不可用");
    // input 提示词摘要（envelope 的 payload）与教训反思引导语
    expect(String(writeCall?.memory.contentMarkdown ?? "")).toContain("调用 gateway /summarize");
    expect(String(writeCall?.memory.contentMarkdown ?? "")).toContain("教训反思");
    // task snapshot 照实传 failed
    expect(writeCall?.task.status).toBe("failed");
    expect(writeCall?.task.taskId).toBe("T-LESSON01");
    // 教训不挂 artifact
    expect(xuanjiMocks.client.linkArtifact).not.toHaveBeenCalled();
    // 独立幂等标记：type=xuanji_lesson（不复用 xuanji_memory），携带 documentId 引用
    const markers = dbMocks.insertValues.filter((v) => v.type === XUANJI_LESSON_ARTIFACT_TYPE);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.type).not.toBe(XUANJI_MEMORY_ARTIFACT_TYPE);
    expect(String(markers[0]?.jsonPayload ?? "")).toContain('"documentId":101');
  });

  it("Given 已存在 xuanji_lesson 标记, When 再写教训, Then 跳过写入", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    dbMocks.queueSelectResults([[{ id: 999 }]]); // 幂等检查：已有教训标记

    // When
    const result = await syncTaskLessonToXuanji(mockDb, failedView);

    // Then
    expect(result.synced).toBe(false);
    expect(result.reason).toBe("duplicate");
    expect(xuanjiMocks.client.writeTaskMemory).not.toHaveBeenCalled();
    expect(dbMocks.insertValues.length).toBe(0);
  });

  it("Given 未配置 XUANJI_BASE_URL（工厂返回 null）, When 写教训, Then 静默 no-op 且不触发任何 DB 查询", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(null);

    // When
    const result = await syncTaskLessonToXuanji(mockDb, failedView);

    // Then
    expect(result.synced).toBe(false);
    expect(result.reason).toBe("not_configured");
    expect(xuanjiMocks.client.writeTaskMemory).not.toHaveBeenCalled();
    expect(dbMocks.db.select).not.toHaveBeenCalled();
    expect(dbMocks.insertValues.length).toBe(0);
  });

  it("Given connector 抛错, When 写教训, Then 不向调用方冒泡且不落幂等标记", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockRejectedValue(new Error("connection refused"));
    dbMocks.queueSelectResults([[]]);

    // When
    const result = await syncTaskLessonToXuanji(mockDb, failedView);

    // Then
    expect(result.synced).toBe(false);
    expect(result.reason).toBe("write_failed");
    expect(dbMocks.insertValues.some((v) => v.type === XUANJI_LESSON_ARTIFACT_TYPE)).toBe(false);
  });

  it("Given 同一任务先失败后成功, When 教训与成功记忆先后写入, Then 两条记录各自独立幂等（xuanji_lesson 与 xuanji_memory 并存）", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue(writeMemoryResponse);

    // When：先写失败教训，再写成功完成记录（各查各的标记）
    dbMocks.queueSelectResults([[]]);
    const lessonResult = await syncTaskLessonToXuanji(mockDb, failedView);
    dbMocks.queueSelectResults([[]]);
    const memoryResult = await syncTaskMemoryToXuanji(mockDb, {
      ...failedView,
      status: "done",
      lifecycleStatus: "completed",
      output: "当日日志摘要……",
      error: null,
    });

    // Then：两次写入都成功，标记互不复用
    expect(lessonResult.synced).toBe(true);
    expect(memoryResult.synced).toBe(true);
    expect(xuanjiMocks.client.writeTaskMemory).toHaveBeenCalledTimes(2);
    const titles = xuanjiMocks.client.writeTaskMemory.mock.calls.map(
      (call) => (call[0] as WriteTaskMemoryRequest).memory.title
    );
    expect(titles[0]).toContain("失败教训");
    expect(titles[1]).toContain("完成记录");
    expect(dbMocks.insertValues.some((v) => v.type === XUANJI_LESSON_ARTIFACT_TYPE)).toBe(true);
    expect(dbMocks.insertValues.some((v) => v.type === XUANJI_MEMORY_ARTIFACT_TYPE)).toBe(true);
  });
});

// ─── 挂点 a：task-writeback 失败回写 ───

describe("挂点：reportTaskProgress 失败回写触发失败教训", () => {
  /** 外部执行体（如 dsh）认领中的低风险任务 */
  const externalTask: DbRow = {
    id: 19,
    taskId: "T-SYNC01",
    name: "计算 17*23",
    description: "只回答数字结果",
    input: String(failedView.input),
    output: null,
    agentId: 16,
    status: "running",
    lifecycleStatus: "working",
    boardStatus: "running",
    progress: 95,
    error: null,
    originSystem: null,
  };

  it("Given 外部执行体回写 status=failed 附 error, When updateProgress, Then 写入含该 error 的失败教训且不写完成记忆", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue(writeMemoryResponse);
    dbMocks.queueSelectResults([
      [externalTask], // reportTaskProgress 首查任务行
      [], // 教训幂等检查
    ]);

    // When
    const result = await createTaskCaller(mockCtx()).updateProgress({
      id: 19,
      progress: 100,
      status: "failed",
      error: "dsh 执行体退出码 1：模型网关 502",
    });

    // Then：回写主流程成功；教训恰好一次；完成记忆不触发
    expect(result.success).toBe(true);
    expect(xuanjiMocks.client.writeTaskMemory).toHaveBeenCalledTimes(1);
    const writeCall = xuanjiMocks.client.writeTaskMemory.mock.calls[0]?.[0] as WriteTaskMemoryRequest | undefined;
    expect(writeCall?.memory.title).toBe("失败教训：计算 17*23");
    expect(writeCall?.task.status).toBe("failed");
    expect(String(writeCall?.memory.summary ?? "")).toContain("dsh 执行体退出码 1：模型网关 502");
    expect(String(writeCall?.memory.contentMarkdown ?? "")).toContain("dsh 执行体退出码 1：模型网关 502");
    expect(dbMocks.insertValues.some((v) => v.type === XUANJI_LESSON_ARTIFACT_TYPE)).toBe(true);
    expect(dbMocks.insertValues.some((v) => v.type === XUANJI_MEMORY_ARTIFACT_TYPE)).toBe(false);
  });

  it("Given 回写 status=failed 未附 error 但任务行已有 error, When updateProgress, Then 教训使用 tasks 行的 error", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue(writeMemoryResponse);
    dbMocks.queueSelectResults([
      [{ ...externalTask, error: "行内已记录的失败原因" }],
      [],
    ]);

    // When
    const result = await createTaskCaller(mockCtx()).updateProgress({
      id: 19,
      progress: 100,
      status: "failed",
    });

    // Then
    expect(result.success).toBe(true);
    const writeCall = xuanjiMocks.client.writeTaskMemory.mock.calls[0]?.[0] as WriteTaskMemoryRequest | undefined;
    expect(String(writeCall?.memory.summary ?? "")).toContain("行内已记录的失败原因");
  });
});

// ─── 挂点 b：taskboard 驳回 ───

describe("挂点：taskboard.reject 驳回触发失败教训", () => {
  it("Given 审阅中的任务被驳回, When reject 附理由, Then 写入含驳回理由的失败教训", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue(writeMemoryResponse);
    const reviewTask: DbRow = {
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
    dbMocks.queueSelectResults([
      [reviewTask], // reject 首查任务行
      [], // 教训幂等检查
    ]);

    // When
    const result = await createTaskboardCaller(mockCtx()).reject({
      taskId: 40,
      agentId: 7,
      reason: "数据口径错误，需要重做",
    });

    // Then：驳回主流程成功；教训含驳回语义与理由
    expect(result.success).toBe(true);
    expect(xuanjiMocks.client.writeTaskMemory).toHaveBeenCalledTimes(1);
    const writeCall = xuanjiMocks.client.writeTaskMemory.mock.calls[0]?.[0] as WriteTaskMemoryRequest | undefined;
    expect(writeCall?.memory.title).toBe("失败教训：汇总周报");
    expect(writeCall?.task.status).toBe("failed");
    expect(String(writeCall?.memory.summary ?? "")).toContain("人工驳回");
    expect(String(writeCall?.memory.summary ?? "")).toContain("数据口径错误，需要重做");
    expect(String(writeCall?.memory.contentMarkdown ?? "")).toContain("数据口径错误，需要重做");
    expect(dbMocks.insertValues.some((v) => v.type === XUANJI_LESSON_ARTIFACT_TYPE)).toBe(true);
  });
});

// ─── 挂点 c：task-runner 终态失败 ───

describe("挂点：task-runner 终态失败触发失败教训", () => {
  /** Runner 领取前的任务行（command 模式未配置命令 → 执行立即失败） */
  const runnerTask: DbRow = {
    id: 31,
    taskId: "T-LESSON1",
    name: "爬取外部数据源",
    description: "从第三方 API 拉取行情",
    input: String(failedView.input),
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

  /** 领取成功后的回读行（claimAndExecute 的第二次 select） */
  const claimedRow: DbRow = { status: "running", progress: 10, lifecycleStatus: "claimed" };

  it("Given 重试已耗尽（retryCount >= maxRetries）且执行失败, When claimAndExecute, Then 写入含执行错误的失败教训", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue(writeMemoryResponse);
    dbMocks.queueSelectResults([
      [claimedRow], // 领取确认回读
      [], // 教训幂等检查
    ]);

    // When：直接驱动私有执行入口（测试不经过周期 tick）
    await (taskRunner as unknown as { claimAndExecute(task: DbRow): Promise<void> }).claimAndExecute(runnerTask);

    // Then
    expect(xuanjiMocks.client.writeTaskMemory).toHaveBeenCalledTimes(1);
    const writeCall = xuanjiMocks.client.writeTaskMemory.mock.calls[0]?.[0] as WriteTaskMemoryRequest | undefined;
    expect(writeCall?.memory.title).toBe("失败教训：爬取外部数据源");
    expect(writeCall?.task.status).toBe("failed");
    // command 模式未配置命令的失败原因进入教训
    expect(String(writeCall?.memory.summary ?? "")).toContain("not configured");
    expect(dbMocks.insertValues.some((v) => v.type === XUANJI_LESSON_ARTIFACT_TYPE)).toBe(true);
  });

  it("Given 自动重试未耗尽（retryCount < maxRetries）, When 执行失败, Then 不写失败教训（等待重派后的终态失败）", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue(writeMemoryResponse);
    dbMocks.queueSelectResults([[claimedRow]]);

    // When
    await (taskRunner as unknown as { claimAndExecute(task: DbRow): Promise<void> }).claimAndExecute({
      ...runnerTask,
      retryCount: 0,
      maxRetries: 3,
    });

    // Then：任务照样落 failed 终态，但教训不写
    expect(
      dbMocks.updateSets.some((set) => set.status === "failed")
    ).toBe(true);
    expect(xuanjiMocks.createXuanjiClient).not.toHaveBeenCalled();
    expect(xuanjiMocks.client.writeTaskMemory).not.toHaveBeenCalled();
    expect(dbMocks.insertValues.some((v) => v.type === XUANJI_LESSON_ARTIFACT_TYPE)).toBe(false);
  });
});
