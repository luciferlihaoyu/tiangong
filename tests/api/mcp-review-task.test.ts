/**
 * p2.5-a：MCP 工具面暴露验收通道 review_task（与 tRPC a2a.review 共享同一事实源）。
 *
 * 背景（#211 教材）：api/mcp/server.ts 的口径注释写明「completed 只能由验收通道
 * （a2a.review / taskboard.approve）推进」，但 MCP 工具面没有 review 入口——
 * 外部验收方（走 MCP Key 接入的 L1 闸）永远无法收尾 submitted 单，任务卡死在
 * submitted 等一个只有 tRPC 面才有的按钮。
 *
 * 契约（本文件逐条钉死）：
 *   ① review_task(taskId, approved, note?) → 鉴权/闸门/转移/归档与 a2a.review **同一实现**
 *      （api/lib/task-review.ts 的 reviewTask；tRPC 面只是薄壳）；
 *   ② reviewer（task.reviewerId 绑定的 Key）approve → completed + completed 归档恰一次；
 *   ③ 执行者对高风险任务 self-approve → checkCompletionGate 必拦、停放、绝不落 completed
 *      （绊马索：若有人把 reviewTask 里的闸门调用删掉/绕过，此条变红）；
 *   ④ lifecycle=queued 的单不可 review（过程体前置检查文案与 tRPC 面一致）；
 *   ⑤ 非 {执行者, 验收方, admin 登录用户, 管理级 Key} 的 Key → FORBIDDEN，
 *      且拒绝 reason 与 tRPC 面同判（同一 canReviewTask 判定，不许放宽）；
 *   ⑥ tRPC a2a.review 存量行为回归：抽壳前后结果逐字段相等（成功路径断言精确形状
 *      { success: true, lifecycleStatus }，无多余键）。
 *
 * 分层说明：完成闸门在本文件用**真实** execution-gate（不桩放行）——③ 要的就是真闸；
 * finalize-actions 整体 mock（断言的是"入队与否/几次/什么 outcome"，队列执行语义
 * 由 finalize-actions.test.ts 覆盖，与 two-stage-writeback.test.ts 同口径）。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn(), broadcastToTask: vi.fn(), sendToAgent: vi.fn() }));
const finalizeMocks = vi.hoisted(() => ({ enqueueTaskFinalize: vi.fn() }));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));
// ⚠️ 不 mock execution-gate：③ 是 self-approve 绊马索，必须跑真闸门。
vi.mock("../../api/lib/finalize-actions", () => ({
  enqueueTaskFinalize: finalizeMocks.enqueueTaskFinalize,
}));

import { a2aRouter } from "../../api/a2a-router";
import { getMcpServer, type McpToolContext } from "../../api/mcp/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createCallerFactory } from "../../api/middleware";

const createA2aCaller = createCallerFactory(a2aRouter);

let testDb: TestDb;

async function seedAgent(overrides: Partial<typeof schema.agents.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.agents)
    .values({
      agentId: `a-p25-${Math.random().toString(36).slice(2, 8)}`,
      name: "p2.5 测试 Agent",
      system: "openclaw",
      status: "online",
      ...overrides,
    })
    .returning({ id: schema.agents.id });
  return rows[0].id;
}

async function seedTask(
  agentId: number | null,
  overrides: Partial<typeof schema.tasks.$inferInsert> = {}
): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-P25-${Math.random().toString(36).slice(2, 7)}`,
      name: "p2.5 验收任务",
      description: "desc",
      priority: 0,
      status: "running",
      lifecycleStatus: "submitted",
      boardStatus: "running",
      agentId,
      ...overrides,
    })
    .returning({ id: schema.tasks.id });
  return rows[0].id;
}

async function taskRow(id: number) {
  const rows = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return rows[0];
}

function completedEnqueues() {
  return finalizeMocks.enqueueTaskFinalize.mock.calls.filter(
    (c) => (c[1] as { outcome?: string }).outcome === "completed"
  );
}

/** MCP 面调用器（与 two-stage-writeback.test.ts 同款 InMemoryTransport 会话） */
async function callTool(name: string, args: Record<string, unknown>, ctx: McpToolContext) {
  const server = getMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "p25-review-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) as Record<string, any> };
  } finally {
    await client.close();
  }
}

/** tRPC 面调用器（authedQuery：apiKeyAgentId>0 = 绑定 Key；-1 = 管理级；user+null = 登录用户） */
function trpcCallerFor(bind: { apiKeyAgentId: number } | { user: { id: number; role: string } }) {
  const ctx =
    "apiKeyAgentId" in bind
      ? ({ req: new Request("http://localhost"), user: null, apiKeyAgentId: bind.apiKeyAgentId, servicePrincipal: null } as never)
      : ({ req: new Request("http://localhost"), user: bind.user, apiKeyAgentId: null, servicePrincipal: null } as never);
  return createA2aCaller(ctx);
}

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

// ─── ① 工具注册存在性 ───
describe("p2.5-a review_task：工具面存在性", () => {
  it("MCP 工具列表包含 review_task（外部验收方的收尾入口）", async () => {
    const server = getMcpServer({ apiKeyId: 1, agentId: null, permissions: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "p25-list", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("review_task");
    } finally {
      await client.close();
    }
  });
});

// ─── ② 主路径：验收方 approve → completed + 归档恰一次 ───
describe("p2.5-a review_task：验收方收尾主路径", () => {
  it("reviewer（父任务创建者场景：task.reviewerId 绑定 Key）approved → completed + completed 归档恰一次", async () => {
    const executor = await seedAgent();
    const reviewer = await seedAgent({ name: "派发方/验收方" });
    const id = await seedTask(executor, { reviewerId: reviewer });

    const boundCtx: McpToolContext = { apiKeyId: 9, agentId: reviewer, permissions: [] };
    const { isError, payload } = await callTool("review_task", { taskId: id, approved: true, note: "L1 结构验收通过" }, boundCtx);
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.status).toBe("done");
    expect(row.completedAt).not.toBeNull();
    // 归档恰好一次（t2-4 契约：completed 的 finalize 归验收通道）
    expect(completedEnqueues()).toHaveLength(1);

    // 审计事件写明"谁验收的"（与 tRPC 面同一 recordTaskEvent 形状）
    const events = await testDb.db.select().from(schema.taskMessages).where(eq(schema.taskMessages.taskId, id));
    const reviewEvent = events.find((e) => String(e.content ?? "").includes(`agent:${reviewer}(reviewer)`));
    expect(reviewEvent).toBeTruthy();
    expect(String(reviewEvent!.content)).toContain("L1 结构验收通过");
  });

  it("approved=false → reviewing（打回评审），零归档，lifecycle 从 submitted 前进", async () => {
    const executor = await seedAgent();
    const reviewer = await seedAgent();
    const id = await seedTask(executor, { reviewerId: reviewer });

    const { isError, payload } = await callTool(
      "review_task",
      { taskId: id, approved: false, note: "缺变更说明" },
      { apiKeyId: 9, agentId: reviewer, permissions: [] }
    );
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("reviewing");
    expect(completedEnqueues()).toHaveLength(0);
  });
});

// ─── ③ 绊马索：高风险 self-approve 仍被真闸门拦停 ───
describe("p2.5-a review_task：高风险 self-approve 防线（故意最恶劣输入）", () => {
  // 为何故意如此：executor 对自己认领的高风险任务在 canReviewTask 判定层拿到 ok:true
  // （c27138f 的 connector 自动收尾通道），唯一拦停点是 review 过程体内的
  // checkCompletionGate + parkTaskForApproval。本用例跑**真闸门**：若有人抽壳时
  // 删掉/绕过闸门调用，或给 review_task 开"低风险快速通道"，此条必红。
  it("执行者对自己高风险任务经 review_task self-approve → 闸门 blocked + 停放 + 绝不落 completed", async () => {
    const executor = await seedAgent();
    const id = await seedTask(executor, {
      name: "Deploy zeabur service to production",
      description: "zeabur deploy 上线新版本",
      input: JSON.stringify({ payload: "zeabur deploy 上线新版本 v2" }),
    });

    const boundCtx: McpToolContext = { apiKeyId: 9, agentId: executor, permissions: [] };
    const { isError, payload } = await callTool("review_task", { taskId: id, approved: true }, boundCtx);
    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain("requires human approval");

    const row = await taskRow(id);
    // 关键判别：闸门拦停后 lifecycle 原地不动（仍 submitted），绝不允许落 completed
    expect(row.lifecycleStatus).toBe("submitted");
    expect(row.completedAt).toBeNull();
    expect(completedEnqueues()).toHaveLength(0);
    // 停放副作用照常（与 tRPC 面同一过程体）：状态改 pending、板态 blocked
    expect(row.status).toBe("pending");
    expect(row.boardStatus).toBe("blocked");
  });
});

// ─── ④ 非法生命周期：queued 不可 review ───
describe("p2.5-a review_task：生命周期前置检查", () => {
  it("lifecycle=queued 的单 review_task → 拒绝，文案与 tRPC 面同判，零归档", async () => {
    const executor = await seedAgent();
    const reviewer = await seedAgent();
    const id = await seedTask(executor, { reviewerId: reviewer, lifecycleStatus: "queued", status: "queued" });

    const { isError, payload } = await callTool(
      "review_task",
      { taskId: id, approved: true },
      { apiKeyId: 9, agentId: reviewer, permissions: [] }
    );
    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain("Cannot review task from status queued");
    expect((await taskRow(id)).lifecycleStatus).toBe("queued");
    expect(completedEnqueues()).toHaveLength(0);
  });
});

// ─── ⑤ 鉴权矩阵：与 tRPC 面同判（同一 canReviewTask），不许放宽 ───
describe("p2.5-a review_task：鉴权与 tRPC 面同判", () => {
  /** 第三方 agent Key（既非执行者也非验收方）→ 两面同拒，reason 逐字相等 */
  it("非{执行者,验收方}的第三方 agent Key → FORBIDDEN，且与 tRPC a2a.review 同判", async () => {
    const executor = await seedAgent();
    const reviewer = await seedAgent();
    const stranger = await seedAgent({ name: "无关第三方" });

    const idA = await seedTask(executor, { reviewerId: reviewer });
    const mcp = await callTool("review_task", { taskId: idA, approved: true }, { apiKeyId: 9, agentId: stranger, permissions: [] });
    expect(mcp.isError).toBe(true);
    expect(String(mcp.payload.error)).toContain("FORBIDDEN");

    const idB = await seedTask(executor, { reviewerId: reviewer });
    const trpc = await trpcCallerFor({ apiKeyAgentId: stranger }).review({ taskId: idB, approved: true });
    expect(trpc.success).toBe(false);
    // 同判：拒绝 reason 逐字相等（共享 lib 单一事实源的强证据）
    expect(String(mcp.payload.error)).toBe(String(trpc.error));
    // 两面都未改动任务
    expect((await taskRow(idA)).lifecycleStatus).toBe("submitted");
    expect((await taskRow(idB)).lifecycleStatus).toBe("submitted");
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("reviewerId=NULL 的任务：非执行者 Key 一律拒绝（越权面不因 review_task 扩大）", async () => {
    const executor = await seedAgent();
    const stranger = await seedAgent({ name: "无关第三方B" });
    const id = await seedTask(executor, { reviewerId: null });

    const { isError, payload } = await callTool(
      "review_task",
      { taskId: id, approved: true },
      { apiKeyId: 9, agentId: stranger, permissions: [] }
    );
    expect(isError).toBe(true);
    expect(String(payload.error)).toContain("无权验收");
    expect((await taskRow(id)).lifecycleStatus).toBe("submitted");
  });

  it("管理级 Key（agentId=null → apiKeyAgentId=-1）经 review_task approve → 与 tRPC 管理位同判放行", async () => {
    const executor = await seedAgent();
    const id = await seedTask(executor);

    const { isError, payload } = await callTool(
      "review_task",
      { taskId: id, approved: true },
      { apiKeyId: 3, agentId: null, permissions: [] }
    );
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect((await taskRow(id)).lifecycleStatus).toBe("completed");
    expect(completedEnqueues()).toHaveLength(1);
  });
});

// ─── ⑥ tRPC a2a.review 存量行为回归（抽壳前后逐字段等价）───
describe("p2.5-a 抽壳回归：tRPC a2a.review 存量行为不变", () => {
  it("成功路径：返回形状逐字段相等 { success: true, lifecycleStatus: \"completed\" }（无多余键）", async () => {
    const executor = await seedAgent();
    const id = await seedTask(executor);

    const result = await trpcCallerFor({ apiKeyAgentId: executor }).review({ taskId: id, approved: true, note: "ok" });
    expect(result).toEqual({ success: true, lifecycleStatus: "completed" });

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.status).toBe("done");
    expect(row.progress).toBe(100);
    expect(row.completedAt).not.toBeNull();
    expect(completedEnqueues()).toHaveLength(1);

    const events = await testDb.db.select().from(schema.taskMessages).where(eq(schema.taskMessages.taskId, id));
    const reviewEvent = events.find((e) => String(e.metadata ?? "").includes('"actorLabel"'));
    expect(reviewEvent).toBeTruthy();
    expect(JSON.parse(String(reviewEvent!.metadata))).toMatchObject({
      approved: true,
      previousStatus: "submitted",
      lifecycleStatus: "completed",
      actorLabel: `agent:${executor}(executor)`,
    });
  });

  it("admin 登录用户路径：放行且 actorLabel 记为人（user:<id>(admin)）", async () => {
    const executor = await seedAgent();
    const id = await seedTask(executor);

    const result = await trpcCallerFor({ user: { id: 7, role: "admin" } }).review({ taskId: id, approved: true });
    expect(result).toEqual({ success: true, lifecycleStatus: "completed" });

    const events = await testDb.db.select().from(schema.taskMessages).where(eq(schema.taskMessages.taskId, id));
    const reviewEvent = events.find((e) => String(e.content ?? "").includes("[by user:7(admin)]"));
    expect(reviewEvent).toBeTruthy();
  });

  it("普通登录用户路径：拒绝且不改任务（『需要 admin 角色的登录用户』文案不变）", async () => {
    const executor = await seedAgent();
    const id = await seedTask(executor);

    const result = await trpcCallerFor({ user: { id: 8, role: "user" } }).review({ taskId: id, approved: true });
    expect(result).toEqual({ success: false, error: "FORBIDDEN：验收任务需要 admin 角色的登录用户" });
    expect((await taskRow(id)).lifecycleStatus).toBe("submitted");
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("approved=false 路径：submitted→reviewing，返回形状 { success: true, lifecycleStatus: \"reviewing\" }", async () => {
    const executor = await seedAgent();
    const id = await seedTask(executor);

    const result = await trpcCallerFor({ apiKeyAgentId: executor }).review({ taskId: id, approved: false, note: "返工" });
    expect(result).toEqual({ success: true, lifecycleStatus: "reviewing" });
    expect((await taskRow(id)).lifecycleStatus).toBe("reviewing");
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("终态任务再 review → 前置检查拒绝（completed 不可逆，存量文案逐字不变）", async () => {
    const executor = await seedAgent();
    const id = await seedTask(executor);
    await trpcCallerFor({ apiKeyAgentId: executor }).review({ taskId: id, approved: true });
    expect(completedEnqueues()).toHaveLength(1);

    const again = await trpcCallerFor({ apiKeyAgentId: executor }).review({ taskId: id, approved: true });
    expect(again).toEqual({
      success: false,
      error: "Cannot review task from status completed. Must be submitted or reviewing.",
    });
    // 重复 approve 不追加归档
    expect(completedEnqueues()).toHaveLength(1);
  });

  it("任务不存在：抛 Error(\"Task not found\")（tRPC 面既有异常形状不变）", async () => {
    await expect(trpcCallerFor({ apiKeyAgentId: -1 }).review({ taskId: 999999, approved: true })).rejects.toThrow("Task not found");
  });

  it("MCP 面任务不存在：errorResult 拒绝（不抛穿 MCP 协议层）", async () => {
    const server = getMcpServer({ apiKeyId: 3, agentId: null, permissions: [] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "p25-notfound", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "review_task", arguments: { taskId: 999999, approved: true } });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(text).toContain("Task not found");
    } finally {
      await client.close();
    }
  });
});
