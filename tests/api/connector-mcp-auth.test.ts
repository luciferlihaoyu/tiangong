import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markSystemReady } from "./helpers/test-db";

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
        // 真实 node:sqlite 的 update 返回 {changes, lastInsertRowid}；返回 []（旧写法）
        // 会让"按受影响行数裁决"的 CAS 恒判失败（假 DB 与真驱动不符）。
        where: vi.fn(() => Promise.resolve({ changes: 1 })),
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
    // Phase B §2 起认领有就绪闸门；本文件测的是 MCP Key 鉴权，需先声明系统已就绪
    markSystemReady();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _globalApiKeys.delete(GLOBAL_KEY);
  });

  it("claims an assigned task when an active MCP key is bound to the target agent", async () => {
    // Given
    // 队列中的空 [] 对应 api/lib/task-claim.ts 里 `const inflight` 那次查询（单飞闸；
    // 定位用 grep 'const inflight'，勿写行号/序号——本入口经 createContext 真实鉴权，
    // 前面多两次 key/agent 查询，位次与 execution-gate.test.ts 不同）。末行供转移服务重读。
    dbMocks.queueSelectResults([[activeBoundKey], [agent16], [agent16], [], [queuedTask], [], [queuedTask]]);
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
    // 最前两个 [] = createContext 的绑定解析两次查询（先 `mcp_api_keys.key`，查不到再退
    // `agents.mcp_token`；定位用 grep 'resolveBoundAgentId'）。GLOBAL_KEY **故意**两张表都不塞，
    // 这样它才归"未绑定管理级 -1"、才有"可为任意 agent 认领"的语义——本用例测的就是这把管理级通道。
    // 后面的空 [] = task-claim.ts `const inflight` 单飞闸查询；末行供转移服务重读。
    dbMocks.queueSelectResults([[], [], [agent2], [], [queuedTask], [], [queuedTask]]);
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
