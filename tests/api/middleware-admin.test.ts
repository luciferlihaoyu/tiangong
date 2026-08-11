/**
 * Regression test for the adminQuery privilege escalation fix.
 *
 * 此前 adminQuery 在"仅有有效 API Key（apiKeyAgentId !== null）但无登录用户"时
 * 会放行，导致任何 agent 级 MCP Key（如 connector Key）都能执行 admin 过程
 * （auth.register / mcp.createKey / taskboard.approve 等）。修复后 admin 权限
 * 只授予登录用户的 admin 角色。
 */
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

// setup.ts 已将 verifyToken mock 为返回 null；此处按用例覆写返回值。
import { verifyToken } from "../../api/local-auth-router";
import {
  _globalApiKeys,
  adminQuery,
  createCallerFactory,
  createContext,
  createRouter,
} from "../../api/middleware";

const GLOBAL_KEY = "tg-admin-test-global-key";
const agent16: DbRow = { id: 16, name: "OpenCode", orgId: null };
const adminUser: DbRow = { id: 1, username: "admin", role: "admin" };
const normalUser: DbRow = { id: 2, username: "user", role: "user" };

const testRouter = createRouter({
  adminProbe: adminQuery.query(async () => ({ ok: true })),
});
const createCaller = createCallerFactory(testRouter);

async function callerForHeaders(headers: Record<string, string>) {
  const ctx = await createContext({
    req: new Request("http://localhost/api/trpc", { headers }),
  });
  return createCaller(ctx);
}

describe("adminQuery privilege escalation fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    _globalApiKeys.delete(GLOBAL_KEY);
  });

  it("rejects an agent-level API key (no login user) from admin procedures", async () => {
    // Given: only a valid API key, no Bearer JWT user
    _globalApiKeys.add(GLOBAL_KEY);
    dbMocks.queueSelectResults([[agent16]]);
    const caller = await callerForHeaders({ "x-api-key": GLOBAL_KEY });

    // When / Then: adminQuery must NOT pass on API key alone
    await expect(caller.adminProbe()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("rejects an API key bound to an agent (connector-style) from admin procedures", async () => {
    // Given: an MCP key bound to agent 16 in DB (verifyMcpKey path)
    const boundKey = "tg-16-admin-bound-key";
    const activeBoundKey: DbRow = {
      id: 160,
      key: boundKey,
      agentId: 16,
      active: "true",
      rateLimit: 100,
    };
    dbMocks.queueSelectResults([[activeBoundKey], [agent16]]);
    const caller = await callerForHeaders({ "x-api-key": boundKey });

    // When / Then
    await expect(caller.adminProbe()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("allows an authenticated admin user through admin procedures", async () => {
    // Given: Bearer JWT resolving to an admin user
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: "1", role: "admin" });
    const caller = await callerForHeaders({ authorization: "Bearer admin.jwt.token" });

    // When
    const result = await caller.adminProbe();

    // Then
    expect(result).toEqual({ ok: true });
  });

  it("forbids an authenticated non-admin user from admin procedures", async () => {
    // Given: Bearer JWT resolving to a regular user
    vi.mocked(verifyToken).mockResolvedValueOnce({ sub: "2", role: "user" });
    const caller = await callerForHeaders({ authorization: "Bearer user.jwt.token" });

    // When / Then
    await expect(caller.adminProbe()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "需要管理员权限",
    });
  });

  it("rejects unauthenticated callers from admin procedures", async () => {
    // Given: no key, no JWT
    const caller = await callerForHeaders({});

    // When / Then
    await expect(caller.adminProbe()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  // DB helper references keep unused imports lint-clean in strict setups.
  void adminUser;
  void normalUser;
});
