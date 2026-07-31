import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// Mock database with a simple, flexible chain
type ThenCallback = (value: unknown[]) => unknown;

let mockData: unknown[] = [];
let mockInsertValues: unknown = null;
const mockSelectFn = vi.fn(() => mockData);
const mockInsertResult = vi.fn(() => ({ insertId: 1 }));

const chained = (val: unknown[]) => ({
  orderBy: vi.fn(() => ({ limit: vi.fn(() => val) })),
  then: vi.fn((cb: ThenCallback) => cb(val)),
  limit: vi.fn(() => val),
  where: vi.fn(() => chained(val)),
  leftJoin: vi.fn(() => chained(val)),
  groupBy: vi.fn(() => chained(val)),
});

const mockDb = {
  select: vi.fn(() => ({ from: vi.fn(() => chained(mockSelectFn())) })),
  insert: vi.fn(() => ({
    values: vi.fn((values: unknown) => {
      mockInsertValues = values;
      return mockInsertResult();
    }),
  })),
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
import { parseTaskMetadata } from "../../api/lib/task-metadata";

const createCaller = createCallerFactory(taskRouter);

const TaskInsertCaptureSchema = z.object({
  taskId: z.string(),
  name: z.string(),
  input: z.string(),
});

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

describe("Task Flow - Task Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData = [];
    mockInsertValues = null;
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

    const insertedTask = TaskInsertCaptureSchema.parse(mockInsertValues);
    const metadata = parseTaskMetadata(insertedTask.input);
    expect(insertedTask.taskId).toBe("TG-TEST001");
    expect(insertedTask.name).toBe("Test Task");
    expect(metadata?.taskType).toBe("triage_task");
    expect(metadata?.traceId).toMatch(/^trc_[0-9a-z]+_[0-9a-z]{8}$/);
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
