/**
 * §4-② 通知归属化：系统任务（无执行代理，agentId=null）的失败教训通知落地。
 *
 * 原状况（§3-3 切片 3 发现、当时按"跳过"处理）：notifications.agent_id 是
 * NOT NULL + REFERENCES agents(id)，系统任务没有归属者——通知层只能
 * "no assignee → skip"。教训照常进璇玑，但"教训已归档"这件事**没有任何
 * 站内信**：管理员/面板永远不知道系统任务失败了，只能翻日志。
 *
 * 现状况（产品决策：建"系统"代理行承载归属，用 §4-① 的版本化迁移落地）：
 *  - 版本化迁移 0001：INSERT INTO agents (agent_id='system', source='system',
 *    model=NULL)——幂等（冲突忽略）；model 留空使 fusion 面板的
 *    "status IN (online,busy,idle) AND model 非空"过滤天然排除它；派单是
 *    agent 自认领模型，被动行永远不会被派活。
 *  - finalize 通知归属解析：task.agentId 为 null 时回落到系统代理行——
 *    通知真实落库，lesson_notification verdict 从 skip 变 done。
 *
 * RED 锚点：撤掉 task-finalize 里的 resolveSystemNotifyAgentId 回落（改回
 * `agentId: task.agentId ?? null`）→ 第 3 条用例转红（通知缺失）。
 */
import { and, eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  syncTaskMemoryToXuanji: vi.fn(),
  syncTaskLessonToXuanji: vi.fn(),
  syncTaskArtifactsToAlist: vi.fn(),
  autoSummarizeCollab: vi.fn(),
}));
const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({
  broadcastToDashboard: vi.fn(),
  broadcastToTask: vi.fn(),
  sendToAgent: vi.fn(),
}));

vi.mock("../../api/queries/connection", async (importOriginal) => {
  // 保真 resolveDbPath：本文件的接线用例直跑真实 autoMigrate
  const actual = await importOriginal<typeof import("../../api/queries/connection")>();
  return { ...actual, getDb: conn.getDb };
});
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));
vi.mock("../../api/lib/xuanji-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/xuanji-sync")>()),
  syncTaskMemoryToXuanji: mocks.syncTaskMemoryToXuanji,
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

// 引入即注册 0001（生产由 auto-migrate 的 side-effect import 完成同样的事）
import "../../api/lib/migrations-register";
import { runSchemaMigrations } from "../../api/lib/schema-migrations";
import { enqueueTaskFinalize, runDueFinalizeActions } from "../../api/lib/finalize-actions";

const NOW = new Date("2026-09-28T08:00:00Z");
let testDb: TestDb;

async function systemAgentRow() {
  const rows = await testDb.db.select().from(schema.agents).where(eq(schema.agents.agentId, "system"));
  return rows[0] ?? null;
}

async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-SYS-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "系统任务通知归属测试",
      description: "desc",
      status: "running",
      lifecycleStatus: "reviewing",
      boardStatus: "review",
      priority: 0,
      ...overrides,
    })
    .returning({ id: schema.tasks.id });
  return rows[0].id;
}

beforeEach(() => {
  testDb = createTestDb();
  markSystemReady();
  // 与生产启动序一致：建表 → 版本化迁移（0001 落下 system 代理行）
  runSchemaMigrations(testDb.raw as unknown as DatabaseSync);
  conn.getDb.mockReturnValue(testDb.db);
  mocks.syncTaskMemoryToXuanji.mockReset().mockResolvedValue({ synced: true, reason: "written" });
  mocks.syncTaskLessonToXuanji.mockReset().mockResolvedValue({ synced: true, reason: "written" });
  mocks.syncTaskArtifactsToAlist.mockReset().mockResolvedValue({ synced: false, reason: "nothing_to_upload" });
  mocks.autoSummarizeCollab.mockReset().mockResolvedValue(null);
  for (const fn of Object.values(wsMocks)) fn.mockReset();
});

afterEach(() => {
  testDb.dispose();
});

describe("§4-② 系统代理行（版本化迁移 0001）", () => {
  it("迁移落地 system 代理行：agent_id/system/source 恰当、model 留空（fusion 面板天然排除）", () => {
    const agent = testDb.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.agentId, "system"))
      .all()[0];
    const row = testDb.db.select().from(schema.agents).where(eq(schema.agents.agentId, "system")).all()[0];
    expect(row).toBeTruthy();
    expect(row!.source).toBe("system");
    expect(row!.model).toBeNull();
    expect(row!.name).toContain("系统");
  });

  it("迁移幂等：重复执行不会产生第二行 system 代理", () => {
    runSchemaMigrations(testDb.raw as unknown as DatabaseSync);
    runSchemaMigrations(testDb.raw as unknown as DatabaseSync);
    const rows = testDb.db.select().from(schema.agents).where(eq(schema.agents.agentId, "system")).all();
    expect(rows.length).toBe(1);
  });

  it("（接线）真实 autoMigrate 落下 schema_migrations 记录", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sysagent-"));
    const dbPath = path.join(dir, "m.db");
    process.env.DATABASE_URL = dbPath;
    vi.resetModules();
    try {
      const { autoMigrate } = await import("../../api/lib/auto-migrate");
      const logs = await autoMigrate(false);
      const raw = new DatabaseSync(dbPath, { readOnly: true });
      const mig = (raw.prepare("SELECT name FROM schema_migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
      expect(mig).toContain("0001-notifications-system-agent");
      const agent = raw.prepare("SELECT agent_id, source, model FROM agents WHERE agent_id='system'").get();
      expect(agent).toBeTruthy();
      expect((agent as { source: string }).source).toBe("system");
      void logs;
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("§4-② 通知归属化：系统任务的失败教训通知落地", () => {
  it("无执行代理的任务失败 → 通知真实落库，归属系统代理行（原为 skip 静默丢失）", async () => {
    const id = await seedTask({ agentId: null });
    const sys = await systemAgentRow();
    expect(sys).toBeTruthy();

    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-SYS-X", outcome: "failed", now: NOW });
    const summary = await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 1000));
    expect(summary.done).toBe(1);

    const notes = await testDb.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.taskId, id), eq(schema.notifications.type, "lesson_recorded")));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]!.agentId).toBe(sys!.id);
  });

  it("有执行代理的任务：归属不变（仍是原代理），系统回落不干扰", async () => {
    const agents = await testDb.db.insert(schema.agents)
      .values({ agentId: "agent-real", name: "真实代理", system: "test" })
      .returning({ id: schema.agents.id });
    const realId = agents[0]!.id;
    const id = await seedTask({ agentId: realId });

    await enqueueTaskFinalize(testDb.db, { taskId: id, taskPublicId: "T-SYS-Y", outcome: "failed", now: NOW });
    await runDueFinalizeActions(testDb.db, new Date(NOW.getTime() + 1000));

    const notes = await testDb.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.taskId, id), eq(schema.notifications.type, "lesson_recorded")));
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]!.agentId).toBe(realId);
  });
});
