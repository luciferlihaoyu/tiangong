import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock database with a simple, flexible chain
let mockData: Array<Record<string, unknown>> = [];
const mockSelectFn = vi.fn(() => mockData);
const mockInsertResult = vi.fn(() => ({ insertId: 1 }));

const chained = (val: unknown) => ({
  orderBy: vi.fn(() => chained(val)),
  then: vi.fn((cb: unknown) => (typeof cb === "function" ? (cb as (v: unknown) => unknown)(val) : val)),
  limit: vi.fn(() => val),
  where: vi.fn(() => chained(val)),
  leftJoin: vi.fn(() => chained(val)),
  groupBy: vi.fn(() => chained(val)),
});

const mockDb = {
  select: vi.fn(() => ({ from: vi.fn(() => chained(mockSelectFn())) })),
  insert: vi.fn(() => ({ values: vi.fn(() => mockInsertResult()) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => chained([])) })) })),
  delete: vi.fn(() => ({ where: vi.fn() })),
};

vi.mock("../../api/queries/connection", () => ({ getDb: () => mockDb }));

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

vi.mock("../../api/lib/password", () => ({
  hashPassword: vi.fn(async (s: string) => `hashed_${s}`),
  verifyPassword: vi.fn(async (s: string, h: string) => h === `hashed_${s}`),
}));

import { taskboardRouter } from "../../api/taskboard-router";
import { createCallerFactory } from "../../api/middleware";

const createCaller = createCallerFactory(taskboardRouter);

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    taskId: "TG-001",
    name: "Test Task",
    boardStatus: "review",
    reviewerId: null,
    agentId: 2,
    parentTaskId: null,
    ...overrides,
  };
}

describe("Taskboard Flow - Taskboard Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectFn.mockReset();
    mockSelectFn.mockImplementation(() => mockData);
    mockInsertResult.mockReset();
    mockInsertResult.mockReturnValue({ insertId: 1 });
    mockData = [];
  });

  it("should approve a task in review", async () => {
    mockData = [taskRow({ reviewerId: 1 })];

    const caller = createCaller(mockCtx());
    const result = await caller.approve({ taskId: 1, agentId: 1, comment: "Looks good" });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("should reject approval when caller is not the assigned reviewer", async () => {
    mockData = [taskRow({ reviewerId: 2 })];

    const caller = createCaller(mockCtx());
    await expect(caller.approve({ taskId: 1, agentId: 1 })).rejects.toThrow(
      "Only the assigned reviewer can approve this task"
    );
  });

  it("should reject a task in review", async () => {
    mockData = [taskRow({ reviewerId: 1 })];

    const caller = createCaller(mockCtx());
    const result = await caller.reject({ taskId: 1, agentId: 1, reason: "Needs rework" });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("should request changes on a task in review", async () => {
    mockData = [taskRow({ reviewerId: 1 })];

    const caller = createCaller(mockCtx());
    const result = await caller.requestChanges({ taskId: 1, agentId: 1, reason: "Fix typo" });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("should list review tasks for a reviewer", async () => {
    mockData = [
      { id: 1, taskId: "TG-001", name: "Task A", boardStatus: "review", reviewerId: 1 },
      { id: 2, taskId: "TG-002", name: "Task B", boardStatus: "review", reviewerId: 1 },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.listReviewTasks({ agentId: 1 });

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("should get dependency chain for a task", async () => {
    mockSelectFn
      .mockReturnValueOnce([{ id: 1, taskId: "TG-001", name: "Root", boardStatus: "running" }])
      .mockReturnValueOnce([{ id: 10, taskId: 1, dependsOnTaskId: 2 }])
      .mockReturnValueOnce([{ id: 11, taskId: 3, dependsOnTaskId: 1 }])
      .mockReturnValueOnce([
        { id: 2, taskId: "TG-002", name: "Dependency", boardStatus: "done" },
        { id: 3, taskId: "TG-003", name: "Blocked By", boardStatus: "todo" },
      ]);

    const caller = createCaller(mockCtx());
    const result = await caller.getDependencyChain({ taskId: 1 });

    expect(result).toBeDefined();
    expect(result).not.toBeNull();
    expect(result?.taskId).toBe(1);
    expect(result?.blocks).toHaveLength(1);
    expect(result?.blockedBy).toHaveLength(1);
  });

  it("should return null for dependency chain when task not found", async () => {
    mockSelectFn.mockReturnValue([]);

    const caller = createCaller(mockCtx());
    const result = await caller.getDependencyChain({ taskId: 999 });

    expect(result).toBeNull();
  });
});
