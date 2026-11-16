/**
 * p2.5-b：cancel_task 同步 lifecycle + 审计事件留痕。
 *
 * 读码结论（动手前逐行核实）：MCP cancel_task 自 Phase B §3-3 起**已经**走
 * applyTaskTransition({ lifecycleStatus: "cancelled" })——transition 服务从 cancelled
 * 推导粗粒度 status=failed、盖 failedAt、递增 stateRevision，双列同步本体在位；
 * running 的取消语义沿用既有流程（转移即时落终态 + clearLease 清租约；内建 Runner 的
 * pending-cancel 确认流在 task-runner.ts cancellation.aborted 分支，外部 Key 面不另造）。
 * **真正缺的是 audit_events 留痕**：同文件 register_agent / guard 写操作都直插
 * audit_events（hash 链），唯独 cancel_task 这个受控写只有 task_messages 级回执、
 * 平台审计账本无痕——本票补上，并用测试把「双列同步 + 审计有痕 + 终态后 review 拒绝」
 * 三条钉死。
 *
 * 审计写法口径（为何直插而非 writeAuditEvent 单例）：audit-log 模块级单例的
 * fire-and-forget 队列跨测试实例泄漏且无 flush 出口（AGENTS.md「钩子复制漂移」教训
 * 的另一面）；本仓 MCP 面的审计先例（register_agent :1907 区、guard_add_allowlist）
 * 就是 await 直插 + 自算 hash 链，与 sweeper 经 writeAuditEvent 落的行完全同构
 * （字段/链式哈希一致），list_recent_events 一视同仁可读。actorUserId 用 -agentId
 * 负数编码（agent 非 user 表实体），与 mcp.createKey 审计 actorUserId=0 哨兵可区分。
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
// 入队断言口径与 two-stage-writeback.test.ts 一致：只钉 outcome，队列执行语义归 finalize-actions.test.ts
vi.mock("../../api/lib/finalize-actions", () => ({
  enqueueTaskFinalize: finalizeMocks.enqueueTaskFinalize,
}));

import { getMcpServer, type McpToolContext } from "../../api/mcp/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

let testDb: TestDb;

async function seedAgent(): Promise<number> {
  const rows = await testDb.db
    .insert(schema.agents)
    .values({
      agentId: `a-p25b-${Math.random().toString(36).slice(2, 8)}`,
      name: "p2.5-b 测试 Agent",
      system: "openclaw",
      status: "online",
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
      taskId: `T-P25B-${Math.random().toString(36).slice(2, 7)}`,
      name: "p2.5-b 取消任务",
      description: "desc",
      priority: 0,
      status: "queued",
      lifecycleStatus: "queued",
      boardStatus: "ready",
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

async function callTool(name: string, args: Record<string, unknown>, ctx: McpToolContext) {
  const server = getMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "p25b-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { rawText: text };
    }
    return { isError: result.isError === true, payload };
  } finally {
    await client.close();
  }
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

describe("p2.5-b cancel_task：双列同步 + 审计留痕 + 终态封 review", () => {
  it("cancel queued 单 → status=failed 且 lifecycle_status=cancelled（双列同步）+ failedAt + 修订号递增", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);
    const before = await taskRow(id);

    const { isError, payload } = await callTool(
      "cancel_task",
      { taskId: id, reason: "需求撤回" },
      { apiKeyId: 9, agentId, permissions: [] }
    );
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);

    const row = await taskRow(id);
    // 票面主判据：两个维度必须一致投影——绝不允许 status=failed 而 lifecycle 停在 queued
    expect(row.status).toBe("failed");
    expect(row.lifecycleStatus).toBe("cancelled");
    expect(row.error).toContain("[cancelled] 需求撤回");
    expect(row.failedAt).not.toBeNull();
    expect(row.stateRevision).toBe(before.stateRevision + 1);
    // 失败族终态即时归档照常（outcome=failed，通道标 mcp.cancel）
    const failedEnqueues = finalizeMocks.enqueueTaskFinalize.mock.calls.filter(
      (c) => (c[1] as { outcome?: string }).outcome === "failed"
    );
    expect(failedEnqueues).toHaveLength(1);
  });

  it("cancel queued 单 → audit_events 有痕（event=task:cancelled，entityId/metadata 指向该单，actor 为绑定 agent 负数编码）", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);
    const publicTaskId = (await taskRow(id)).taskId;

    await callTool("cancel_task", { taskId: id, reason: "运维清账" }, { apiKeyId: 9, agentId, permissions: [] });

    const audits = await testDb.db.select().from(schema.auditEvents);
    const cancelAudit = audits.find((a) => a.event === "task:cancelled");
    expect(cancelAudit).toBeTruthy();
    expect(cancelAudit!.entityType).toBe("task");
    expect(cancelAudit!.entityId).toBe(id);
    const meta = JSON.parse(String(cancelAudit!.metadata));
    expect(meta).toMatchObject({ taskId: publicTaskId, channel: "mcp.cancel", reason: "运维清账" });
    expect(cancelAudit!.actorUserId).toBe(-agentId);
    // hash 链完整性：新行必须带链哈希（与 writeAuditEvent 落的行同构，永不可改的前提）
    expect(typeof cancelAudit!.hash).toBe("string");
    expect(String(cancelAudit!.hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("连续两笔审计写入成链（第二行 prev_hash = 第一行 hash）", async () => {
    const agentId = await seedAgent();
    const idA = await seedTask(agentId);
    const idB = await seedTask(agentId);

    await callTool("cancel_task", { taskId: idA }, { apiKeyId: 9, agentId, permissions: [] });
    await callTool("cancel_task", { taskId: idB }, { apiKeyId: 9, agentId, permissions: [] });

    const audits = await testDb.db
      .select()
      .from(schema.auditEvents)
      .orderBy(schema.auditEvents.id);
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const last = audits[audits.length - 1]!;
    const prev = audits[audits.length - 2]!;
    expect(last.prevHash).toBe(prev.hash);
  });

  it("env-only Key（agentId=null）取消同样留痕，actorUserId=0 管理位哨兵", async () => {
    const id = await seedTask(null);

    const { payload } = await callTool("cancel_task", { taskId: id, reason: "管理清账" }, { apiKeyId: 3, agentId: null, permissions: [] });
    expect(payload.success).toBe(true);

    const audits = await testDb.db.select().from(schema.auditEvents);
    const cancelAudit = audits.find((a) => a.event === "task:cancelled");
    expect(cancelAudit).toBeTruthy();
    expect(cancelAudit!.actorUserId).toBe(0);
  });

  it("终态后 review_task 拒绝该单（cancelled 不可逆，前置检查文案含 status cancelled）", async () => {
    const executor = await seedAgent();
    const reviewer = await seedAgent();
    const id = await seedTask(executor, {
      status: "running",
      lifecycleStatus: "submitted",
      boardStatus: "running",
      reviewerId: reviewer,
    });

    const cancel = await callTool("cancel_task", { taskId: id, reason: "交付作废" }, { apiKeyId: 9, agentId: executor, permissions: [] });
    expect(cancel.payload.success).toBe(true);
    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("cancelled");
    expect(row.status).toBe("failed");

    const review = await callTool("review_task", { taskId: id, approved: true }, { apiKeyId: 9, agentId: reviewer, permissions: [] });
    expect(review.isError).toBe(true);
    expect(String(review.payload.error)).toContain("Cannot review task from status cancelled");
    // 被拒的 review 不得复活终态、不得触发 completed 归档
    expect((await taskRow(id)).lifecycleStatus).toBe("cancelled");
    const completedEnqueues = finalizeMocks.enqueueTaskFinalize.mock.calls.filter(
      (c) => (c[1] as { outcome?: string }).outcome === "completed"
    );
    expect(completedEnqueues).toHaveLength(0);
  });

  it("重复 cancel 已取消的单 → 拒绝且审计不追加（终态守卫在前，留痕只在真实转移后）", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId);

    const first = await callTool("cancel_task", { taskId: id, reason: "第一次" }, { apiKeyId: 9, agentId, permissions: [] });
    expect(first.payload.success).toBe(true);
    const second = await callTool("cancel_task", { taskId: id, reason: "第二次" }, { apiKeyId: 9, agentId, permissions: [] });
    expect(second.payload.success).toBe(false);
    expect(String(second.payload.error)).toContain("无法取消");

    const audits = await testDb.db.select().from(schema.auditEvents);
    expect(audits.filter((a) => a.event === "task:cancelled")).toHaveLength(1);
  });

  it("running 单取消：走同一转移即时落 cancelled+failed 并清租约（不自创 pending-cancel 流程）", async () => {
    const agentId = await seedAgent();
    const id = await seedTask(agentId, {
      status: "running",
      lifecycleStatus: "working",
      boardStatus: "running",
      workerLeaseToken: "lease-p25b",
      claimedAt: new Date(),
    });

    const { payload } = await callTool("cancel_task", { taskId: id, reason: "外部终止" }, { apiKeyId: 9, agentId, permissions: [] });
    expect(payload.success).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("cancelled");
    expect(row.status).toBe("failed");
    // clearLease 三件套（存量行为回归：租约随取消清空，防陈旧 worker 继续推进）
    expect(row.workerLeaseToken).toBeNull();
    expect(row.claimedAt).toBeNull();
  });
});
