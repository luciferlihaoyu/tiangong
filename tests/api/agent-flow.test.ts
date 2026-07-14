import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock database with a simple, flexible chain
let mockData: any = [];
const mockSelectFn = vi.fn(() => mockData);
const mockInsertResult = vi.fn(() => ({ insertId: 1 }));

const chained = (val: any) => ({
  orderBy: vi.fn(() => chained(val)),
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

import { agentRouter } from "../../api/agent-router";
import { createCallerFactory } from "../../api/middleware";

const createCaller = createCallerFactory(agentRouter);

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

describe("Agent Flow - Agent Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData = [];
  });

  it("should list all agents", async () => {
    mockData = [
      { id: 1, agentId: "A001", name: "Agent Alpha", status: "idle", system: "tiangong" },
      { id: 2, agentId: "A002", name: "Agent Beta", status: "online", system: "tiangong" },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.list();

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Agent Alpha");
  });

  it("should create a new agent with valid input", async () => {
    const caller = createCaller(mockCtx());
    const result = await caller.create({
      agentId: "A003",
      name: "Agent Gamma",
      system: "tiangong",
    });

    expect(result).toBeDefined();
    expect(result.id).toBeDefined();
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("should reject agent creation with empty agentId", async () => {
    const caller = createCaller(mockCtx());
    await expect(
      caller.create({ agentId: "", name: "Invalid", system: "tiangong" })
    ).rejects.toThrow();
  });

  it("should update agent status", async () => {
    const caller = createCaller(mockCtx());
    const result = await caller.updateStatus({
      id: 1,
      status: "online",
      task: "Running diagnostics",
      progress: 75,
    });

    expect(result).toBeDefined();
    expect(mockDb.update).toHaveBeenCalled();
  });

  it("should reject invalid status value", async () => {
    const caller = createCaller(mockCtx());
    await expect(
      caller.updateStatus({ id: 1, status: "offline" as any })
    ).rejects.toThrow();
  });
});
