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

import { usageRouter } from "../../api/usage-router";
import { createCallerFactory } from "../../api/middleware";

const createCaller = createCallerFactory(usageRouter);

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

describe("Usage Flow - Usage Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectFn.mockReset();
    mockSelectFn.mockImplementation(() => mockData);
    mockInsertResult.mockReset();
    mockInsertResult.mockReturnValue({ insertId: 1 });
    mockData = [];
  });

  it("should record usage and compute total tokens", async () => {
    const caller = createCaller(mockCtx());
    const result = await caller.record({
      model: "gpt-4",
      promptTokens: 100,
      completionTokens: 50,
    });

    expect(result).toBeDefined();
    expect(result.id).toBe(1);
    expect(result.totalTokens).toBe(150);
    expect(typeof result.costCents).toBe("number");
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("should reject recording usage with negative tokens", async () => {
    const caller = createCaller(mockCtx());
    await expect(
      caller.record({
        model: "gpt-4",
        promptTokens: -1,
        completionTokens: 0,
      })
    ).rejects.toThrow();
  });

  it("should list usage records", async () => {
    mockData = [
      { id: 1, model: "gpt-4", promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      { id: 2, model: "gpt-3.5", promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.list({ limit: 10 });

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("should aggregate usage by model", async () => {
    mockData = [
      { model: "gpt-4", provider: "openai", promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedPromptTokens: 0, uncachedPromptTokens: 100, callCount: 1, costCents: 2 },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.byModel({});

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("gpt-4");
  });

  it("should aggregate usage by day", async () => {
    mockData = [
      { date: "2026-07-23", promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedPromptTokens: 0, uncachedPromptTokens: 100, callCount: 1, costCents: 2 },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.byDay({});

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-07-23");
  });

  it("should aggregate usage by agent", async () => {
    mockData = [
      { agentId: 1, agentName: "Agent Alpha", promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedPromptTokens: 0, uncachedPromptTokens: 100, callCount: 1, costCents: 2 },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.byAgent({});

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe(1);
  });

  it("should return cache stats", async () => {
    mockData = [
      { totalPromptTokens: 100, cachedPromptTokens: 80, uncachedPromptTokens: 20, totalTokens: 150, callCount: 2, costCents: 3 },
      { model: "gpt-4", cachedPromptTokens: 80, uncachedPromptTokens: 20, totalPromptTokens: 100, callCount: 2, costCents: 3 },
      { agentId: 1, agentName: "Agent Alpha", cachedPromptTokens: 80, uncachedPromptTokens: 20, totalPromptTokens: 100, callCount: 2 },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.cacheStats({});

    expect(result).toBeDefined();
    expect(result.overall).toBeDefined();
    expect(result.overall.cacheHitRate).toBe(80);
    expect(Array.isArray(result.byModel)).toBe(true);
    expect(Array.isArray(result.byAgent)).toBe(true);
  });
});
