import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { repairMissingColumns, type SchemaRepairResult } from "../../api/lib/schema-repair";
import { CREATE_TABLES_SQL } from "../../api/lib/auto-migrate";
import { nodeSqliteAdapter } from "../../api/lib/node-sqlite-adapter";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { tasks } from "@db/schema";
import { eq } from "drizzle-orm";

/**
 * 旧库升级（Phase B）：已存在的 SQLite 老库必须能补上后来新增的列。
 *
 * 原状况：补列函数 repairMissingColumns 是**手写清单**（只有 13 个 tasks.board_*），
 * 且只被 bootstrap-mysql-import 调用——而该函数对非 MySQL DSN 会提前 return，
 * 所以原生 SQLite（当前生产形态）**从来不补列**；autoMigrate 只有
 * CREATE TABLE IF NOT EXISTS，对已存在的表什么都不做。
 * 结果：往 db/schema.ts 加一列，部署后生产会在运行时炸 "no such column"，
 * 而本地测试全绿。
 *
 * 本文件用真实驱动复刻"老库 → 启动补列"场景，并锁定三条契约：
 *   1. 缺列必须被补上，且原有数据不丢；
 *   2. 补列清单必须**从 db/schema.ts 派生**，不是手写清单（否则下次加列又漏）；
 *   3. SQLite 拒绝补的列（表达式默认值等）必须**明确上报**，不能静默略过。
 */
function freshDb(): DatabaseSync {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  for (const sql of CREATE_TABLES_SQL) raw.exec(sql);
  return raw;
}

function columnsOf(raw: DatabaseSync, table: string): string[] {
  return (raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
}

/** 复刻历史事故：da74c0d 在 volume 建出的 tasks 表缺 board_* 等 13 列 */
const HISTORICAL_TASKS_COLUMNS = [
  "board_status", "board_labels", "board_notes", "source_url", "last_heartbeat_at",
  "heartbeat_interval_ms", "reviewer_id", "review_result", "triaged_at",
  "backlogged_at", "ready_at", "review_at", "blocked_at",
];

describe("旧库升级：补列", () => {
  it("复刻历史事故：老 tasks 表缺 13 个 board_* 列 → 全部补齐且数据不丢", () => {
    const raw = freshDb();
    raw.prepare(
      `INSERT INTO tasks (task_id, name, description, priority, status, lifecycle_status)
       VALUES ('TG-OLD1', '老库任务', 'd', 0, 'done', 'completed')`,
    ).run();
    for (const col of HISTORICAL_TASKS_COLUMNS) raw.exec(`ALTER TABLE tasks DROP COLUMN "${col}"`);
    // 前置断言：确认真的缺列了（否则测试是空转）
    expect(columnsOf(raw, "tasks")).not.toContain("board_status");

    const result = repairMissingColumns(raw);

    const after = columnsOf(raw, "tasks");
    for (const col of HISTORICAL_TASKS_COLUMNS) expect(after).toContain(col);
    expect(result.added.map((a) => a.column).sort()).toEqual([...HISTORICAL_TASKS_COLUMNS].sort());
    // 数据不丢
    const row = raw.prepare("SELECT task_id, name, board_status FROM tasks").get() as Record<string, unknown>;
    expect(row.task_id).toBe("TG-OLD1");
    expect(row.name).toBe("老库任务");
    // 常量默认值生效
    expect(row.board_status).toBe("triage");
    raw.close();
  });

  it("补列清单从 schema 派生：旧手写清单里没有的列也会被补上", () => {
    const raw = freshDb();
    // state_revision 不在历史手写清单（只有 13 个 board_*）之内
    raw.exec(`ALTER TABLE tasks DROP COLUMN "state_revision"`);
    raw.exec(`ALTER TABLE tasks DROP COLUMN "worker_lease_generation"`);
    expect(columnsOf(raw, "tasks")).not.toContain("state_revision");

    const result = repairMissingColumns(raw);

    expect(columnsOf(raw, "tasks")).toContain("state_revision");
    expect(columnsOf(raw, "tasks")).toContain("worker_lease_generation");
    expect(result.added.map((a) => a.column)).toContain("state_revision");
    raw.close();
  });

  it("SQLite 拒绝补的列必须明确上报，不能静默略过", () => {
    const raw = freshDb();
    // created_at 是 NOT NULL 且默认值非常量 → SQLite 明确拒绝 ADD COLUMN
    raw.exec(`ALTER TABLE tasks DROP COLUMN "created_at"`);
    expect(columnsOf(raw, "tasks")).not.toContain("created_at");

    const result = repairMissingColumns(raw);

    const skipped = result.skipped.find((s) => s.table === "tasks" && s.column === "created_at");
    expect(skipped).toBeDefined();
    expect(skipped?.reason).toMatch(/default|NOT NULL/i);
    // 关键：不能悄悄把它加成可空列（那会与 schema 语义不符）
    expect(columnsOf(raw, "tasks")).not.toContain("created_at");
    raw.close();
  });

  it("幂等：已对齐的库再跑一次不补任何列", () => {
    const raw = freshDb();
    const first = repairMissingColumns(raw);
    expect(first.added).toHaveLength(0);
    expect(first.skipped).toHaveLength(0);

    raw.exec(`ALTER TABLE tasks DROP COLUMN "board_status"`);
    const second = repairMissingColumns(raw);
    expect(second.added.map((a) => a.column)).toEqual(["board_status"]);
    const third = repairMissingColumns(raw);
    expect(third.added).toHaveLength(0);
    raw.close();
  });

  it("补齐后真实 drizzle 查询可用（原症状是 no such column）", async () => {
    const raw = freshDb();
    raw.exec(`ALTER TABLE tasks DROP COLUMN "board_status"`);
    repairMissingColumns(raw);

    const db = drizzle(nodeSqliteAdapter(raw), { schema: { tasks } });
    await db.insert(tasks).values({
      taskId: "TG-REP1",
      name: "补列后可查",
      description: "d",
      priority: 0,
      input: "{}",
      status: "queued",
      lifecycleStatus: "queued",
    } as never);
    const rows = await db.select({ id: tasks.id, boardStatus: tasks.boardStatus }).from(tasks).where(eq(tasks.taskId, "TG-REP1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].boardStatus).toBe("triage");
    raw.close();
  });

  it("返回值带结构化结果，便于就绪状态/日志消费", () => {
    const raw = freshDb();
    raw.exec(`ALTER TABLE tasks DROP COLUMN "board_status"`);
    const result: SchemaRepairResult = repairMissingColumns(raw);
    expect(Array.isArray(result.added)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(result.added[0]).toMatchObject({ table: "tasks", column: "board_status" });
    expect(typeof result.added[0].ddl).toBe("string");
    raw.close();
  });
});
