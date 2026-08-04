import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DbRow = Readonly<Record<string, unknown>>;

const dbMocks = vi.hoisted(() => {
  let selectResults: ReadonlyArray<ReadonlyArray<Readonly<Record<string, unknown>>>> = [];

  const consumeSelectResult = (): ReadonlyArray<Readonly<Record<string, unknown>>> => {
    const result = selectResults[0] ?? [];
    selectResults = selectResults.slice(1);
    return result;
  };

  const chained = (value: ReadonlyArray<Readonly<Record<string, unknown>>>) => ({
    where: vi.fn(() => chained(value)),
    orderBy: vi.fn(() => chained(value)),
    limit: vi.fn(() => Promise.resolve(value)),
    then: (
      onFulfilled: (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) => unknown,
    ) => Promise.resolve(value).then(onFulfilled),
  });

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => chained(consumeSelectResult())),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
  };

  return {
    db,
    queueSelectResults: (results: ReadonlyArray<ReadonlyArray<DbRow>>) => {
      selectResults = results;
    },
  };
});

vi.mock("../../api/queries/connection", () => ({ getDb: () => dbMocks.db }));

import { agentRouter } from "../../api/agent-router";
import { _globalApiKeys, createCallerFactory, createContext } from "../../api/middleware";

const createCaller = createCallerFactory(agentRouter);
const BOUND_KEY = "tg-16-bound-connector-key";
const GLOBAL_KEY = "tg-global-connector-key";

const activeBoundKey: DbRow = {
  id: 160,
  key: BOUND_KEY,
  agentId: 16,
  active: "true",
  rateLimit: 100,
};
const agent16: DbRow = { id: 16, name: "OpenCode", orgId: null };
const queuedTask: DbRow = {
  id: 19,
  taskId: "T-MSET52E4",
  name: "OpenCode 接入自检",
  description: "计算 17*23，只回答数字结果",
  input: null,
  priority: 50,
};

async function callerForKey(key: string) {
  const ctx = await createContext({
    req: new Request("http://localhost/api/trpc", {
      headers: { "x-mcp-key": key },
    }),
  });
  return createCaller(ctx);
}

describe("Connector authentication with issued MCP keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _globalApiKeys.delete(GLOBAL_KEY);
  });

  it("claims an assigned task when an active MCP key is bound to the target agent", async () => {
    // Given
    dbMocks.queueSelectResults([[activeBoundKey], [agent16], [agent16], [queuedTask], []]);
    const caller = await callerForKey(BOUND_KEY);

    // When
    const result = await caller.claimTask({ agentId: 16 });

    // Then
    expect(result.task).toMatchObject({ id: 19, taskId: "T-MSET52E4" });
  });

  it("forbids task claiming for another agent when the MCP key is agent-bound", async () => {
    // Given
    dbMocks.queueSelectResults([[activeBoundKey], [agent16]]);
    const caller = await callerForKey(BOUND_KEY);

    // When / Then
    await expect(caller.claimTask({ agentId: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Key 与目标 Agent 不匹配",
    });
  });

  it("forbids heartbeat updates for another agent when the MCP key is agent-bound", async () => {
    // Given
    dbMocks.queueSelectResults([[activeBoundKey], [agent16]]);
    const caller = await callerForKey(BOUND_KEY);

    // When / Then
    await expect(caller.updateHeartbeat({ id: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Key 与目标 Agent 不匹配",
    });
  });

  it("keeps global keys unrestricted when claiming tasks for any agent", async () => {
    // Given
    _globalApiKeys.add(GLOBAL_KEY);
    const agent2: DbRow = { id: 2, name: "CodeMaster", orgId: null };
    dbMocks.queueSelectResults([[agent2], [queuedTask], []]);
    const caller = await callerForKey(GLOBAL_KEY);

    // When
    const result = await caller.claimTask({ agentId: 2 });

    // Then
    expect(result.task?.id).toBe(19);
  });

  it("keeps revoked MCP keys unauthorized", async () => {
    // Given
    dbMocks.queueSelectResults([[{ ...activeBoundKey, active: "false" }]]);
    const caller = await callerForKey(BOUND_KEY);

    // When / Then
    await expect(caller.claimTask({ agentId: 16 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
