/**
 * 时间戳存量修复回归测试（58669 年事故的数据侧收尾）。
 *
 * 用真实 node:sqlite 建表并写入「毫秒脏值」与「正常秒值」两类行，验证：
 *  - scan 只统计脏行（>1e11）
 *  - apply 把脏值 ÷1000 落回秒，正常行不动
 *  - 幂等：再跑一次 updated = 0（不会二次除）
 *  - 列发现来自 drizzle schema（SQLiteTimestamp + mode=timestamp），不硬编码表名
 *
 * 为什么必须真跑 SQL：既有测试基建（fake-db）不执行真实 SQL（见 fake-db.ts 头注释），
 * 这类「写的单位和读的单位不一致」的 bug 从源头就拦不住。
 */
import { DatabaseSync } from "node:sqlite";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyTimestampRepair,
  listTimestampColumns,
  scanTimestampRepair,
  type TimestampRepairDb,
} from "../../api/lib/timestamp-repair";

const CREATE_TASK_MESSAGES = `
CREATE TABLE task_messages (
  id integer PRIMARY KEY,
  task_id integer NOT NULL,
  content text NOT NULL,
  created_at integer NOT NULL
);
`;

/** 把 drizzle SQL 对象渲染成字符串后交给 node:sqlite 执行（模拟 drizzle 的 db.all/db.run）。 */
function makeDb(raw: DatabaseSync): TimestampRepairDb {
  const dialect = new SQLiteSyncDialect();
  const render = (query: unknown): string => dialect.sqlToQuery(query as never).sql;
  return {
    all: (query: unknown) => raw.prepare(render(query)).all(),
    run: (query: unknown) => raw.prepare(render(query)).run(),
  };
}

/** 2026-09-13 附近的正常秒值与其「被当毫秒写」的错误形态（×1000）。 */
const GOOD_SECONDS = 1789000000;
const DIRTY_MILLIS = GOOD_SECONDS * 1000;

describe("timestamp-repair", () => {
  let raw: DatabaseSync;
  let db: TimestampRepairDb;

  beforeEach(() => {
    raw = new DatabaseSync(":memory:");
    raw.exec(CREATE_TASK_MESSAGES);
    db = makeDb(raw);
    // 其余 schema 表在本测试库中不存在，scan 会逐列 catch 跳过并 warn —— 静音避免刷屏
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("列发现来自 drizzle schema（task_messages.created_at 在列内）", () => {
    const columns = listTimestampColumns();
    expect(columns).toContainEqual({ table: "task_messages", column: "created_at" });
  });

  it("scan 只统计毫秒脏行", async () => {
    raw.exec(`INSERT INTO task_messages (id, task_id, content, created_at) VALUES
      (1, 100, 'good', ${GOOD_SECONDS}),
      (2, 100, 'dirty', ${DIRTY_MILLIS})`);

    const scan = await scanTimestampRepair(db);
    expect(scan.totalDirty).toBe(1);
    const row = scan.rows.find((r) => r.table === "task_messages" && r.column === "created_at");
    expect(row?.dirty).toBe(1);
    // 样本应展示修复后的（正确年份）时间
    expect(row?.samples[0]?.startsWith("2026-")).toBe(true);
  });

  it("apply 修回秒值且不动正常行，重复执行幂等", async () => {
    raw.exec(`INSERT INTO task_messages (id, task_id, content, created_at) VALUES
      (1, 100, 'good', ${GOOD_SECONDS}),
      (2, 100, 'dirty', ${DIRTY_MILLIS})`);

    const first = await applyTimestampRepair(db);
    expect(first.totalUpdated).toBe(1);

    const rows = raw.prepare("SELECT id, created_at FROM task_messages ORDER BY id").all() as Array<{
      id: number;
      created_at: number;
    }>;
    expect(rows[0]?.created_at).toBe(GOOD_SECONDS);
    expect(rows[1]?.created_at).toBe(GOOD_SECONDS); // 脏值已 ÷1000 落回同一秒

    const second = await applyTimestampRepair(db);
    expect(second.totalUpdated).toBe(0);
  });

  it("空库/无脏值时 apply 为 0，不抛错", async () => {
    const scan = await scanTimestampRepair(db);
    expect(scan.totalDirty).toBe(0);
    const applied = await applyTimestampRepair(db);
    expect(applied.totalUpdated).toBe(0);
  });
});
