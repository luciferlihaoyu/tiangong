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

import { githubRouter } from "../../api/github-router";
import { createCallerFactory } from "../../api/middleware";

const createCaller = createCallerFactory(githubRouter);

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

describe("GitHub Flow - GitHub Router", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectFn.mockReset();
    mockSelectFn.mockImplementation(() => mockData);
    mockInsertResult.mockReset();
    mockInsertResult.mockReturnValue({ insertId: 1 });
    mockData = [];
  });

  it("should return integration status", async () => {
    mockData = [
      { id: 1, owner: "acme", name: "app", fullName: "acme/app", active: "true", defaultBranch: "main" },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.status();

    expect(result).toBeDefined();
    expect(result.readiness).toBeDefined();
    expect(Array.isArray(result.repos)).toBe(true);
    expect(result.repos).toHaveLength(1);
  });

  it("should list repositories", async () => {
    mockData = [
      { id: 1, owner: "acme", name: "repo-a", fullName: "acme/repo-a", active: "true", defaultBranch: "main" },
      { id: 2, owner: "acme", name: "repo-b", fullName: "acme/repo-b", active: "true", defaultBranch: "main" },
    ];

    const caller = createCaller(mockCtx());
    const result = await caller.listRepos();

    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("should add a new repository", async () => {
    const createdRepo = { id: 5, owner: "acme", name: "new-repo", fullName: "acme/new-repo", defaultBranch: "main", active: "true" };
    mockSelectFn
      .mockReturnValueOnce([]) // existing check
      .mockReturnValueOnce([createdRepo]); // fetch created

    const caller = createCaller(mockCtx());
    const result = await caller.addRepo({ owner: "acme", name: "new-repo" });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.repo).toEqual(createdRepo);
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it("should reject adding a duplicate repository", async () => {
    const existingRepo = { id: 1, owner: "acme", name: "new-repo", fullName: "acme/new-repo", defaultBranch: "main", active: "true" };
    mockSelectFn.mockReturnValue([existingRepo]);

    const caller = createCaller(mockCtx());
    const result = await caller.addRepo({ owner: "acme", name: "new-repo" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("repo_already_exists");
  });

  it("should register a pull request with push permission", async () => {
    const createdPR = {
      id: 10,
      repoId: 1,
      prNumber: 42,
      title: "Add feature",
      body: null,
      branchName: null,
      baseBranch: null,
      headSha: null,
      authorAgentId: 1,
      status: "pending",
    };
    mockSelectFn
      .mockReturnValueOnce([{ permissionLevel: "push" }]) // permission check
      .mockReturnValueOnce([]) // existing PR check
      .mockReturnValueOnce([createdPR]); // fetch created

    const caller = createCaller(mockCtx());
    const result = await caller.registerPR({
      agentId: 1,
      repoId: 1,
      prNumber: 42,
      title: "Add feature",
    });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.pr).toEqual(createdPR);
  });

  it("should deny PR registration without push permission", async () => {
    mockSelectFn.mockReturnValue([]);

    const caller = createCaller(mockCtx());
    const result = await caller.registerPR({
      agentId: 1,
      repoId: 1,
      prNumber: 42,
      title: "Add feature",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("permission_denied");
  });

  it("should approve a pending PR", async () => {
    const pr = {
      id: 10,
      repoId: 1,
      prNumber: 42,
      title: "Add feature",
      status: "pending",
      authorAgentId: 1,
    };
    const repo = { id: 1, owner: "acme", name: "repo", fullName: "acme/repo", active: "true" };
    mockSelectFn
      .mockReturnValueOnce([pr]) // select PR
      .mockReturnValueOnce([repo]) // select repo
      .mockReturnValueOnce([{ ...pr, status: "approved" }]); // select updated PR

    const caller = createCaller(mockCtx());
    const result = await caller.approvePR({ prId: 10, reason: "Approved" });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.mergeSkipped).toBe(true);
  });

  it("should reject a pending PR", async () => {
    const pr = {
      id: 10,
      repoId: 1,
      prNumber: 42,
      title: "Add feature",
      status: "pending",
      authorAgentId: 1,
    };
    mockSelectFn
      .mockReturnValueOnce([pr]) // select PR
      .mockReturnValueOnce([{ ...pr, status: "rejected" }]); // select updated PR

    const caller = createCaller(mockCtx());
    const result = await caller.rejectPR({ prId: 10, reason: "Needs work" });

    expect(result).toBeDefined();
    expect(result.success).toBe(true);
    expect(result.pr.status).toBe("rejected");
  });
});
