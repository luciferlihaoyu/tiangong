import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * P2 修复（2026-11-13）：agent.list / getById / getBySource 均为 publicProcedure（匿名可调），
 * 旧实现 db.select().from(agents) 全列返回——agents.mcp_token 是 12 家 connector 的活凭证
 * （与 mcp_api_keys.key 同源 10/12，且鉴权 fast path 命中 _globalApiKeys 即有效、不查 active），
 * 公网匿名一次 GET 即可冒充任意 agent 认领任务/回写结果/发消息。
 *
 * 修法：公开查询一律剥离 mcpToken / sourceApiKey。
 * 依据：前端 src/ 对这两字段零消费（grep 实证），裁剪零影响。
 */

let mockData: any = [];
const mockSelectFn = vi.fn(() => mockData);
const chained = (val: any) => ({
  orderBy: vi.fn(() => chained(val)),
  then: vi.fn((cb: any) => (typeof cb === "function" ? cb(val) : val)),
  limit: vi.fn(() => val),
  where: vi.fn(() => chained(val)),
});
const mockDb = {
  select: vi.fn(() => ({ from: vi.fn(() => chained(mockSelectFn())) })),
};
vi.mock("../../api/queries/connection", () => ({ getDb: () => mockDb }));

import { agentRouter } from "../../api/agent-router";
import { createCallerFactory } from "../../api/middleware";

const createCaller = createCallerFactory(agentRouter);

function mockCtx(overrides: Record<string, unknown> = {}) {
  return { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1, ...overrides };
}

describe("Agent Router - 公开查询凭证脱敏（P2）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData = [];
  });

  const row = {
    id: 1,
    agentId: "nvwa",
    name: "女娲",
    source: "openclaw",
    status: "online",
    mcpToken: "tg-1-SECRET",
    sourceApiKey: "sk-SECRET",
  };

  it("list 不返回 mcpToken/sourceApiKey，其余字段保留", async () => {
    mockData = [row];
    const caller = createCaller(mockCtx());
    const rows = await caller.list();
    expect(rows[0].mcpToken).toBeUndefined();
    expect(rows[0].sourceApiKey).toBeUndefined();
    expect(rows[0].agentId).toBe("nvwa");
    expect(rows[0].name).toBe("女娲");
    expect(rows[0].status).toBe("online");
  });

  it("getById 同样脱敏", async () => {
    mockData = [row];
    const caller = createCaller(mockCtx());
    const got = await caller.getById({ id: 1 });
    expect(got.mcpToken).toBeUndefined();
    expect(got.sourceApiKey).toBeUndefined();
    expect(got.agentId).toBe("nvwa");
  });

  it("getBySource 同样脱敏", async () => {
    mockData = [row];
    const caller = createCaller(mockCtx());
    const rows = await caller.getBySource({ source: "openclaw" });
    expect(rows[0].mcpToken).toBeUndefined();
    expect(rows[0].sourceApiKey).toBeUndefined();
  });
});
