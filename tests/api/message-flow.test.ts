import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock database with a simple, flexible chain
let mockData: any = [];
const mockSelectFn = vi.fn(() => mockData);
const mockInsertResult = vi.fn(() => ({ insertId: 42 }));

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

import { messageRouter } from "../../api/message-router";
import { createCallerFactory } from "../../api/middleware";

const createCaller = createCallerFactory(messageRouter);

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

describe("Message Flow - Message Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData = [];
  });

  it("should send a message with valid input", async () => {
    // insert returns insertId=42
    mockData = [];
    mockInsertResult.mockReturnValue({ insertId: 42 });

    const caller = createCaller(mockCtx());
    const result = await caller.send({
      fromAgent: 1,
      toAgent: 2,
      content: "Hello, Agent Beta!",
      type: "command",
    });

    expect(result).toBeDefined();
    expect(result.messageId).toBe(42);
  });

  it("should reject message with empty content", async () => {
    const caller = createCaller(mockCtx());
    await expect(
      caller.send({ fromAgent: 1, toAgent: 2, content: "", type: "command" })
    ).rejects.toThrow();
  });

  it("should reject message with content exceeding 5000 chars", async () => {
    const caller = createCaller(mockCtx());
    await expect(
      caller.send({ fromAgent: 1, toAgent: 2, content: "x".repeat(5001), type: "command" })
    ).rejects.toThrow();
  });

  it("should list inbox messages for an agent", async () => {
    mockData = [
      { id: 1, fromAgent: 2, toAgent: 1, content: "Msg 1", status: "sent" },
      { id: 2, fromAgent: 3, toAgent: 1, content: "Msg 2", status: "delivered" },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.inbox({ agentId: 1, limit: 10 });

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });
});
