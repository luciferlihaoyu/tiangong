/**
 * 表重建（api/lib/table-rebuild.ts）——真实 SQLite 直测。
 *
 * §4 残余：NOT NULL + 表达式默认值（如 DEFAULT (unixepoch())）的列既不能 ALTER
 * ADD（SQLite 恒拒）也不能补列兜底（repair 只能上报 skip）——唯一出路是建影子表
 * 复制数据换名。本模块把这条路做成带事务回滚的可靠原语。
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { rebuildTable } from "../../api/lib/table-rebuild";

describe("表重建（真实 SQLite）", () => {
  it("加 NOT NULL 列（SQLite 无法 ALTER 的经典场景）：旧行保全、新列吃上默认值", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)");
    db.prepare("INSERT INTO notes (body) VALUES ('a'), ('b')").run();

    rebuildTable({
      db,
      tableName: "notes",
      createTableDdl: `CREATE TABLE "notes" (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        body TEXT NOT NULL,
        locked TEXT NOT NULL DEFAULT 'n'
      )`,
      copyColumns: ["id", "body"], // 新列不在投影里 → 落默认值
    });

    const before = db.prepare("SELECT id, body, locked FROM notes ORDER BY id").all() as { id: number; body: string; locked: string }[];
    expect(before).toEqual([
      { id: 1, body: "a", locked: "n" },
      { id: 2, body: "b", locked: "n" },
    ]);
    // 且新结构真实生效：再插一行不带锁列，也被默认值兜住
    db.prepare("INSERT INTO notes (body) VALUES ('c')").run();
    expect((db.prepare("SELECT locked FROM notes WHERE body='c'").get() as { locked: string }).locked).toBe("n");
  });

  it("校验失败整体回滚：原表原数据原地不动", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)");
    db.prepare("INSERT INTO notes (body) VALUES ('keep')").run();

    expect(() =>
      rebuildTable({
        db,
        tableName: "notes",
        createTableDdl: `CREATE TABLE "notes" (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, extra INTEGER)`,
        copyColumns: ["id", "body", "extra"], // 旧表没有 extra 列 → 半路报错 → 回滚
      }),
    ).toThrow();

    // 回滚后：表还是旧形状、数据还在、没有留下 __rebuild 残骸
    const cols = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(["id", "body"]);
    expect((db.prepare("SELECT body FROM notes").get() as { body: string }).body).toBe("keep");
    const leftovers = (db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__rebuild%'").all() as { name: string }[]);
    expect(leftovers).toEqual([]);
  });

  it("调用方已在事务中：并入外层事务，由调用方决定成败", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT)");
    db.prepare("INSERT INTO notes (body) VALUES ('tx')").run();

    db.exec("BEGIN");
    try {
      rebuildTable({
        db,
        tableName: "notes",
        createTableDdl: `CREATE TABLE "notes" (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, extra TEXT)`,
        copyColumns: ["id", "body"],
      });
      db.exec("ROLLBACK"); // 调用方决定放弃
    } catch (e) { db.exec("ROLLBACK"); }

    // 外层 ROLLBACK 连重建一起回滚：旧表原样
    const cols = db.prepare("PRAGMA table_info(notes)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(["id", "body"]);
    expect((db.prepare("SELECT COUNT(*) c FROM notes").get() as { c: number }).c).toBe(1);
  });

  it("传入的 CREATE TABLE 不是目标表时显式报错（配置错误不允许静默换名）", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    expect(() =>
      rebuildTable({
        db,
        tableName: "notes",
        createTableDdl: `CREATE TABLE "other" (id INTEGER PRIMARY KEY, body TEXT)`,
      }),
    ).toThrow(/expected "notes"/);
  });
});
