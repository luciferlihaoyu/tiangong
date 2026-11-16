/**
 * t2-5：重试清扫器（task-retry sweeper）两条判据
 *
 * ① 公平排队：候选查询必须 `ORDER BY failed_at ASC`（最旧先处理）。
 *    旧形状无 orderBy + limit(50)：当失败任务超过一窗时，SQLite 按插入序返回，
 *    「最新一条失败」永远排在窗口外被饿死。v5 验收判据：「51 条失败时最新一条
 *    仍被处理」。选 asc 的理由（钉在此处）：最旧先处理 = FIFO 公平排队，退避
 *    计时从 failedAt 起算、最旧的必然最先满足退避窗口，与线性退避语义天然一致；
 *    desc「最新优先」反而让持续涌入的新失败饿死存量旧失败。
 *    ⚠️ 假 DB 桩的 orderBy() 是空操作（AGENTS.md 2026-11-16 教训），本用例走
 *    **真实 SQLite**；且 FakeDb 同形化风险由下方 SQL 形状断言双保险——生产把
 *    orderBy 摘掉，SQL 文本断言即变红。
 *
 * ② 结构性失败不再原样重派：retryCount 达 maxRetries 的任务确保落终态——
 *    sweeper 不重派（既有 continue 闸，保留并钉住）；MCP update_task_status 与
 *    orchestration.updateStatus 的 failed→queued 重派通道同样被 maxRetries 闸
 *    封死（t2-5 修正这两处注释的「现网不可达」事实断言：statusTransitions 只查
 *    粗粒度 status，lifecycle=failed 的行确实会落进该分支）。
 */
import { eq, inArray } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn(), broadcastToTask: vi.fn(), sendToAgent: vi.fn() }));
const collabMocks = vi.hoisted(() => ({ emitCollabSummaryForTask: vi.fn() }));
const finalizeMocks = vi.hoisted(() => ({ enqueueTaskFinalize: vi.fn() }));
const notifyMocks = vi.hoisted(() => ({ notifyAgentMailbox: vi.fn(), emitSweeperAudit: vi.fn() }));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));
vi.mock("../../api/lib/collaboration-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/collaboration-events")>()),
  emitCollabSummaryForTask: collabMocks.emitCollabSummaryForTask,
}));
vi.mock("../../api/lib/finalize-actions", () => ({
  enqueueTaskFinalize: finalizeMocks.enqueueTaskFinalize,
}));
// sweeper 的通知出口整体 mock：本文件测的是排队与重派闸门，不是邮件投递
vi.mock("../../api/lib/sweepers/notify", () => ({
  notifyAgentMailbox: notifyMocks.notifyAgentMailbox,
  emitSweeperAudit: notifyMocks.emitSweeperAudit,
}));

import { sweepTaskRetry } from "../../api/lib/sweepers/task-retry";
import { orchestrationRouter } from "../../api/orchestration-router";
import { getMcpServer, type McpToolContext } from "../../api/mcp/server";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createCallerFactory } from "../../api/middleware";

const createOrchCaller = createCallerFactory(orchestrationRouter);

let testDb: TestDb;
const NOW = new Date("2026-11-20T12:00:00Z");
/** 退避窗口之外（默认 base 5min × (retryCount+1)，最保守也 > 1h） */
const BACKOFF_PAST = new Date(NOW.getTime() - 3600_000);

async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-T5-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "重试清扫测试任务",
      description: "desc",
      priority: 0,
      status: "failed",
      lifecycleStatus: "failed",
      boardStatus: "failed",
      error: "boom",
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
  const client = new Client({ name: "t25-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return JSON.parse(text) as Record<string, any>;
  } finally {
    await client.close();
  }
}

beforeEach(() => {
  testDb = createTestDb();
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  for (const fn of Object.values(wsMocks)) fn.mockReset();
  for (const fn of Object.values(notifyMocks)) fn.mockReset();
  notifyMocks.notifyAgentMailbox.mockResolvedValue(undefined as never);
  finalizeMocks.enqueueTaskFinalize.mockReset().mockResolvedValue({ enqueued: true } as never);
  collabMocks.emitCollabSummaryForTask.mockReset().mockResolvedValue(undefined as never);
});

afterEach(() => {
  testDb.dispose();
});

// ─── ① 公平排队：orderBy(failed_at ASC) ───
describe("t2-5 第一段：候选按 failedAt 升序排队", () => {
  it("行为级判别（主证据）：51 条失败单轮 limit=50 → asc 处理最旧 50 条，最新一条本轮不动", async () => {
    // 判别机制：假 DB 桩的 orderBy() 是空操作（AGENTS.md 2026-11-16 教训），故本用例走
    // **真实 SQLite**。插入序与 failedAt 序**反向**：最先插入的行 failedAt 最晚——
    // 无 orderBy（rowid 序）或 desc 都会把"最新失败"排进本轮窗口；只有 asc(failedAt)
    // 让最旧的 50 条先重派、failedAt 最大的一条留在窗外。变异实验已双向验红/验绿。
    const ids: number[] = [];
    for (let i = 0; i < 51; i++) {
      // i=0 最先插入但 failedAt 最晚；i=50 最后插入但 failedAt 最早
      ids.push(await seedTask({ failedAt: new Date(BACKOFF_PAST.getTime() + (50 - i) * 1000) }));
    }
    await sweepTaskRetry(testDb.db as never, NOW);
    const rows = await testDb.db.select().from(schema.tasks).where(inArray(schema.tasks.id, ids));
    const queued = rows.filter((r) => r.status === "queued");
    expect(queued).toHaveLength(50);
    // asc 语义钉死：failedAt 最大（最新失败，即最先插入的 ids[0]）排在窗口外，本轮不处理
    const latest = rows.find((r) => r.id === ids[0]);
    expect(latest?.status).toBe("failed");
    // failedAt 最小（最旧失败，最后插入的 ids[50]）必然在本轮窗口内
    const oldest = rows.find((r) => r.id === ids[50]);
    expect(oldest?.status).toBe("queued");
  });

  it("v5 判据「51 条失败时最新一条仍被处理」：第二轮清扫必轮到最新一条，不被永久饿死", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 51; i++) {
      ids.push(await seedTask({ failedAt: new Date(BACKOFF_PAST.getTime() + (50 - i) * 1000) }));
    }
    await sweepTaskRetry(testDb.db as never, NOW);
    await sweepTaskRetry(testDb.db as never, NOW);
    const rows = await testDb.db.select().from(schema.tasks).where(inArray(schema.tasks.id, ids));
    const stillFailed = rows.filter((r) => r.status === "failed");
    // 两轮（各 50 条窗口）覆盖全部 51 条：没有任何一条被窗口永久挤占
    expect(stillFailed).toHaveLength(0);
    const retriedLatest = rows.find((r) => r.id === ids[0]);
    expect(retriedLatest?.status).toBe("queued");
    expect(retriedLatest?.retryCount).toBe(1);
  });

  it("未过退避窗口的失败不重派（内存判定维持，注释记录现状）", async () => {
    // 如实记录：退避判定仍在内存做（now - failedAt < backoffMs 即跳过），本轮不动它；
    // 排序修复保证的是「谁先进窗口」，退避语义由本用例钉住不回退。
    const fresh = await seedTask({ failedAt: NOW });
    await sweepTaskRetry(testDb.db as never, NOW);
    expect((await taskRow(fresh)).status).toBe("failed");
  });
});

// ─── ② 结构性失败落终态：maxRetries 闸全覆盖 ───
describe("t2-5 第二段：retryCount 耗尽后重派通道全部关闭", () => {
  it("sweeper：retryCount >= maxRetries → 不重派、保持 failed 终态", async () => {
    const id = await seedTask({ failedAt: BACKOFF_PAST, retryCount: 3, maxRetries: 3 });
    await sweepTaskRetry(testDb.db as never, NOW);
    const row = await taskRow(id);
    expect(row.status).toBe("failed");
    expect(row.lifecycleStatus).toBe("failed");
    expect(row.retryCount).toBe(3);
  });

  it("MCP update_task_status(failed→queued)：retryCount 耗尽 → 拒绝且零写入（t2-5 修正「现网不可达」注释）", async () => {
    const id = await seedTask({ failedAt: BACKOFF_PAST, retryCount: 3, maxRetries: 3 });
    const ctx: McpToolContext = { apiKeyId: 7, agentId: null, permissions: ["admin"] };

    const payload = await callTool("update_task_status", { taskId: id, status: "queued" }, ctx);
    expect(payload.success).toBe(false);
    expect(String(payload.error)).toContain("已达最大重试次数");

    const row = await taskRow(id);
    expect(row.status).toBe("failed");
    expect(row.stateRevision).toBe(1); // 闸在转移之前：耗尽即零写入
  });

  it("MCP update_task_status(failed→queued)：还有重试次数 → 正常重派且计数递增（闸不误伤）", async () => {
    const id = await seedTask({ failedAt: BACKOFF_PAST, retryCount: 1, maxRetries: 3 });
    const ctx: McpToolContext = { apiKeyId: 7, agentId: null, permissions: ["admin"] };

    const payload = await callTool("update_task_status", { taskId: id, status: "queued" }, ctx);
    expect(payload.success).toBe(true);
    expect(payload.retryCount).toBe(2);

    const row = await taskRow(id);
    expect(row.status).toBe("queued");
    expect(row.retryCount).toBe(2);
  });

  it("orchestration.updateStatus(failed→queued)：retryCount 耗尽 → 拒绝且零写入", async () => {
    const id = await seedTask({ failedAt: BACKOFF_PAST, retryCount: 3, maxRetries: 3 });
    const adminCtx = { req: undefined, user: { id: 1, role: "admin" }, apiKeyAgentId: -1 } as never;

    const result = await createOrchCaller(adminCtx).updateStatus({ id, status: "queued" });
    expect(result.success).toBe(false);
    expect(String((result as { error?: string }).error)).toContain("已达最大重试次数");

    const row = await taskRow(id);
    expect(row.status).toBe("failed");
    expect(row.stateRevision).toBe(1);
  });

  it("taskboard.retry（手动一键重试）：耗尽同样拒绝（既有闸回归钉住）", async () => {
    const id = await seedTask({ failedAt: BACKOFF_PAST, retryCount: 3, maxRetries: 3 });
    const { taskboardRouter } = await import("../../api/taskboard-router");
    const caller = createCallerFactory(taskboardRouter)({
      req: new Request("http://localhost"),
      user: { id: 1, role: "admin" },
      apiKeyAgentId: -1,
    } as never);
    await expect(caller.retry({ taskId: id, agentId: 1 })).rejects.toThrow(/已达最大重试次数/);
    expect((await taskRow(id)).status).toBe("failed");
  });
});

// ── F6（2026-11-16 生产实证，任务 #210）───────────────────────────────────────
// 事实（已逐条开码核对，api/mcp/server.ts:1431-1446）：`cancel_task` 走单一转移服务，
// 如实写齐 `lifecycle_status='cancelled'` + `status='failed'`（后者由前者推导）+ error `[cancelled] …`。
// 缺陷在清扫器这一侧：候选按 `status='failed'` 捞，而防复活闸**只读 boardStatus**——
// 任务板取消能挡住，MCP 取消挡不住，于是**取消动作被清扫器原样撤销**。
// 生产序列（#210 线程实测）：02:32:36 建单 → 02:33:08 cancel_task 即销 →
// 02:38:37 被复活成 queued（`auto_retry 第 1/3 次`）→ 因 agent_id IS NULL 会被内建 Runner
// 以 503 打死再 failed，直到 3 次预算耗尽；期间"1 个非终态任务 agent_id 为 NULL"的哨兵告警长期挂着。
// 修法只加一条状态列判据 `lifecycleStatus === 'cancelled'`；**不**去解析 error 文案——
// 字符串前缀不是事实源，状态列才是（解析它等于把同一个缺陷换个地方再种一遍）。
describe("F6：已取消的任务不得被重试清扫器复活", () => {
  it("lifecycle_status=cancelled 而 board_status 未同步（#210 的真实形状）→ 不重派", async () => {
    const id = await seedTask({
      failedAt: BACKOFF_PAST,
      retryCount: 0,
      maxRetries: 3,
      lifecycleStatus: "cancelled",
      boardStatus: "triage",
      error: "[cancelled] 幂等验证完成，按纪律即建即销",
    });
    const before = await taskRow(id);
    await sweepTaskRetry(testDb.db as never, NOW);
    const row = await taskRow(id);
    expect(row.status).toBe("failed");
    expect(row.lifecycleStatus).toBe("cancelled");
    expect(row.retryCount).toBe(0);
    // 零写入证据：状态版本没被推进，说明压根没走 applyTaskTransition
    expect(row.stateRevision).toBe(before.stateRevision);
  });

  it("既有闸不得被写宽：board_status=cancelled 仍不重派（防只改 lifecycle 把老保护顶掉）", async () => {
    const id = await seedTask({ failedAt: BACKOFF_PAST, boardStatus: "cancelled", lifecycleStatus: "failed" });
    await sweepTaskRetry(testDb.db as never, NOW);
    const row = await taskRow(id);
    expect(row.status).toBe("failed");
    expect(row.retryCount).toBe(0);
  });

  it("反面必须守住：lifecycle_status=failed 的普通失败仍要正常重派（闸不能误伤真重试）", async () => {
    const id = await seedTask({ failedAt: BACKOFF_PAST, lifecycleStatus: "failed", boardStatus: "failed" });
    await sweepTaskRetry(testDb.db as never, NOW);
    const row = await taskRow(id);
    expect(row.status).toBe("queued");
    expect(row.retryCount).toBe(1);
  });
});
