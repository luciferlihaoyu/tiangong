/**
 * tRPC 身份层：API Key 必须解析出**绑定的 agent**，而不是统统塌成"未绑定管理级 -1"。
 *
 * 缺陷来历（2026-11-16 生产实测，璇玑 1000203）：`middleware.ts` 的 `verifyApiKey` 在
 * `_globalApiKeys`（boot.ts 从 `agents.mcp_token` 填的 12 条）命中时直接
 * `return { valid: true, boundAgentId: null }`，而 `createContext` 写的是
 * `apiKeyAgentId = boundAgentId ?? -1` —— 于是**每一把 connector 的 agent Key 都以管理级身份进来**，
 * 任何"按 apiKeyAgentId 判执行者/验收方"的鉴权（canReviewTask / canWriteTaskStatus /
 * agent-router 的 "Key 与目标 Agent 不匹配"）在生产上等于空转。
 * 铁证：task_messages id=991 的 `content` 尾部写着 `[by key:unbound]`，
 * 而那把 Key 在 `mcp_api_keys` 里明明白白绑着 agent 14。
 *
 * 为什么用 FakeDb 而不是队列式桩：解析要跑两次 `WHERE key=?` / `WHERE mcp_token=?` 查询，
 * 队列桩按**位次**消费结果，新增一次查询就错位（本仓已因此误红过），FakeDb 真评估条件表达式，
 * 断言只依赖"查得到/查不到"，不依赖第几枪。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// 注意：vi.mock 会被提升到文件最前面，工厂体**不能**引用顶层变量（否则运行时 those 尚未初始化，
// 整个文件以 "Cannot access 'x' before initialization" 报错、一条用例都不跑）。
// 故这里只往 fakeDbRegistry 里放实例，测试内再取回来用。
vi.mock("../../api/queries/connection", async () => {
  const mod = await import("./helpers/fake-db");
  mod.fakeDbRegistry.instance = mod.createFakeDb();
  return { getDb: () => mod.fakeDbRegistry.instance };
});

import { agents, mcpApiKeys, tasks } from "@db/schema";
import { fakeDbRegistry } from "./helpers/fake-db";
import { _globalApiKeys, createCallerFactory, createContext } from "../../api/middleware";
import { a2aRouter } from "../../api/a2a-router";

let db: any;
const createCaller = createCallerFactory(a2aRouter);

/** 情形一：`mcp_api_keys` 里有绑定行（真实库里 12 个 agent 中 10 个属于这种） */
const KEY_BOUND_IN_TABLE = "tg-keytable-bound-agent-7";
/** 情形二：只在 `agents.mcp_token` 里（女娲 id=1 与已弃用的 id=2 属于这种，key 表命中 0） */
const KEY_TOKEN_ONLY = "tg-tokenonly-bound-agent-1";
/** 情形三：在 boot 集合里但两张表都查不到 → 才是真·管理级，须保持 -1 */
const KEY_UNBOUND_LEGACY = "tg-legacy-unbound-management";

async function ctxFor(headerValue: string | null) {
  const headers: Record<string, string> = {};
  if (headerValue !== null) headers["x-api-key"] = headerValue;
  return createContext({ req: new Request("http://localhost/api/trpc", { headers }) });
}

describe("tRPC API Key 身份解析：绑定 agent 不得塌成管理级", () => {
  beforeEach(async () => {
    db = fakeDbRegistry.instance;
    db.reset();
    await db
      .insert(agents)
      .values({ id: 7, name: "云霄", role: "创意设计师 — 协助精卫", mcpToken: KEY_BOUND_IN_TABLE });
    await db
      .insert(agents)
      .values({ id: 1, name: "女娲", role: "CTO — 技术部负责人", mcpToken: KEY_TOKEN_ONLY });
    await db
      .insert(mcpApiKeys)
      .values({ id: 700, key: KEY_BOUND_IN_TABLE, agentId: 7, name: "yunxiao Connector", active: "true" });
    // 靶任务：执行者是 agent 9，无被指派验收方，处于可验收生命周期
    await db
      .insert(tasks)
      .values({
        id: 300,
        taskId: "TG-KEYBIND-1",
        name: "身份解析回归靶单",
        agentId: 9,
        reviewerId: null,
        status: "running",
        lifecycleStatus: "submitted",
      });
    for (const k of [KEY_BOUND_IN_TABLE, KEY_TOKEN_ONLY, KEY_UNBOUND_LEGACY]) _globalApiKeys.add(k);
  });

  it("解析出 mcp_api_keys 行上的绑定 agent", async () => {
    const ctx = await ctxFor(KEY_BOUND_IN_TABLE);
    expect(ctx.apiKeyAgentId).toBe(7);
  });

  it("key 表查不到时，退回 agents.mcp_token 解析绑定（女娲/编程大师即此形状）", async () => {
    const ctx = await ctxFor(KEY_TOKEN_ONLY);
    expect(ctx.apiKeyAgentId).toBe(1);
  });

  it("两张表都查不到的全局 Key 仍算管理级 -1（防过度收紧把运维主钥打死）", async () => {
    const ctx = await ctxFor(KEY_UNBOUND_LEGACY);
    expect(ctx.apiKeyAgentId).toBe(-1);
  });

  it("不带 Key 的请求是匿名 null，不是 -1", async () => {
    const ctx = await ctxFor(null);
    expect(ctx.apiKeyAgentId).toBeNull();
  });

  // 这条是本轮事故的**本体**：绑定 agent 的 Key 去验收别人的任务必须被拒。
  // 身份修好之前，它以管理级进来 → 一路放行（生产已实证写库成功）。
  it("绑定 agent 的 Key 验收他人任务必须被拒（身份层修好才谈得上鉴权）", async () => {
    const ctx = await ctxFor(KEY_BOUND_IN_TABLE);
    const result = await createCaller(ctx).review({ taskId: 300, approved: true });
    expect(result).toMatchObject({ success: false });
    expect(String((result as { error?: string }).error)).toContain("FORBIDDEN");
  });

  // 绊马索：管理级 Key 验收他人任务是**设计内**的运维通道（本次生产实证过），
  // 它不该被鉴权层拒绝；若哪天有人把它也关掉，这条会变红。
  // 此处靶单 lifecycle 为 submitted，闸门未拦时会真的改库，故断言只看"没被 FORBIDDEN 挡在鉴权层"。
  it("管理级 Key 仍是可用的运维验收通道（不得被鉴权层误杀）", async () => {
    const ctx = await ctxFor(KEY_UNBOUND_LEGACY);
    const result = await createCaller(ctx).review({ taskId: 300, approved: true });
    expect(String((result as { error?: string }).error ?? "")).not.toContain("FORBIDDEN");
  });

  // ── round-6 上线后生产实证补刀（2026-11-16）──────────────────────────────
  // 现象：女娲的 `agents.mcp_token` 打真实进程仍得 `-1`（review 返回"Cannot review…"＝鉴权已过），
  // 而库内 `SELECT id FROM agents WHERE mcp_token=?` 明明返回 id=1；一级查询对其它 8 家正常。
  // 结论：FakeDb 只证伪了"逻辑分支写错"，证伪不了**驱动返回值形状**——drizzle 的投影查询
  // `select({id: agents.id})` 在不同适配器下不保证给出 JS number。故以下三条把**形状**当被测面。
  const KEY_SHAPE_STR_ID = "tg-shape-string-id-token";
  const KEY_SHAPE_BIG_ID = "tg-shape-bigint-id-token";
  const KEY_SHAPE_NO_FIELD = "tg-shape-keyrow-without-agentid";

  it("二级解析容忍字符串形态的 agents.id（驱动返回文本即此形状）", async () => {
    await db.insert(agents).values({ id: "31", name: "形状-字符串", role: "测试", mcpToken: KEY_SHAPE_STR_ID } as any);
    _globalApiKeys.add(KEY_SHAPE_STR_ID);
    const ctx = await ctxFor(KEY_SHAPE_STR_ID);
    expect(ctx.apiKeyAgentId).toBe(31);
  });

  it("二级解析容忍 BigInt 形态的 agents.id", async () => {
    await db.insert(agents).values({ id: 32n, name: "形状-BigInt", role: "测试", mcpToken: KEY_SHAPE_BIG_ID } as any);
    _globalApiKeys.add(KEY_SHAPE_BIG_ID);
    const ctx = await ctxFor(KEY_SHAPE_BIG_ID);
    expect(ctx.apiKeyAgentId).toBe(32);
  });

  it("一级命中行但行内没有 agentId 字段时，必须继续走二级兜底", async () => {
    // 模拟映射异常/列名失配：key 表有这把 Key，却没有可用的 agentId。
    // 早前的写法 `if (row) return null;` 会在这里当场判定"孤儿 Key"，
    // 直接跳到 -1，**把二级兜底整条跳过**——这正是生产上女娲那条路径的形状。
    await db.insert(mcpApiKeys).values({ id: 900, key: KEY_SHAPE_NO_FIELD, name: "映射异常行", active: "true" } as any);
    await db.insert(agents).values({ id: 33, name: "形状-兜底", role: "测试", mcpToken: KEY_SHAPE_NO_FIELD } as any);
    _globalApiKeys.add(KEY_SHAPE_NO_FIELD);
    const ctx = await ctxFor(KEY_SHAPE_NO_FIELD);
    expect(ctx.apiKeyAgentId).toBe(33);
  });
});
