import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WriteTaskMemoryRequestSchema, type LinkArtifactRequest, type WriteTaskMemoryRequest } from "../../api/connectors/xuanji/types";
import type { CompletedTaskView } from "../../api/lib/xuanji-sync";

type DbRow = Readonly<Record<string, unknown>>;

// ─── Mock database (mirrors execution-gate.test.ts pattern) ───
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

import { taskboardRouter } from "../../api/taskboard-router";
import { a2aRouter } from "../../api/a2a-router";
import { createCallerFactory } from "../../api/middleware";
import { syncTaskMemoryToXuanji, XUANJI_MEMORY_ARTIFACT_TYPE } from "../../api/lib/xuanji-sync";

const createTaskCaller = createCallerFactory(taskboardRouter);
const createA2aCaller = createCallerFactory(a2aRouter);

const mockDb = dbMocks.db as unknown as Parameters<typeof syncTaskMemoryToXuanji>[0];

const writeMemoryResponse = {
  documentId: 101,
  nodeIds: [1, 2],
  edgeIds: [3],
  chunkCount: 2,
  vectorized: true,
};

/** 低风险已执行任务：input 为 { payload, metadata } envelope，含 traceId / approval 上下文 */
const completedTask: DbRow = {
  id: 19,
  taskId: "T-SYNC01",
  name: "计算 17*23",
  description: "只回答数字结果",
  input: JSON.stringify({
    payload: "计算并返回 17*23",
    metadata: {
      traceId: "trc_sync01_abcdefgh",
      taskType: "triage_task",
      origin: { system: "mcp" },
      routing: { candidateAgentIds: [], approvalRequired: false, riskTypes: [] },
      policies: {},
      knowledgeRefs: [],
      artifactRefs: [],
      approval: {
        riskType: "external_send",
        requestedByTaskId: "T-SYNC01",
        requestedByAgentId: "16",
        target: "计算 17*23",
        preview: "计算并返回 17*23",
        decision: "approved",
      },
    },
  }),
  output: "391",
  agentId: 16,
  status: "running",
  lifecycleStatus: "working",
  boardStatus: "running",
  progress: 95,
};

const completedView: CompletedTaskView = {
  id: 19,
  taskId: "T-SYNC01",
  name: "计算 17*23",
  description: "只回答数字结果",
  input: String(completedTask.input),
  output: "391",
  agentId: 16,
  status: "done",
  lifecycleStatus: "completed",
};

/** 带 artifact ref 的任务：用于验证可选 linkArtifact */
const completedViewWithArtifact: CompletedTaskView = {
  id: 20,
  taskId: "T-SYNC02",
  name: "生成报告",
  description: null,
  input: JSON.stringify({
    payload: "生成 Markdown 报告",
    metadata: {
      traceId: "trc_sync02_abcdefgh",
      taskType: "writing_task",
      origin: { system: "mcp" },
      routing: { candidateAgentIds: [], approvalRequired: false, riskTypes: [] },
      policies: {},
      knowledgeRefs: [],
      artifactRefs: [
        { storage: "tos", ref: "tos://outputs/report.md", artifactType: "markdown_report", mimeType: "text/markdown" },
      ],
    },
  }),
  output: "# 报告",
  agentId: 16,
  status: "done",
  lifecycleStatus: "completed",
};

function mockCtx(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    req: new Request("http://localhost"),
    user: { id: 1, role: "admin" },
    apiKeyAgentId: -1,
    ...overrides,
  };
}

describe("Xuanji task memory sync on completion", () => {
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

  it("Given a completed low-risk task, When updateProgress marks it done, Then exactly one writeTaskMemory call records a schema-valid payload and a dedup artifact stores the refs", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue(writeMemoryResponse);
    dbMocks.queueSelectResults([[completedTask]]);

    // When
    const result = await createTaskCaller(mockCtx()).progress({
      id: 19,
      progress: 100,
      status: "done",
      lifecycleStatus: "completed",
    });

    // Then
    expect(result.success).toBe(true);
    expect(xuanjiMocks.client.writeTaskMemory).toHaveBeenCalledTimes(1);
    const writeCall = xuanjiMocks.client.writeTaskMemory.mock.calls[0]?.[0] as WriteTaskMemoryRequest | undefined;
    expect(writeCall).toBeDefined();
    expect(WriteTaskMemoryRequestSchema.safeParse(writeCall).success).toBe(true);
    // trace 上下文来自任务 input 中的既有 metadata
    expect(writeCall?.trace.traceId).toBe("trc_sync01_abcdefgh");
    expect(writeCall?.task.taskId).toBe("T-SYNC01");
    expect(writeCall?.task.status).toBe("done");
    expect(String(writeCall?.memory.summary ?? "")).toContain("391");
    // 成功后插入去重 artifact，携带 documentId / nodeIds 引用
    const dedup = dbMocks.insertValues.find((v) => v.type === XUANJI_MEMORY_ARTIFACT_TYPE);
    expect(dedup).toBeDefined();
    expect(String(dedup?.jsonPayload ?? "")).toContain('"documentId":101');
  });

  it("Given the Xuanji client rejects, When updateProgress completes a task, Then completion still succeeds and no dedup artifact is stored", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockRejectedValue(new Error("connection refused"));
    dbMocks.queueSelectResults([[completedTask]]);

    // When
    const result = await createTaskCaller(mockCtx()).progress({
      id: 19,
      progress: 100,
      status: "done",
      lifecycleStatus: "completed",
    });

    // Then
    expect(result.success).toBe(true);
    expect(dbMocks.insertValues.some((v) => v.type === XUANJI_MEMORY_ARTIFACT_TYPE)).toBe(false);
  });

  it("Given a duplicate xuanji_memory artifact already exists, When sync runs, Then the write is skipped", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    dbMocks.queueSelectResults([[{ id: 999 }]]);

    // When
    const result = await syncTaskMemoryToXuanji(mockDb, completedView);

    // Then
    expect(result.synced).toBe(false);
    expect(result.reason).toBe("duplicate");
    expect(xuanjiMocks.client.writeTaskMemory).not.toHaveBeenCalled();
  });

  it("Given no Xuanji base URL (client factory returns null), When a task completes, Then it is a silent no-op", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(null);
    dbMocks.queueSelectResults([[completedTask]]);

    // When
    const result = await createTaskCaller(mockCtx()).progress({
      id: 19,
      progress: 100,
      status: "done",
      lifecycleStatus: "completed",
    });

    // Then
    expect(result.success).toBe(true);
    expect(xuanjiMocks.client.writeTaskMemory).not.toHaveBeenCalled();
    expect(dbMocks.insertValues.length).toBe(0);
  });

  it("Given a task with an artifact ref in metadata, When sync runs, Then linkArtifact is attempted and its failure is non-fatal", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue({ documentId: 7, nodeIds: [1], edgeIds: [1], chunkCount: 1, vectorized: true });
    xuanjiMocks.client.linkArtifact.mockRejectedValue(new Error("link down"));
    dbMocks.queueSelectResults([[]]);

    // When
    const result = await syncTaskMemoryToXuanji(mockDb, completedViewWithArtifact);

    // Then: memory 已写入（synced=true），linkArtifact 失败仅被记录
    expect(result.synced).toBe(true);
    expect(result.linkedArtifact).toBe(false);
    expect(xuanjiMocks.client.linkArtifact).toHaveBeenCalledTimes(1);
    const linkCall = xuanjiMocks.client.linkArtifact.mock.calls[0]?.[0] as LinkArtifactRequest | undefined;
    expect(linkCall?.artifact.artifactRef).toBe("tos://outputs/report.md");
    expect(linkCall?.documentId).toBe(7);
  });

  it("Given an admin approves a submitted task, When a2a.review completes it, Then a writeTaskMemory call is triggered", async () => {
    // Given
    xuanjiMocks.createXuanjiClient.mockReturnValue(xuanjiMocks.client);
    xuanjiMocks.client.writeTaskMemory.mockResolvedValue(writeMemoryResponse);
    const submittedTask: DbRow = { ...completedTask, status: "running", lifecycleStatus: "submitted" };
    dbMocks.queueSelectResults([[submittedTask]]);

    // When
    const result = await createA2aCaller(mockCtx()).review({ taskId: 19, approved: true, note: "ok" });

    // Then
    expect(result.success).toBe(true);
    expect(xuanjiMocks.client.writeTaskMemory).toHaveBeenCalledTimes(1);
  });
});
