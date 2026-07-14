import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock database with a simple, flexible chain
let mockData: any = [];
const mockSelectFn = vi.fn(() => mockData);
const mockInsertResult = vi.fn(() => ({ insertId: 1 }));

const chained = (val: any) => ({
  orderBy: vi.fn(() => ({ limit: vi.fn(() => val) })),
  then: vi.fn((cb: any) => (typeof cb === "function" ? cb(val) : val)),
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

import { taskRouter } from "../../api/task-router";
import { createCallerFactory } from "../../api/middleware";

const createCaller = createCallerFactory(taskRouter);

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

describe("Task Flow - Task Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData = [];
  });

  it("should generate a unique task ID", async () => {
    const caller = createCaller(mockCtx());
    const result = await caller.nextTaskId();

    expect(result).toBeDefined();
    expect(result.taskId).toMatch(/^TG-/);
    expect(result.taskId.length).toBeGreaterThanOrEqual(8);
  });

  it("should create a task with valid input", async () => {
    const caller = createCaller(mockCtx());
    const result = await caller.create({
      taskId: "TG-TEST001",
      name: "Test Task",
      description: "A test task",
      priority: 5,
    });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("should update task progress", async () => {
    mockData = [{ taskId: "TG-TEST001", name: "Test Task", agentId: 1 }];

    const caller = createCaller(mockCtx());
    const result = await caller.updateProgress({
      id: 1,
      progress: 50,
      status: "running",
    });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("should reject invalid task ID (empty string)", async () => {
    const caller = createCaller(mockCtx());
    await expect(
      caller.create({ taskId: "", name: "Invalid Task" })
    ).rejects.toThrow();
  });

  it("should delete a task by id", async () => {
    const caller = createCaller(mockCtx());
    const result = await caller.delete({ id: 42 });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(mockDb.delete).toHaveBeenCalled();
  });
});
