import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type DbRow = Readonly<Record<string, unknown>>;

// ─── Mock database with a queued select result pattern (mirrors connector-mcp-auth.test.ts) ───
const dbMocks = vi.hoisted(() => {
  let selectResults: ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>> = [];
  const updateSets: ReadonlyArray<Readonly<Record<string, unknown>>> = [];

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
      values: vi.fn(() => Promise.resolve({ insertId: 1 })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
  };

  return {
    db,
    updateSets,
    queueSelectResults: (results: ReadonlyArray<ReadonlyArray<DbRow>>) => {
      selectResults = results;
    },
    clearUpdateSets: () => {
      updateSets.length = 0;
    },
  };
});

vi.mock("../../api/queries/connection", () => ({ getDb: () => dbMocks.db }));

import { agentRouter } from "../../api/agent-router";
import { taskRouter } from "../../api/task-router";
import { a2aRouter } from "../../api/a2a-router";
import { taskboardRouter } from "../../api/taskboard-router";
import { _globalApiKeys, createCallerFactory, createContext } from "../../api/middleware";

const createAgentCaller = createCallerFactory(agentRouter);
const createTaskCaller = createCallerFactory(taskRouter);
const createA2aCaller = createCallerFactory(a2aRouter);
const createBoardCaller = createCallerFactory(taskboardRouter);

const GLOBAL_KEY = "tg-execution-gate-key";

const agent16: DbRow = { id: 16, name: "OpenCode", orgId: null };

const lowRiskTask: DbRow = {
  id: 19,
  taskId: "T-LOW001",
  name: "计算 17*23 并回传结果",
  description: "只回答数字结果",
  input: null,
  priority: 50,
  agentId: 16,
  status: "queued",
  boardStatus: "todo",
};

const highRiskTask: DbRow = {
  id: 20,
  taskId: "T-HIGH01",
  name: "Deploy zeabur service to production",
  description: "zeabur deploy 上线新版本",
  input: null,
  priority: 60,
  agentId: 16,
  status: "queued",
  boardStatus: "todo",
};

/** 已被闸门停放的高风险任务（metadata 标记 pending 审批） */
function parkedHighRiskTask(overrides: Readonly<Record<string, unknown>> = {}): DbRow {
  return {
    id: 21,
    taskId: "T-HIGH02",
    name: "Deploy zeabur service",
    description: "deploy production",
    input: JSON.stringify({
      metadata: {
        traceId: "trc_gate01_abcdefgh",
        taskType: "coding_task",
        origin: { system: "mcp" },
        routing: { candidateAgentIds: [], approvalRequired: true, riskTypes: ["zeabur_deploy"] },
        policies: {},
        knowledgeRefs: [],
        artifactRefs: [],
        approval: {
          riskType: "zeabur_deploy",
          requestedByTaskId: "T-HIGH02",
          requestedByAgentId: "16",
          target: "Deploy zeabur service",
          preview: "deploy production",
          decision: "pending",
        },
      },
    }),
    status: "pending",
    boardStatus: "blocked",
    agentId: 16,
    ...overrides,
  };
}

function mockCtx(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    req: new Request("http://localhost"),
    user: { id: 1, role: "admin" },
    apiKeyAgentId: -1,
    ...overrides,
  };
}

async function callerForKey(key: string) {
  const ctx = await createContext({
    req: new Request("http://localhost/api/trpc", {
      headers: { "x-api-key": key },
    }),
  });
  return createAgentCaller(ctx);
}

describe("Execution approval gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.clearUpdateSets();
    _globalApiKeys.add(GLOBAL_KEY);
  });

  afterEach(() => {
    _globalApiKeys.delete(GLOBAL_KEY);
  });

  it("blocks claiming of a high-risk task and parks it pending approval", async () => {
    // Given: agent + one high-risk queued task + no generic tasks
    dbMocks.queueSelectResults([[agent16], [highRiskTask], []]);

    // When
    const caller = await callerForKey(GLOBAL_KEY);
    const result = await caller.claimTask({ agentId: 16 });

    // Then: nothing was claimed and the task was parked (status=pending, boardStatus=blocked)
    expect(result.task).toBeNull();
    const park = dbMocks.updateSets.find((s) => s.boardStatus === "blocked");
    expect(park).toBeDefined();
    expect(park?.status).toBe("pending");
    expect(String(park?.boardNotes ?? "")).toContain("Pending human approval");
  });

  it("still claims and executes a low-risk task (regression)", async () => {
    // Given
    dbMocks.queueSelectResults([[agent16], [lowRiskTask], []]);

    // When
    const caller = await callerForKey(GLOBAL_KEY);
    const result = await caller.claimTask({ agentId: 16 });

    // Then: low-risk task claimed with no approval flag
    expect(result.task?.id).toBe(19);
    expect(result.task?.approvalRequired).toBe(false);
    expect(dbMocks.updateSets.some((s) => s.boardStatus === "blocked")).toBe(false);
  });

  it("claims an already-approved high-risk task for execution", async () => {
    // Given: high-risk task already approved by admin (metadata approval.decision=approved, requeued)
    const approvedTask = parkedHighRiskTask({
      status: "queued",
      boardStatus: "ready",
      input: JSON.stringify({
        metadata: {
          traceId: "trc_gate02_abcdefgh",
          taskType: "coding_task",
          origin: { system: "mcp" },
          routing: { candidateAgentIds: [], approvalRequired: true, riskTypes: ["zeabur_deploy"] },
          policies: {},
          knowledgeRefs: [],
          artifactRefs: [],
          approval: {
            riskType: "zeabur_deploy",
            requestedByTaskId: "T-HIGH02",
            requestedByAgentId: "16",
            target: "Deploy zeabur service",
            preview: "deploy production",
            decision: "approved",
          },
        },
      }),
    });
    dbMocks.queueSelectResults([[agent16], [approvedTask], []]);

    // When
    const caller = await callerForKey(GLOBAL_KEY);
    const result = await caller.claimTask({ agentId: 16 });

    // Then: claimed, with approvalRequired=true so connector waits for human review after execution
    expect(result.task?.id).toBe(21);
    expect(result.task?.approvalRequired).toBe(true);
  });

  it("rejects a2a.review(approved=true) self-approval for a high-risk task", async () => {
    // Given: high-risk task submitted by an agent (parked, decision pending, lifecycle submitted)
    const submitted = parkedHighRiskTask({
      status: "running",
      boardStatus: "blocked",
      lifecycleStatus: "submitted",
    });
    dbMocks.queueSelectResults([[submitted]]);

    // When
    const caller = createA2aCaller(mockCtx());
    const result = await caller.review({ taskId: 21, approved: true, note: "Connector auto-approved" });

    // Then: completion is refused and the task is parked again
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("requires human approval");
  });

  it("refuses updateProgress force-completion for a high-risk task", async () => {
    // Given
    dbMocks.queueSelectResults([[parkedHighRiskTask()]]);

    // When
    const caller = createTaskCaller(mockCtx());
    const result = await caller.updateProgress({
      id: 21,
      progress: 100,
      status: "done",
      lifecycleStatus: "completed",
    });

    // Then
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("requires human approval");
  });

  it("blocks completion when a high-risk phrase was never parked at execution", async () => {
    const unparked = { ...highRiskTask, status: "running", lifecycleStatus: "submitted" };
    dbMocks.queueSelectResults([[unparked]]);

    const caller = createTaskCaller(mockCtx());
    const result = await caller.updateProgress({ id: 20, progress: 100, status: "done", lifecycleStatus: "completed" });

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("requires human approval");
  });

  it("still auto-completes a low-risk task via updateProgress (regression)", async () => {
    // Given: low-risk row + broadcast row
    const broadcastRow = { taskId: "T-LOW001", name: "计算 17*23", agentId: 16 };
    dbMocks.queueSelectResults([[lowRiskTask], [broadcastRow]]);

    // When
    const caller = createTaskCaller(mockCtx());
    const result = await caller.updateProgress({
      id: 19,
      progress: 100,
      status: "done",
      lifecycleStatus: "completed",
    });

    // Then
    expect(result.success).toBe(true);
  });

  it("requeues a parked high-risk task for execution on admin approval", async () => {
    // Given: task parked pending approval
    dbMocks.queueSelectResults([[parkedHighRiskTask()]]);

    // When: logged-in admin approves via the existing taskboard.approve
    const caller = createBoardCaller(mockCtx());
    const result = await caller.approve({ taskId: 21, agentId: 1, comment: "Approved for execution" });

    // Then: requeued (ready/queued) with approval.decision=approved in metadata
    expect(result.success).toBe(true);
    expect(result.requeued).toBe(true);
    const requeue = dbMocks.updateSets[dbMocks.updateSets.length - 1];
    expect(requeue?.boardStatus).toBe("ready");
    expect(requeue?.status).toBe("queued");
    expect(String(requeue?.input ?? "")).toContain('"decision":"approved"');
  });

  it("keeps the existing taskboard approve flow for post-execution review tasks", async () => {
    // Given: normal review-state task (not gated)
    const reviewTask: DbRow = {
      id: 30,
      taskId: "T-REV01",
      name: "Write summary",
      description: null,
      input: null,
      agentId: 2,
      boardStatus: "review",
      reviewerId: null,
      parentTaskId: null,
      status: "running",
    };
    dbMocks.queueSelectResults([[reviewTask], [reviewTask]]);

    // When
    const caller = createBoardCaller(mockCtx());
    const result = await caller.approve({ taskId: 30, agentId: 1 });

    // Then: unchanged review→done flow
    expect(result.success).toBe(true);
    expect(result.requeued).toBeUndefined();
  });

  it("connector no longer unconditionally self-approves (source-level guard check)", () => {
    // Given
    const src = readFileSync(resolve(process.cwd(), "scripts/openclaw-connector/connector.mjs"), "utf-8");

    // Then: the approval guard precedes both the a2a.review call and the done force-write,
    // so a2a.review/force-complete only run inside the low-risk branch.
    const gateIdx = src.indexOf("task.approvalRequired");
    const reviewIdx = src.indexOf('"a2a.review"');
    const doneWriteIdx = src.indexOf('status: "done"');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(reviewIdx).toBeGreaterThan(gateIdx);
    expect(doneWriteIdx).toBeGreaterThan(gateIdx);
  });
});
