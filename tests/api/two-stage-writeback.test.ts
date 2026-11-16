/**
 * t2-4：外部回写两段式（执行完成 ≠ 归档完成）
 *
 * 验收判据（v5）原文：「#198 形状的输出不再生成完成记录」。
 * #198 的形状 = 外部执行体用 report_progress 谎报 done（status:"done"，不带
 * lifecycleStatus），旧逻辑在 :229-249 直接 enqueueTaskFinalize(completed)，
 * 于是璇玑完成记录 + AList 归档在**没有任何人验收**的情况下就生成了。
 *
 * 两段式契约：
 *   ① 外部回写 status="done"（未显式给 lifecycleStatus）→ lifecycle 落 submitted，
 *      usage **此刻**记账（花了的钱不等验收），**不入队 completed 归档**；
 *   ② review approve → completed 的现有通道（a2a.review / taskboard.approve）负责
 *      enqueueTaskFinalize(completed)——本文件钉住「恰好一次」；
 *   ③ 外部显式 lifecycleStatus="completed" 且当前已是 submitted/reviewing → 视为
 *      「验收方确认」放行 completed + 归档一次（兼容已按完整生命周期集成的调用方）；
 *      其余直落 completed 走「先 hop submitted 再拒/放行」的既有闸（:177-190 区），
 *      working 态下被状态机拒绝、零归档；
 *   ④ 内部 Runner（task-runner auto-review）路径不在 t2-4 语义范围——本文件末尾
 *      用源码级绊马索钉住它仍自行 enqueue completed，防止后续重构误删其归档责任。
 *
 * 分层说明：完成闸门 checkCompletionGate 在本文件恒桩为放行（低风险形状），
 * 高风险停防由 execution-gate.test.ts 覆盖，此处不重复。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn(), broadcastToTask: vi.fn(), sendToAgent: vi.fn() }));
const gateMocks = vi.hoisted(() => ({ checkCompletionGate: vi.fn(), parkTaskForApproval: vi.fn() }));
const finalizeMocks = vi.hoisted(() => ({ enqueueTaskFinalize: vi.fn() }));
const collabMocks = vi.hoisted(() => ({ emitCollabSummaryForTask: vi.fn() }));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));
vi.mock("../../api/lib/execution-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/execution-gate")>()),
  checkCompletionGate: gateMocks.checkCompletionGate,
  parkTaskForApproval: gateMocks.parkTaskForApproval,
}));
// §3-4 持久队列整体 mock：本文件断言的是「入队与否/几次/什么 outcome」，
// 真实队列执行语义由 finalize-actions.test.ts 覆盖。
vi.mock("../../api/lib/finalize-actions", () => ({
  enqueueTaskFinalize: finalizeMocks.enqueueTaskFinalize,
}));
vi.mock("../../api/lib/collaboration-events", () => ({
  emitCollabSummaryForTask: collabMocks.emitCollabSummaryForTask,
}));

import { reportTaskProgress } from "../../api/lib/task-writeback";
import { a2aRouter } from "../../api/a2a-router";
import { taskboardRouter } from "../../api/taskboard-router";
import { orchestrationRouter } from "../../api/orchestration-router";
import { getMcpServer, type McpToolContext } from "../../api/mcp/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createCallerFactory } from "../../api/middleware";

const createA2aCaller = createCallerFactory(a2aRouter);
const createBoardCaller = createCallerFactory(taskboardRouter);
const createOrchCaller = createCallerFactory(orchestrationRouter);

let testDb: TestDb;

async function seedAgent(): Promise<number> {
  const rows = await testDb.db
    .insert(schema.agents)
    .values({ agentId: `a-ts-${Math.random().toString(36).slice(2, 7)}`, name: "两段式测试 Agent", system: "openclaw", status: "online" })
    .returning({ id: schema.agents.id });
  return rows[0].id;
}

async function seedPricing(model = "test-model"): Promise<void> {
  // 统一价：input $0.001/1K，output $0.002/1K（external-writeback.test.ts 同口径）
  await testDb.db.insert(schema.modelPricing).values({ model, inputPrice: "0.001", outputPrice: "0.002", cachedInputPrice: "0.0001" });
}

async function seedTask(agentId: number, overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-TS-${Math.random().toString(36).slice(2, 7)}`,
      name: "外部执行任务",
      description: "desc",
      priority: 0,
      status: "running",
      lifecycleStatus: "working",
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

/** MCP 面调用器（update_task_status / report_progress 与 tRPC 共用同一事实源） */
async function callTool(name: string, args: Record<string, unknown>, ctx: McpToolContext) {
  const server = getMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "two-stage-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) as Record<string, any> };
  } finally {
    await client.close();
  }
}

beforeEach(() => {
  testDb = createTestDb();
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  for (const fn of Object.values(wsMocks)) fn.mockReset();
  gateMocks.checkCompletionGate.mockReset().mockReturnValue({ status: "allowed" });
  gateMocks.parkTaskForApproval.mockReset().mockResolvedValue(undefined as never);
  finalizeMocks.enqueueTaskFinalize.mockReset().mockResolvedValue({ enqueued: true } as never);
  collabMocks.emitCollabSummaryForTask.mockReset().mockResolvedValue(undefined as never);
});

afterEach(() => {
  testDb.dispose();
});

// ─── ① #198 形状：外部谎报 done 不再产生完成记录 ───
describe("t2-4 第一段：外部 done → submitted，不归档", () => {
  it("#198 形状（reportTaskProgress 谎报 done）→ lifecycle=submitted + usage 已记账 + 零 completed 归档", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);
    await seedPricing();

    const result = await reportTaskProgress(
      testDb.db as never,
      {
        id,
        progress: 100,
        status: "done",
        output: "已完成（谎报）",
        usage: { model: "test-model", promptTokens: 1_000_000, completionTokens: 1_000_000 },
      } as never,
      { apiKeyAgentId: -1 } as never
    );

    expect(result.success).toBe(true);
    const row = await taskRow(id);
    // 关键判别：lifecycle 是 submitted，不是 completed——完成记录的前置条件被拆掉了
    expect(row.lifecycleStatus).toBe("submitted");
    expect(row.completedAt).toBeNull();
    // 粗粒度 status=done 允许保留（看板兼容），但归档只认 lifecycle+验收
    expect(row.status).toBe("done");
    // usage 在此刻入账：花了的钱不等验收（决策注释见 task-writeback.ts）
    const usageRows = await testDb.db.select().from(schema.tokenUsage).where(eq(schema.tokenUsage.taskId, id));
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({ model: "test-model", provider: "external", source: "external" });
    // v5 验收判据主体：不再生成完成记录（无任何 completed finalize 入队）
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("MCP report_progress 谎报 done（connector 真实载荷形状）→ 同样只到 submitted、零归档", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);
    const boundCtx: McpToolContext = { apiKeyId: 9, agentId, permissions: [] };

    const { isError, payload } = await callTool(
      "report_progress",
      { id, progress: 100, status: "done", output: "done" },
      boundCtx
    );
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("submitted");
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("MCP update_task_status(done) 同理映射 submitted——否则 #198 形状换个工具照样绕过验收", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);
    const ctx: McpToolContext = { apiKeyId: 7, agentId, permissions: [] };

    const { payload } = await callTool("update_task_status", { taskId: id, status: "done", progress: 100, output: "ok" }, ctx);
    expect(payload.success).toBe(true);

    const row = await taskRow(id);
    expect(row.status).toBe("done");
    expect(row.lifecycleStatus).toBe("submitted");
    expect(row.completedAt).toBeNull();
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("orchestration.updateStatus(done) 同理映射 submitted（管理位通道也不旁路验收）", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);
    const adminCtx = { req: undefined, user: { id: 1, role: "admin" }, apiKeyAgentId: -1 } as never;

    const result = await createOrchCaller(adminCtx).updateStatus({ id, status: "done", progress: 100, output: "完成" });
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.status).toBe("done");
    expect(row.lifecycleStatus).toBe("submitted");
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("done 回写携带 artifacts → 照常落库（type=external_output），等验收时随归档带走", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);

    const result = await reportTaskProgress(
      testDb.db as never,
      {
        id,
        progress: 100,
        status: "done",
        artifacts: [{ name: "full-output.md", content: "# 报告正文", mimeType: "text/markdown" }],
      } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(result.success).toBe(true);

    const arts = await testDb.db.select().from(schema.taskArtifacts).where(eq(schema.taskArtifacts.taskId, id));
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ type: "external_output", name: "full-output.md" });
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("failed 回写照旧即时归档（outcome=failed），不受两段式影响", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);

    const result = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "failed", error: "boom" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(result.success).toBe(true);

    const failedEnqueues = finalizeMocks.enqueueTaskFinalize.mock.calls.filter(
      (c) => (c[1] as { outcome?: string }).outcome === "failed"
    );
    expect(failedEnqueues).toHaveLength(1);
    expect(completedEnqueues()).toHaveLength(0);
  });
});

// ─── ② 第二段：review approve → completed，归档恰好一次 ───
describe("t2-4 第二段：approve 通道负责 completed 归档（恰好一次）", () => {
  it("done→submitted 后 a2a.review(approved) → completed + completed 归档恰一次", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);

    // 第一段：外部谎报 done
    await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "done", output: "ok" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect((await taskRow(id)).lifecycleStatus).toBe("submitted");
    expect(completedEnqueues()).toHaveLength(0);

    // 第二段：验收方 approve（执行者本人 Key，低风险闸门放行——review 鉴权面由 c27138f 覆盖）
    const caller = createA2aCaller({
      req: new Request("http://localhost"),
      user: null,
      apiKeyAgentId: agentId,
      servicePrincipal: null,
    } as never);
    const review = await caller.review({ taskId: id, approved: true, note: "acceptance passed" });
    expect(review.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.status).toBe("done");
    expect(row.completedAt).not.toBeNull();
    // 归档责任从 writeback 移到 review 通道后：全程恰好一次，不多不少
    expect(completedEnqueues()).toHaveLength(1);
  });

  it("done→submitted 后 taskboard.approve（review 板态 + admin 登录用户）→ completed + 归档恰一次", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);

    await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "done" } as never,
      { apiKeyAgentId: -1 } as never
    );
    // 板态推进到 review（两段式的验收工作台形状），再走 approve
    const boardCtx = { req: new Request("http://localhost"), user: { id: 1, role: "admin" }, apiKeyAgentId: -1 } as never;
    const moved = await createBoardCaller(boardCtx).updateStatus({ taskId: id, agentId: 1, boardStatus: "review" });
    expect(moved.success).toBe(true);

    const approved = await createBoardCaller(boardCtx).approve({ taskId: id, agentId: 1, comment: "LGTM" });
    expect(approved.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("completed");
    expect(completedEnqueues()).toHaveLength(1);
  });
});

// ─── ③ 兼容通道：显式 lifecycleStatus 的行为矩阵 ───
describe("t2-4 兼容：显式 lifecycleStatus 回写的三段行为", () => {
  it("已集成方：working 态显式 completed → 先 hop submitted 再落 completed + 归档恰一次", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);

    const result = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "done", lifecycleStatus: "completed", output: "ok" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("completed");
    expect(row.completedAt).not.toBeNull();
    expect(completedEnqueues()).toHaveLength(1);
  });

  it("验收方确认：已在 submitted 时显式 completed → 放行 completed + 归档恰一次", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, { lifecycleStatus: "submitted" });

    const result = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "done", lifecycleStatus: "completed" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(result.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("completed");
    expect(completedEnqueues()).toHaveLength(1);
  });

  it("验收方确认：已在 reviewing 时显式 completed → 放行 + 归档恰一次", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, { lifecycleStatus: "reviewing" });

    const result = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "done", lifecycleStatus: "completed" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(result.success).toBe(true);
    expect((await taskRow(id)).lifecycleStatus).toBe("completed");
    expect(completedEnqueues()).toHaveLength(1);
  });

  it("中段提交：显式 lifecycleStatus=submitted → 落 submitted、零归档", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);

    const result = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, lifecycleStatus: "submitted" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(result.success).toBe(true);
    expect((await taskRow(id)).lifecycleStatus).toBe("submitted");
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("纯进度回写不动生命周期（progress-only 用例是绊马索：若把映射扩到无 status 的回写，此条变红）", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);

    const result = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 60, output: "半程汇报" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(result.success).toBe(true);
    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("working");
    expect(row.progress).toBe(60);
    expect(completedEnqueues()).toHaveLength(0);
  });
});

// ─── ④ 边界文档 + 内部 Runner 不变量 ───
describe("t2-4 边界与不变量", () => {
  it("created 态谎报 done → 合法 hop 落 submitted（非终态不可直达 completed 的状态机不变）", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, { status: "queued", lifecycleStatus: "created", boardStatus: "ready" });

    const result = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "done" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(result.success).toBe(true);
    expect((await taskRow(id)).lifecycleStatus).toBe("submitted");
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("done 之后重复 done 回写 → 终态不可变拒绝，不追加归档", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);

    const first = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "done" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(first.success).toBe(true);

    const second = await reportTaskProgress(
      testDb.db as never,
      { id, progress: 100, status: "done" } as never,
      { apiKeyAgentId: -1 } as never
    );
    expect(second.success).toBe(false);
    expect(String((second as { error?: string }).error)).toContain("Terminal");
    expect(completedEnqueues()).toHaveLength(0);
  });

  it("内部 Runner（task-runner）auto-review 仍自行 enqueue completed——t2-4 只动外部 writeback 路径（源码绊马索）", async () => {
    // 为何故意读源码而非跑 runner：内建自动化 Runner 不在 t2-4 语义范围（碧霄裁决），
    // 它的 submitted→completed→enqueue 组合流必须保持自带归档；若有人把归档责任
    // 错误地"统一"掉而没给 Runner 补新归档点，此条应变红。
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../api/lib/task-runner.ts", import.meta.url), "utf-8");
    expect(src).toContain('lifecycleStatus: "completed"');
    expect(src).toContain("enqueueTaskFinalize");
    // writeback 侧则必须不再对 done-only 入队 completed（反向判别在生产文件上）
    const wb = readFileSync(new URL("../../api/lib/task-writeback.ts", import.meta.url), "utf-8");
    expect(wb).toContain('"submitted"');
  });
});
