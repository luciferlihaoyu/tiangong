import { describe, it, expect, vi, beforeEach } from "vitest";

const mockBuildCollabSummary = vi.hoisted(() => vi.fn());
const mockUnblockReadyCollabTasks = vi.hoisted(() => vi.fn());

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
  buildCollabSummary: mockBuildCollabSummary,
  unblockReadyCollabTasks: mockUnblockReadyCollabTasks,
}));

vi.mock("../../api/lib/password", () => ({
  hashPassword: vi.fn(async (s: string) => `hashed_${s}`),
  verifyPassword: vi.fn(async (s: string, h: string) => h === `hashed_${s}`),
}));

import { collaborationRouter } from "../../api/collaboration-router";
import { createCallerFactory } from "../../api/middleware";

const createCaller = createCallerFactory(collaborationRouter);

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

describe("Collaboration Flow - Collaboration Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectFn.mockReset();
    mockSelectFn.mockImplementation(() => mockData);
    mockInsertResult.mockReset();
    mockInsertResult.mockReturnValue({ insertId: 1 });
    mockBuildCollabSummary.mockReset();
    mockUnblockReadyCollabTasks.mockReset();
    mockData = [];
  });

  it("should delegate subtasks for a parent task", async () => {
    const parent = { id: 100, taskId: "TG-100", name: "Mission", status: "running" };
    const child = { id: 101, taskId: "C2S-01", name: "Subtask 1", status: "queued", parentTaskId: 100, agentId: 2 };
    const message = { id: 201, fromAgent: 1, toAgent: 2, taskId: 101, type: "command", status: "sent" };

    mockSelectFn
      .mockReturnValueOnce([parent]) // select parent
      .mockReturnValueOnce([{ id: 1 }]) // select coordinator
      .mockReturnValueOnce([{ id: 2 }]) // select assignees
      .mockReturnValueOnce([]) // existing message by idempotency key
      .mockReturnValueOnce([]) // existing child by taskKey
      .mockReturnValueOnce([child]) // created child
      .mockReturnValueOnce([]) // existing message in sendDelegationMessage
      .mockReturnValueOnce([message]); // inserted message fetch (unused because offline)

    const caller = createCaller(mockCtx());
    const result = await caller.delegate({
      parentTaskId: 100,
      coordinatorAgentId: 1,
      subtasks: [
        {
          title: "Subtask 1",
          description: "Do something",
          assigneeAgentId: 2,
          priority: 5,
          input: "input data",
          dependencies: [],
        },
      ],
    });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.parentTaskId).toBe(100);
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0].taskId).toBe(101);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("should throw when parent task is not found", async () => {
    mockSelectFn.mockReturnValue([]);

    const caller = createCaller(mockCtx());
    await expect(
      caller.delegate({
        parentTaskId: 999,
        coordinatorAgentId: 1,
        subtasks: [{ title: "Subtask", assigneeAgentId: 2 }],
      })
    ).rejects.toThrow("Parent task not found");
  });

  it("should return collaboration status for a parent task", async () => {
    const parent = { id: 100, taskId: "TG-100", name: "Mission", status: "running" };
    const child = { id: 101, taskId: "C2S-01", name: "Subtask 1", status: "queued", parentTaskId: 100, agentId: 2 };
    const message = { id: 201, fromAgent: 1, toAgent: 2, taskId: 101, type: "command", status: "sent" };
    const dependency = { id: 1, taskId: 101, dependsOnTaskId: 102 };
    const agent = { id: 2, agentId: "A002", name: "Agent Beta", status: "online" };

    mockSelectFn
      .mockReturnValueOnce([parent])
      .mockReturnValueOnce([child])
      .mockReturnValueOnce([message])
      .mockReturnValueOnce([dependency])
      .mockReturnValueOnce([agent]);

    const caller = createCaller(mockCtx());
    const result = await caller.status({ parentTaskId: 100 });

    expect(result).toBeDefined();
    expect(result.parent).toEqual(parent);
    expect(result.counts).toBeDefined();
    expect(result.subtasks).toHaveLength(1);
    expect(result.subtasks[0].task).toEqual(child);
  });

  it("should return collaboration summary for a parent task", async () => {
    mockBuildCollabSummary.mockResolvedValue({
      parentTaskId: 100,
      overallStatus: "done",
      total: 1,
      completed: 1,
      outputs: [{ taskId: 101, output: "result" }],
    });

    const caller = createCaller(mockCtx());
    const result = await caller.summary({ parentTaskId: 100 });

    expect(result).toBeDefined();
    expect(result.parentTaskId).toBe(100);
    expect(result.overallStatus).toBe("done");
    expect(result.total).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.outputs).toHaveLength(1);
  });

  it("should unblock ready subtasks when dependencies are done", async () => {
    mockUnblockReadyCollabTasks.mockResolvedValue([
      { id: 101, taskId: "C2S-01", name: "Subtask 1", status: "queued", parentTaskId: 100, agentId: 2 },
    ]);

    const caller = createCaller(mockCtx());
    const result = await caller.unblockReady({ parentTaskId: 100 });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.queuedTaskIds).toHaveLength(1);
    expect(result.queuedTaskIds[0]).toBe(101);
    expect(mockUnblockReadyCollabTasks).toHaveBeenCalledWith(100);
  });

  it("should not unblock subtasks when dependencies are not done", async () => {
    mockUnblockReadyCollabTasks.mockResolvedValue([]);

    const caller = createCaller(mockCtx());
    const result = await caller.unblockReady({ parentTaskId: 100 });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.queuedTaskIds).toHaveLength(0);
  });
});
