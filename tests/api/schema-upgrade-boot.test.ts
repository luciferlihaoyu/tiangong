import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * 旧库升级的**接线**测试（Phase B）。
 *
 * schema-upgrade.test.ts 只证明了"补列函数本身正确"。真正的缺陷在接线：
 * 补列原先只被 bootstrap-mysql-import 调用，而它对非 MySQL DSN 会提前 return，
 * 于是原生 SQLite（当前生产形态）**从来不补列**——老库永远缺后来新增的列，
 * 部署新版后运行时炸 "no such column"。
 *
 * 本测试跑真实的 autoMigrate（启动时调用的那个函数）两轮：
 *   第一轮建库 → 模拟老库删掉一列 → 第二轮（等价于部署新版后重启）必须补回来。
 */
vi.mock("../../api/queries/connection", async (importOriginal) => {
  // setup.ts 把 connection mock 成只有 getDb，会让 autoMigrate 里的
  // resolveDbPath 变成 undefined；这里保留真实实现。
  const actual = await importOriginal<typeof import("../../api/queries/connection")>();
  return { ...actual, getDb: vi.fn() };
});

function columnsOf(dbPath: string, table: string): string[] {
  const raw = new DatabaseSync(dbPath);
  try {
    return (raw.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
  } finally {
    raw.close();
  }
}

describe("旧库升级：启动路径接线", () => {
  it("原生 SQLite 老库在 autoMigrate 时被补列（回归：补列原先只在 MySQL 分支执行）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-upgrade-"));
    const dbPath = path.join(dir, "tiangong.db");
    try {
      // resolveDbPath 对非 mysql:// 的 URL 原样返回路径
      process.env.DATABASE_URL = dbPath;
      vi.resetModules();
      const { autoMigrate } = await import("../../api/lib/auto-migrate");

      // 第一轮：建库（等价于全新部署）
      const logs1 = await autoMigrate();
      expect(logs1.length).toBeGreaterThan(0);
      expect(columnsOf(dbPath, "tasks")).toContain("board_status");

      // 模拟"由旧版本建出的老库"：删掉一列并写入一行数据
      const raw = new DatabaseSync(dbPath);
      raw.exec(`ALTER TABLE tasks DROP COLUMN "board_status"`);
      raw
        .prepare(
          `INSERT INTO tasks (task_id, name, description, priority, status, lifecycle_status)
           VALUES ('TG-UPG1', '升级前的老任务', 'd', 0, 'done', 'completed')`,
        )
        .run();
      raw.close();
      expect(columnsOf(dbPath, "tasks")).not.toContain("board_status");

      // 第二轮：等价于部署新版后重启
      vi.resetModules();
      const fresh = await import("../../api/lib/auto-migrate");
      const logs2 = await fresh.autoMigrate();

      // 列被补回来 —— 这正是修复点
      expect(columnsOf(dbPath, "tasks")).toContain("board_status");
      expect(logs2.join("\n")).toMatch(/schema-repair/);

      // 老数据没丢
      const verify = new DatabaseSync(dbPath);
      const row = verify.prepare("SELECT task_id, name, board_status FROM tasks").get() as Record<string, unknown>;
      expect(row.task_id).toBe("TG-UPG1");
      expect(row.board_status).toBe("triage");
      verify.close();
    } finally {
      delete process.env.DATABASE_URL;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
