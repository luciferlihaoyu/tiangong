/**
 * Phase B §3-2：失败/取消/超时的终态动作统一。
 *
 * 原状况（三处各写各的）：
 *   - `finalizeFailedTask`（统一入口）= 璇玑教训 + AList 产物 + 协作父任务汇总；
 *   - 超时 sweeper = 璇玑教训 + 通知，**漏了产物归档与父任务汇总**；
 *   - MCP `cancel_task` = 只把 tasks.status 写成 failed，**什么归档都不做**。
 * 后果不是"少写日志"，而是**功能缺口**：被取消/超时的协作子任务永远不会触发父任务汇总
 * （要等其它兄弟任务完成才发生），取消任务的教训也不进记忆、检索不到。
 *
 * 本测试用**真实 SQLite** 建任务行，只桩掉外部接收端（璇玑/AList/父任务汇总），
 * 因此断言的是"终态动作到底有没有发生"，而不是某个 mock 被调过。
 * 同时锁住**保留语义**：取消仍是 failed + `[cancelled]` 前缀；超时仍写
 * failed/lifecycleStatus/failedAt 并清租约；"还有重试次数 → 重新排队"这条路
 * **绝不能**触发任何归档（重排不是终态）。
 */
import { eq } from "drizzle-orm";
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

const CTX: McpToolContext = { apiKeyId: 3, agentId: null, permissions: [] };
const NOW = new Date("2026-09-23T02:00:00Z");

let testDb: TestDb;

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; payload: Record<string, unknown> }> {
  const server = getMcpServer(CTX);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "terminal-unification-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) as Record<string, unknown> };
  } finally {
    await client.close();
  }
}

/** 造一条任务行；running 的用过期租约模拟"卡住被扫到"。 */
async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const inserted = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: "T-TERM-1",
      name: "终态统一测试任务",
      description: "desc",
      status: "queued",
      priority: 0,
      agentId: null,
      ...overrides,
    })
    .returning({ id: schema.tasks.id });
  return inserted[0].id;
}

/**
 * 造一个真实 agent 行。**为什么需要**：测试库显式 `PRAGMA foreign_keys = ON`，
 * 而**应用运行时的连接没有开 FK**（SQLite 每连接生效，只有 auto-migrate 的连接开了）。
 * 于是 notifications.agent_id 里那个"无执行代理归 0"的哨兵值：生产能写进去（孤儿行），
 * 测试库会直接 FK 报错。这是测试桩比生产更严的已知差异——本测试按更严的一侧造数据，
 * 不去改生产行为（见 task-finalize.ts 里的说明）。
 */
async function seedAgent(): Promise<number> {
  const rows = await testDb.db
    .insert(schema.agents)
    .values({ agentId: "a-terminal", name: "终态测试 Agent", system: "openclaw", status: "online" })
    .returning({ id: schema.agents.id });
  return rows[0].id;
}

async function taskRow(id: number) {
  const rows = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return rows[0];
}

async function notificationsFor(taskId: number) {
  const rows = await testDb.db.select().from(schema.notifications).all();
  return rows.filter((r) => r.taskId === taskId);
}

beforeEach(async () => {
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

describe("失败/取消/超时终态动作统一", () => {
  it("MCP 取消也要归档：教训 + 产物 + 通知 + 父任务汇总（原先一样都不做）", async () => {
    const agentId = await seedAgent();
    const parentId = await seedTask({ taskId: "T-PARENT", name: "父任务", agentId });
    const childId = await seedTask({ taskId: "T-CHILD", name: "子任务", parentTaskId: parentId, agentId });

    const { isError } = await callTool("cancel_task", { taskId: childId, reason: "重复创建" });
    expect(isError).toBe(false);

    const row = await taskRow(childId);
    // 保留语义：仍是 failed + [cancelled] 原因前缀
    expect(row.status).toBe("failed");
    expect(row.error).toBe("[cancelled] 重复创建");

    // 新增：取消同样走统一归档（原先全缺）
    expect(mocks.syncTaskLessonToXuanji).toHaveBeenCalledTimes(1);
    expect(mocks.syncTaskArtifactsToAlist).toHaveBeenCalledTimes(1);
    expect(await notificationsFor(childId)).toHaveLength(1);
    expect(mocks.autoSummarizeCollab).toHaveBeenCalledWith(parentId);
  });

  it("超时终态补齐产物归档与父任务汇总（原先只做教训+通知）", async () => {
    const agentId = await seedAgent();
    const parentId = await seedTask({ taskId: "T-P2", name: "父任务2", agentId });
    const id = await seedTask({
      taskId: "T-TIMEOUT",
      name: "超时任务",
      status: "running",
      agentId,
      parentTaskId: parentId,
      claimedAt: new Date(NOW.getTime() - 3_600_000),
      workerLeaseExpiresAt: new Date(NOW.getTime() - 60_000),
      timeoutMs: 300_000,
      retryCount: 3,
      maxRetries: 3,
      workerLeaseToken: "lease-x",
    });

    await sweepTaskTimeouts(testDb.db as never, NOW);

    const row = await taskRow(id);
    // 保留语义：终态字段与租约清理不变
    expect(row.status).toBe("failed");
    expect(row.lifecycleStatus).toBe("failed");
    expect(row.failedAt).toEqual(NOW);
    expect(row.workerLeaseToken).toBeNull();

    expect(mocks.syncTaskLessonToXuanji).toHaveBeenCalledTimes(1);
    expect(mocks.syncTaskArtifactsToAlist).toHaveBeenCalledTimes(1);
    expect(mocks.autoSummarizeCollab).toHaveBeenCalledWith(parentId);
    expect(await notificationsFor(id)).toHaveLength(1);
  });

  it("还有重试次数 → 重新排队，不算终态，绝不触发任何归档（回归）", async () => {
    const id = await seedTask({
      taskId: "T-REQUEUE",
      status: "running",
      claimedAt: new Date(NOW.getTime() - 3_600_000),
      workerLeaseExpiresAt: new Date(NOW.getTime() - 60_000),
      timeoutMs: 300_000,
      retryCount: 0,
      maxRetries: 3,
      workerLeaseToken: "lease-y",
    });

    await sweepTaskTimeouts(testDb.db as never, NOW);

    const row = await taskRow(id);
    expect(row.status).toBe("queued");
    expect(row.retryCount).toBe(1);
    expect(mocks.syncTaskLessonToXuanji).not.toHaveBeenCalled();
    expect(mocks.syncTaskArtifactsToAlist).not.toHaveBeenCalled();
    expect(mocks.autoSummarizeCollab).not.toHaveBeenCalled();
    expect(await notificationsFor(id)).toHaveLength(0);
  });

  it("取消终态任务被拒绝，且不产生任何归档（回归）", async () => {
    const id = await seedTask({ taskId: "T-DONE", status: "done" });

    // 该工具用的是旧式 failResult（success:false + error 文案，非 isError），与既有约定一致
    const { payload } = await callTool("cancel_task", { taskId: id });
    expect(payload.success).toBe(false);
    expect(String(payload.error ?? "")).toContain("终态");

    expect(mocks.syncTaskLessonToXuanji).not.toHaveBeenCalled();
    expect(await notificationsFor(id)).toHaveLength(0);
  });

  it("无父任务的取消不会调用父任务汇总（parentTaskId 为空即终止）", async () => {
    const id = await seedTask({ taskId: "T-SOLO", status: "queued" });

    await callTool("cancel_task", { taskId: id, reason: "不需要了" });

    expect(mocks.autoSummarizeCollab).not.toHaveBeenCalled();
    expect(mocks.syncTaskLessonToXuanji).toHaveBeenCalledTimes(1);
  });
});
