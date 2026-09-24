/**
 * Phase B §3-3：以单一 transition 服务维护一致投影与修订号。
 *
 * 两个**生产实测**到的缺陷（2026-09-23，线上库）：
 *   1. 取消一个 `dispatched` 任务后：`status='failed'`、`error='[cancelled] …'`，
 *      但同一行的 `lifecycle_status` 仍是 `'dispatched'`、`failed_at` 仍是空——同一行上
 *      两个维度互相矛盾，前端按哪个维度过滤都会看到不一致的战况。
 *   2. `tasks.state_revision` 全仓只有 `beidou-external-router` 与 `artifact-sealer`
 *      两处在递增，其余上百处写状态的地方都不递增。而 `task_outbox_events` 上有唯一索引
 *      `uq_task_outbox_task_revision(task_id, state_revision)`，且 `enqueueTaskOutboxEvent`
 *      插入时**没有冲突处理** ⇒ 任务状态变两次而修订号不变，第二次入队就会撞唯一索引直接抛错。
 *      修掉它不是为了"数字好看"，而是外部回调投递能不能成立的前提。
 *
 * 本文件先用**现有入口**（MCP cancel_task / 超时 sweeper）断言期望行为，因此失败发生在
 * 断言上而不是"模块不存在"。
 */
import { eq, and } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const mocks = vi.hoisted(() => ({
  syncTaskLessonToXuanji: vi.fn(),
  syncTaskArtifactsToAlist: vi.fn(),
  autoSummarizeCollab: vi.fn(),
}));

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/lib/xuanji-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/xuanji-sync")>()),
  syncTaskLessonToXuanji: mocks.syncTaskLessonToXuanji,
}));
vi.mock("../../api/lib/alist-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/alist-sync")>()),
  syncTaskArtifactsToAlist: mocks.syncTaskArtifactsToAlist,
}));
vi.mock("../../api/lib/task-validator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/task-validator")>()),
  autoSummarizeCollab: mocks.autoSummarizeCollab,
}));

import { getMcpServer, type McpToolContext } from "../../api/mcp/server";
import { sweepTaskTimeouts } from "../../api/lib/sweepers/task-lifecycle";
import { applyTaskTransition } from "../../api/lib/task-transition";

const CTX: McpToolContext = { apiKeyId: 3, agentId: null, permissions: [] };
const NOW = new Date("2026-09-23T02:00:00Z");

let testDb: TestDb;

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const server = getMcpServer(CTX);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "task-transition-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

async function seedAgent(): Promise<number> {
  const rows = await testDb.db
    .insert(schema.agents)
    .values({ agentId: "a-transition", name: "转移测试 Agent", system: "openclaw", status: "online" })
    .returning({ id: schema.agents.id });
  return rows[0].id;
}

async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const inserted = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: "T-TRANS-1",
      name: "转移测试任务",
      description: "desc",
      status: "queued",
      priority: 0,
      ...overrides,
    })
    .returning({ id: schema.tasks.id });
  return inserted[0].id;
}

async function taskRow(id: number) {
  const rows = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return rows[0];
}

beforeEach(() => {
  testDb = createTestDb();
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  mocks.syncTaskLessonToXuanji.mockReset().mockResolvedValue({ ok: true });
  mocks.syncTaskArtifactsToAlist.mockReset().mockResolvedValue(undefined);
  mocks.autoSummarizeCollab.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  testDb.dispose();
});

describe("§3-3 一致投影：取消", () => {
  it("取消 dispatched 任务后，status 与 lifecycleStatus/failedAt 必须一致，并递增修订号", async () => {
    const agentId = await seedAgent();
    const id = await seedTask({
      taskId: "T-TRANS-CANCEL",
      status: "running",
      lifecycleStatus: "dispatched",
      agentId,
    });
    expect((await taskRow(id)).stateRevision).toBe(1);

    const { payload } = await callTool("cancel_task", { taskId: id, reason: "上游撤回" });
    expect(payload.success).toBe(true);

    const row = await taskRow(id);
    // 保留语义：粗粒度 status 仍是 failed，error 仍带 [cancelled] 前缀
    expect(row.status).toBe("failed");
    expect(row.error).toBe("[cancelled] 上游撤回");
    // 期望的一致投影（当前测试应为 RED：lifecycleStatus 原样停在 dispatched、failedAt 为空）
    expect(row.lifecycleStatus).toBe("cancelled");
    expect(row.failedAt).toEqual(expect.any(Date));
    // 修订号必须递增：否则外部回调的第二条事件会撞 (task_id, state_revision) 唯一索引
    expect(row.stateRevision).toBe(2);
  });

  it("终态任务被再次取消：拒绝且一个维度都不写、修订号不动", async () => {
    const id = await seedTask({ taskId: "T-TRANS-DONE", status: "done", lifecycleStatus: "completed" });
    const before = await taskRow(id);

    const { payload } = await callTool("cancel_task", { taskId: id, reason: "重复取消" });
    expect(payload.success).toBe(false);

    const after = await taskRow(id);
    expect(after.status).toBe(before.status);
    expect(after.lifecycleStatus).toBe(before.lifecycleStatus);
    expect(after.stateRevision).toBe(before.stateRevision);
  });
});

describe("§3-3 一致投影：超时终态", () => {
  it("超时落终态时投影一致且递增修订号", async () => {
    const agentId = await seedAgent();
    const id = await seedTask({
      taskId: "T-TRANS-TIMEOUT",
      status: "running",
      lifecycleStatus: "working",
      agentId,
      claimedAt: new Date(NOW.getTime() - 3_600_000),
      workerLeaseExpiresAt: new Date(NOW.getTime() - 60_000),
      timeoutMs: 300_000,
      retryCount: 3,
      maxRetries: 3,
      workerLeaseToken: "lease-z",
    });

    await sweepTaskTimeouts(testDb.db as never, NOW);

    const row = await taskRow(id);
    expect(row.status).toBe("failed");
    expect(row.lifecycleStatus).toBe("failed");
    expect(row.failedAt).toEqual(NOW);
    expect(row.stateRevision).toBe(2);
  });
});

describe("§3-3 修订号与外部回调投递", () => {
  it("同一任务连续两次状态转移后，两个修订号各能入队一条 outbox 事件（不撞唯一索引）", async () => {
    const id = await seedTask({ taskId: "T-TRANS-REV", status: "running", lifecycleStatus: "working" });

    const first = await applyTaskTransition(testDb.db, { taskId: id, lifecycleStatus: "submitted", at: NOW });
    expect(first.ok).toBe(true);
    const second = await applyTaskTransition(testDb.db, { taskId: id, lifecycleStatus: "failed", at: NOW, reason: "复核失败" });
    expect(second.ok).toBe(true);

    const revs = [first, second].map((r) => (r.ok ? r.revision : NaN));
    expect(revs[0]).not.toBe(revs[1]);

    // 用真实修订号各写一条 outbox 行：唯一索引 (task_id, state_revision) 必须都放行
    for (const [i, revision] of revs.entries()) {
      await testDb.db.insert(schema.taskOutboxEvents).values({
        eventId: `evt-${i}`,
        taskId: id,
        taskPublicId: "T-TRANS-REV",
        externalRef: "T-TRANS-REV",
        workspaceSlug: "ws",
        projectSlug: "proj",
        traceId: `task:T-TRANS-REV:${revision}`,
        originSystem: "openclaw",
        eventType: "state",
        status: "running",
        lifecycleStatus: "working",
        stateRevision: revision,
        keyId: "k1",
        attempts: 0,
        nextAttemptAt: NOW,
        payloadDigest: `digest-${i}`,
      });
    }
    const rows = await testDb.db
      .select({ revision: schema.taskOutboxEvents.stateRevision })
      .from(schema.taskOutboxEvents)
      .where(eq(schema.taskOutboxEvents.taskId, id));
    expect(rows.map((r) => r.revision).sort()).toEqual([...revs].sort((a, b) => a - b));
  });

  it("同一修订号重复入队会被唯一索引挡住（证明上面那条测试不是空转）", async () => {
    const id = await seedTask({ taskId: "T-TRANS-DUP", status: "running", lifecycleStatus: "working" });
    const same = {
      eventId: "evt-dup",
      taskId: id,
      taskPublicId: "T-TRANS-DUP",
      externalRef: "T-TRANS-DUP",
      workspaceSlug: "ws",
      projectSlug: "proj",
      traceId: "task:T-TRANS-DUP:1",
      originSystem: "openclaw",
      eventType: "state" as const,
      status: "running",
      lifecycleStatus: "working",
      stateRevision: 1,
      keyId: "k1",
      attempts: 0,
      nextAttemptAt: NOW,
      payloadDigest: "digest-dup",
    };
    await testDb.db.insert(schema.taskOutboxEvents).values(same);
    await expect(
      testDb.db.insert(schema.taskOutboxEvents).values({ ...same, eventId: "evt-dup-2" }),
    ).rejects.toThrow();
  });
});

describe("§3-3 transition 服务契约", () => {
  it("非法转移被拒绝：不写任何维度、不递增修订号", async () => {
    const id = await seedTask({ taskId: "T-TRANS-BAD", status: "done", lifecycleStatus: "completed" });
    const before = await taskRow(id);

    const result = await applyTaskTransition(testDb.db, { taskId: id, lifecycleStatus: "working", at: NOW });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_transition");

    const after = await taskRow(id);
    expect(after.lifecycleStatus).toBe(before.lifecycleStatus);
    expect(after.stateRevision).toBe(before.stateRevision);
  });

  it("乐观并发：expectedRevision 不匹配时拒绝且不写", async () => {
    const id = await seedTask({ taskId: "T-TRANS-CAS", status: "running", lifecycleStatus: "working" });
    const before = await taskRow(id);

    const result = await applyTaskTransition(testDb.db, {
      taskId: id,
      lifecycleStatus: "submitted",
      at: NOW,
      expectedRevision: 99,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revision_conflict");

    const after = await taskRow(id);
    expect(after.lifecycleStatus).toBe(before.lifecycleStatus);
    expect(after.stateRevision).toBe(before.stateRevision);
  });

  it("终态由 lifecycleStatus 推导粗粒度 status，并盖上对应时间戳", async () => {
    const failing = await seedTask({ taskId: "T-TRANS-F", status: "running", lifecycleStatus: "working" });
    const failingResult = await applyTaskTransition(testDb.db, { taskId: failing, lifecycleStatus: "failed", at: NOW });
    expect(failingResult.ok).toBe(true);
    const failedRow = await taskRow(failing);
    expect(failedRow.status).toBe("failed");
    expect(failedRow.failedAt).toEqual(NOW);
    expect(failedRow.completedAt).toBeNull();

    const done = await seedTask({ taskId: "T-TRANS-D", status: "running", lifecycleStatus: "submitted" });
    await applyTaskTransition(testDb.db, { taskId: done, lifecycleStatus: "completed", at: NOW });
    const doneRow = await taskRow(done);
    expect(doneRow.status).toBe("done");
    expect(doneRow.completedAt).toEqual(NOW);
    expect(doneRow.failedAt).toBeNull();
  });

  it("非终态转移不动 status，也不盖终态时间戳", async () => {
    const id = await seedTask({ taskId: "T-TRANS-MID", status: "running", lifecycleStatus: "working" });
    const result = await applyTaskTransition(testDb.db, { taskId: id, lifecycleStatus: "submitted", at: NOW });
    expect(result.ok).toBe(true);

    const row = await taskRow(id);
    expect(row.status).toBe("running");
    expect(row.failedAt).toBeNull();
    expect(row.completedAt).toBeNull();
    expect(row.lifecycleStatus).toBe("submitted");
  });

  it("boardStatus 与 lifecycleStatus 可以一次写入，两者各自独立取值", async () => {
    const id = await seedTask({ taskId: "T-TRANS-BOARD", status: "running", lifecycleStatus: "submitted" });
    const result = await applyTaskTransition(testDb.db, {
      taskId: id,
      lifecycleStatus: "failed",
      boardStatus: "failed",
      at: NOW,
      reason: "人工驳回",
    });
    expect(result.ok).toBe(true);

    const row = await taskRow(id);
    expect(row.lifecycleStatus).toBe("failed");
    expect(row.boardStatus).toBe("failed");
    expect(row.status).toBe("failed");
  });

  it("显式 lease 清理开关：终态转移可按需清掉执行租约", async () => {
    const id = await seedTask({
      taskId: "T-TRANS-LEASE",
      status: "running",
      lifecycleStatus: "working",
      workerLeaseToken: "lease-x",
      workerLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
    });

    await applyTaskTransition(testDb.db, { taskId: id, lifecycleStatus: "failed", at: NOW, clearLease: true });

    const row = await taskRow(id);
    await testDb.db.select().from(schema.tasks).where(and(eq(schema.tasks.id, id)));
    expect(row.workerLeaseToken).toBeNull();
    expect(row.workerLeaseExpiresAt).toBeNull();
  });
});
