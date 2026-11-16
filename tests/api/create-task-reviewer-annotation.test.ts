/**
 * p2.5-c：createTask 验收方（acceptor）标注通道 —— 最小版，零收紧。
 *
 * 背景（#211 实证）：orch.createTask / MCP create_task 均不接受任何 reviewer/acceptor
 * 入参；tasks.reviewerId 只能由 taskboard submit 路径按「父任务 agentId >
 * dispatcherAgentId > null」推断。外部派单（MCP 直建、无 parent/dispatcher）落库
 * reviewerId=null → 验收收尾只剩 executor 自审，「独立验收」语义空转。
 *
 * 本票契约（只开标注通道，**不改任何鉴权语义**——canReviewTask 现状 executor/reviewer
 * 都可验收，逐字节不动；「指定 reviewer 后禁止 executor 自审」是后续编排层决策，另票）：
 *   a) createTask 接受可选 reviewerAgentId（字符串 agentId 或正整数 db id），
 *      解析成功 → 落 tasks.reviewerId；get_task 可见；
 *   b) 解析失败（agent 不存在）→ 业务拒绝，错误文案含明确原因。
 *      ⚠️ 绊马索：若有人把 fail-closed 改成"解析失败静默降级为 null 继续建单"，
 *      此条必红（b 组同时断言零落库）。故意用不存在的标识而非空白串，就是要走
 *      "查库未命中"这条最恶劣分支。
 *   c) 不带参数 → reviewerId 与现行为逐字等值（回归钉：显式参数不得改变缺省形状）；
 *   d) 显式参数与 parent 推断并存 → 显式优先（注释写明该优先级）；
 *   e) 带标注单 review_task 流程跑通：reviewer 身份可验收（actorLabel 记 (reviewer)）；
 *      executor 亦可验收——**现状语义，收紧另票**。
 *
 * 分层说明：真 SQLite（helpers/test-db），与 mcp-review-task.test.ts 同口径——
 * fake-db 的 insert 返回值形状掩盖过真实驱动的 bug（见 create-task-executor-gate.test.ts 头注）。
 * finalize-actions mock（归档队列执行语义由其自身测试覆盖）；execution-gate **不桩**，
 * e 组要的是真闸门在场（低风险任务直通，与 mcp-review-task ③ 同理由）。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn(), broadcastToTask: vi.fn(), sendToAgent: vi.fn() }));
const finalizeMocks = vi.hoisted(() => ({ enqueueTaskFinalize: vi.fn() }));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));
// ⚠️ 不 mock execution-gate：e 组 review_task 必须跑真闸门（低风险直通路径）。
vi.mock("../../api/lib/finalize-actions", () => ({
  enqueueTaskFinalize: finalizeMocks.enqueueTaskFinalize,
}));

import { orchestrationRouter } from "../../api/orchestration-router";
import { getMcpServer, type McpToolContext } from "../../api/mcp/server";
import { createCallerFactory } from "../../api/middleware";

const orchCaller = createCallerFactory(orchestrationRouter);
/** 登录态上下文：orch.createTask 是 authedQuery，这里只要过鉴权门 */
const adminCtx = { req: undefined, user: { id: 1, role: "admin" }, apiKeyAgentId: -1 } as never;

/** env-only 管理 Key（agentId=null → apiKeyAgentId=-1）：建单面通用调用位 */
const ENV_KEY_CTX: McpToolContext = { apiKeyId: 3, agentId: null, permissions: [] };

let testDb: TestDb;
let seq = 0;
const nextTaskId = () => `TG-P25C-${(seq++).toString().padStart(3, "0")}`;

beforeEach(() => {
  testDb = createTestDb();
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  for (const fn of Object.values(wsMocks)) fn.mockReset();
  finalizeMocks.enqueueTaskFinalize.mockReset().mockResolvedValue({ enqueued: true } as never);
});

afterEach(() => {
  testDb.dispose();
});

/* eslint-disable @typescript-eslint/no-explicit-any -- 工具回执是自由 JSON，断言处按需取字段 */

async function seedAgent(overrides: Partial<typeof schema.agents.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.agents)
    .values({
      agentId: `a-p25c-${Math.random().toString(36).slice(2, 8)}`,
      name: "p2.5-c 测试 Agent",
      system: "openclaw",
      status: "online",
      ...overrides,
    })
    .returning({ id: schema.agents.id });
  return rows[0].id;
}

async function taskRow(id: number) {
  const rows = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return rows[0];
}

function taskCount(): number {
  return testDb.db.select({ id: schema.tasks.id }).from(schema.tasks).all().length;
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext = ENV_KEY_CTX,
): Promise<{ isError: boolean; payload: Record<string, any> }> {
  const server = getMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "p25c-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) };
  } finally {
    await client.close();
  }
}

/** tRPC orch.createTask：返回 { success:false, error } 或抛 TRPCError，两种失败统一捕获成文本 */
async function orchCreate(input: Record<string, unknown>): Promise<{ ok: boolean; result?: Record<string, any>; errText: string }> {
  try {
    const result = await orchCaller(adminCtx).createTask(input as never);
    return { ok: true, result: result as Record<string, any>, errText: "" };
  } catch (e: any) {
    return { ok: false, errText: `${e?.code ?? ""}: ${e?.message ?? String(e)}` };
  }
}

// ═══════════════════════════════════════════════════════════
// a) 带 reviewerAgentId 建单 → 行落 reviewerId，get_task 可见
// ═══════════════════════════════════════════════════════════
describe("p2.5-c a) reviewerAgentId 标注落库", () => {
  it("tRPC createTask 带 reviewerAgentId=\"dsh\"（字符串 agentId）→ tasks.reviewerId 落该 agent 的 db id", async () => {
    const reviewer = await seedAgent({ agentId: "dsh", name: "碧霄" });
    const executor = await seedAgent({ agentId: "weaver" });
    const { ok, result, errText } = await orchCreate({
      taskId: nextTaskId(),
      name: "p2.5-c 标注单",
      agentId: executor,
      requestedAgentId: "weaver",
      reviewerAgentId: "dsh",
    });
    expect(errText).toBe("");
    expect(ok).toBe(true);
    expect(result!.success).toBe(true);
    const row = await taskRow(result!.id!);
    expect(row.reviewerId).toBe(reviewer);
  });

  it("MCP create_task 带 reviewerAgentId=数字（正整数 db id）→ 同样落库且 get_task 可见", async () => {
    const reviewer = await seedAgent({ agentId: "xuanji" });
    const executor = await seedAgent({ agentId: "runner-x" });
    const created = await callTool("create_task", {
      name: "p2.5-c MCP 标注单",
      agentId: executor,
      reviewerAgentId: reviewer, // 数字形态
    });
    expect(created.isError).toBe(false);
    expect(created.payload.success).toBe(true);
    const id = created.payload.task.id as number;
    const row = await taskRow(id);
    expect(row.reviewerId).toBe(reviewer);

    // get_task 投影可见（工具体 spread 整行，reviewerId 随任务行原样出）
    const got = await callTool("get_task", { taskId: id });
    expect(got.isError).toBe(false);
    expect(got.payload.reviewerId).toBe(reviewer);
  });

  it("MCP create_task 带 reviewerAgentId=\"dsh\"（字符串形态）→ 落库", async () => {
    const reviewer = await seedAgent({ agentId: "dsh", name: "碧霄" });
    const executor = await seedAgent({ agentId: "runner-y" });
    const created = await callTool("create_task", {
      name: "p2.5-c MCP 字符串标注单",
      agentId: executor,
      reviewerAgentId: "dsh",
    });
    expect(created.isError).toBe(false);
    expect(created.payload.success).toBe(true);
    const row = await taskRow(created.payload.task.id as number);
    expect(row.reviewerId).toBe(reviewer);
  });
});

// ═══════════════════════════════════════════════════════════
// b) 绊马索：agent 不存在 → fail-closed 拒绝，绝不静默降级为 null
// ═══════════════════════════════════════════════════════════
// 为何故意如此：本组用最恶劣输入（查库必然未命中的标识）走 fail-closed 分支。
// 若有人把拒绝改成"解析失败 → reviewerId=null 继续建单"（静默丢标注），
// a/b 两条断言（isError/success=false + 零落库）立刻变红——标注悄悄丢失
// 比拒绝更坏：派单方以为验收方已挂名，实际又是 executor 自审。
describe("p2.5-c b) 不存在的 reviewerAgentId → 业务拒绝（fail-closed）", () => {
  it("tRPC createTask 带不存在的字符串 agentId → 拒绝且文案含明确原因，零落库", async () => {
    const before = taskCount();
    const { ok, result, errText } = await orchCreate({
      taskId: nextTaskId(),
      name: "p2.5-c 坏标注单",
      requestedAgentId: "dsh",
      reviewerAgentId: "no-such-agent-xyz",
    });
    expect(ok).toBe(true); // 业务拒绝走 { success:false }（与"任务不存在"同款形状），不抛协议错
    expect(errText).toBe("");
    expect(result!.success).toBe(false);
    expect(String(result!.error)).toContain("不存在");
    expect(taskCount()).toBe(before); // 拒绝即中止，绝不带着 null 标注继续建单
  });

  it("MCP create_task 带不存在的字符串 agentId → isError + 文案含「不存在」级明确原因，零落库", async () => {
    const before = taskCount();
    const created = await callTool("create_task", {
      name: "p2.5-c 坏标注单",
      requestedAgentId: "dsh",
      reviewerAgentId: "no-such-agent-xyz",
    });
    expect(created.isError).toBe(true);
    expect(created.payload.success).toBe(false);
    expect(String(created.payload.error)).toContain("不存在");
    expect(taskCount()).toBe(before); // 拒绝即中止，绝不带着 null 标注继续建单
  });

  it("MCP create_task 带不存在的正整数 id → 同款拒绝，零落库", async () => {
    const before = taskCount();
    const created = await callTool("create_task", {
      name: "p2.5-c 坏标注单（数字）",
      requestedAgentId: "dsh",
      reviewerAgentId: 999999,
    });
    expect(created.isError).toBe(true);
    expect(String(created.payload.error)).toContain("不存在");
    expect(taskCount()).toBe(before);
  });
});

// ═══════════════════════════════════════════════════════════
// c) 回归钉：不带参数 → reviewerId 与现行为逐字等值
// ═══════════════════════════════════════════════════════════
describe("p2.5-c c) 不带 reviewerAgentId → 行为逐字不变（回归钉）", () => {
  it("tRPC createTask 不带参数 → 建单成功且 reviewerId=NULL（与今日线上逐字一致）", async () => {
    const executor = await seedAgent({ agentId: "runner-c" });
    const { ok, result, errText } = await orchCreate({
      taskId: nextTaskId(),
      name: "p2.5-c 缺省单",
      agentId: executor,
    });
    expect(errText).toBe("");
    expect(ok).toBe(true);
    expect(result!.success).toBe(true);
    const row = await taskRow(result!.id!);
    expect(row.reviewerId).toBeNull();
    expect(row.agentId).toBe(executor);
  });

  it("MCP create_task 不带参数 → 成功且 reviewerId=NULL", async () => {
    const executor = await seedAgent({ agentId: "runner-d" });
    const created = await callTool("create_task", {
      name: "p2.5-c MCP 缺省单",
      agentId: executor,
    });
    expect(created.isError).toBe(false);
    expect(created.payload.success).toBe(true);
    const row = await taskRow(created.payload.task.id as number);
    expect(row.reviewerId).toBeNull();
  });

  it("空白字符串 reviewerAgentId → 等同未提供（照 hasDeclaredExecutor 的 trim 口径），正常建单 reviewerId=NULL", async () => {
    const executor = await seedAgent({ agentId: "runner-e" });
    const created = await callTool("create_task", {
      name: "p2.5-c 空白标注单",
      agentId: executor,
      reviewerAgentId: "   ",
    });
    expect(created.isError).toBe(false);
    expect(created.payload.success).toBe(true);
    const row = await taskRow(created.payload.task.id as number);
    expect(row.reviewerId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// d) 显式参数与 parent 推断并存 → 显式优先
// ═══════════════════════════════════════════════════════════
describe("p2.5-c d) 显式 reviewerAgentId 优先于 parent 推断", () => {
  it("parentTaskId 指向某 agent 的单 + 显式 reviewerAgentId → 落显式值（taskboard submit 的推断逻辑本身不动）", async () => {
    const parentOwner = await seedAgent({ agentId: "parent-owner" });
    const explicitReviewer = await seedAgent({ agentId: "explicit-rev" });
    const executor = await seedAgent({ agentId: "runner-f" });
    const parent = await orchCreate({
      taskId: nextTaskId(),
      name: "p2.5-c 父任务",
      agentId: parentOwner,
    });
    expect(parent.ok && parent.result!.success).toBe(true);
    const parentId = parent.result!.id!;

    const child = await orchCreate({
      taskId: nextTaskId(),
      name: "p2.5-c 子任务",
      agentId: executor,
      parentTaskId: parentId,
      reviewerAgentId: "explicit-rev",
    });
    expect(child.errText).toBe("");
    expect(child.result!.success).toBe(true);
    const row = await taskRow(child.result!.id!);
    // 显式优先：不是 parentOwner（若走推断会是它），而是显式指定的 explicitReviewer
    expect(row.parentTaskId).toBe(parentId);
    expect(row.reviewerId).toBe(explicitReviewer);
    expect(row.reviewerId).not.toBe(parentOwner);
  });
});

// ═══════════════════════════════════════════════════════════
// e) 带标注单 review_task 流程跑通（现状语义：executor 也可，收紧另票）
// ═══════════════════════════════════════════════════════════
describe("p2.5-c e) 标注单可经 review_task 收尾", () => {
  it("reviewer 绑定 Key review approve → completed + 归档恰一次 + 审计 actorLabel=(reviewer)", async () => {
    const reviewer = await seedAgent({ agentId: "dsh", name: "碧霄" });
    const executor = await seedAgent({ agentId: "runner-g" });
    const created = await callTool("create_task", {
      name: "p2.5-c 可验收单",
      agentId: executor,
      reviewerAgentId: "dsh",
    });
    expect(created.payload.success).toBe(true);
    const id = created.payload.task.id as number;

    // 推进到 submitted（两段式回写的中间态，与 two-stage-writeback 同口径直接落行）
    await testDb.db
      .update(schema.tasks)
      .set({ status: "running", lifecycleStatus: "submitted", boardStatus: "review" })
      .where(eq(schema.tasks.id, id));

    const boundCtx: McpToolContext = { apiKeyId: 9, agentId: reviewer, permissions: [] };
    const { isError, payload } = await callTool("review_task", { taskId: id, approved: true, note: "p2.5-c 验收通过" }, boundCtx);
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.status).toBe("done");
    const enqueues = finalizeMocks.enqueueTaskFinalize.mock.calls.filter(
      (c) => (c[1] as { outcome?: string }).outcome === "completed"
    );
    expect(enqueues).toHaveLength(1);

    const events = await testDb.db.select().from(schema.taskMessages).where(eq(schema.taskMessages.taskId, id));
    const reviewEvent = events.find((e) => String(e.content ?? "").includes(`agent:${reviewer}(reviewer)`));
    expect(reviewEvent).toBeTruthy();
    expect(String(reviewEvent!.content)).toContain("p2.5-c 验收通过");
  });

  // 现状语义钉：canReviewTask 对 executor/reviewer 都放行——本票逐字节不动。
  // ⚠️「指定 reviewer 后禁止 executor 自审」是后续编排层决策（另票）；届时此条
  // 应随收紧一起改写为拒绝断言。在此之前它是 canReviewTask 不被本票顺带动到的证明。
  it("executor 对自己被标注了 reviewer 的单 review approve → 仍放行（现状语义，收紧另票）", async () => {
    const reviewer = await seedAgent({ agentId: "dsh", name: "碧霄" });
    const executor = await seedAgent({ agentId: "runner-h" });
    const created = await callTool("create_task", {
      name: "p2.5-c executor 自审现状单",
      agentId: executor,
      reviewerAgentId: "dsh",
    });
    const id = created.payload.task.id as number;
    await testDb.db
      .update(schema.tasks)
      .set({ status: "running", lifecycleStatus: "submitted", boardStatus: "review" })
      .where(eq(schema.tasks.id, id));

    const executorCtx: McpToolContext = { apiKeyId: 10, agentId: executor, permissions: [] };
    const { isError, payload } = await callTool("review_task", { taskId: id, approved: true }, executorCtx);
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("completed");
  });
});
