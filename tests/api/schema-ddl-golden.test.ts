/**
 * 黄金快照等价性：DDL 生成器（api/lib/ddl.ts，从 db/schema.ts 派生）建出的库结构
 * 必须与重写前手写 SQL（旧 auto-migrate.ts 的 CREATE_TABLES_SQL）在真实 SQLite 上
 * 建出的结构**逐表逐列等价**。
 *
 * 黄金快照（tests/api/fixtures/schema-golden.json）冻结于 2026-09-28，来源：
 * 旧手写 SQL 全量执行后的 PRAGMA table_info / foreign_key_list / index_list（含
 * index_info 列序）。比对口径：
 *  - 列型别按 SQLite 亲和性归一（大小写、text(200)→TEXT——长度在 SQLite 无强制力）；
 *  - NOT NULL / PK / 默认值文本精确比对；
 *  - 外键（目标表/列/on_delete）与索引（名/唯一/列序）精确比对。
 *
 * **加表/加列后的更新流程**：跑 scripts 后重冻结快照并同 commit 提交——
 * 快照变了说明"库的形状"变了，必须是有意识的行为（这正是版本化纪律的闸门）。
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import * as schema from "../../db/schema";
import { generateAllDdl } from "../../api/lib/ddl";
import golden from "./fixtures/schema-golden.json";

type Col = [string, string, number, string | null, number];
type Fk = [string, string, string, string];
type Idx = [string, number, string[]];
type TableShape = { columns: Col[]; foreignKeys: Fk[]; indexes: Idx[] };

function normalizeType(t: string): string {
  // SQLite 亲和性归一：text(200)→TEXT、int→INTEGER；VARCHAR→TEXT 家族一并归一
  const base = t.toUpperCase().replace(/\(.*\)/, "");
  if (base.includes("INT")) return "INTEGER";
  if (base.includes("CHAR") || base.includes("CLOB") || base === "TEXT") return "TEXT";
  if (base.includes("REAL") || base.includes("FLOA") || base.includes("DOUB")) return "REAL";
  if (base === "BLOB" || base === "") return "BLOB";
  return base;
}

function dumpStructure(db: DatabaseSync): Record<string, TableShape> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r: { name: string }) => r.name);
  const out: Record<string, TableShape> = {};
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info(${JSON.stringify(t)})`).all() as Record<string, unknown>[])
      .map((c) => [String(c.name), normalizeType(String(c.type ?? "")), c.notnull ? 1 : 0, c.dflt_value === null ? null : String(c.dflt_value), c.pk ? 1 : 0] as Col);
    const fks = (db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t)})`).all() as Record<string, unknown>[])
      .sort((a, b) => String(a.from).localeCompare(String(b.from)))
      .map((f) => [String(f.table), String(f.from), String(f.to), String(f.on_delete ?? "NO ACTION")] as Fk);
    const idxs = (db.prepare(`PRAGMA index_list(${JSON.stringify(t)})`).all() as Record<string, unknown>[])
      .filter((i) => i.origin === "c" || i.origin === "u")
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))
      .map((i) => {
        const cols = (db.prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`).all() as Record<string, unknown>[])
          .map((r) => String(r.name));
        return [String(i.name), i.unique ? 1 : 0, cols] as Idx;
      });
    out[t] = { columns: cols, foreignKeys: fks, indexes: idxs };
  }
  return out;
}

describe("DDL 生成器 ≡ 手写 SQL 黄金快照（§4 版本化迁移统一）", () => {
  it("派生 DDL 建出的库结构与手写 SQL 的黄金快照逐表等价", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const ddl = generateAllDdl(schema as unknown as Record<string, unknown>);
    expect(ddl.filter((s) => s.startsWith("CREATE TABLE")).length).toBe(Object.keys(golden).length);
    for (const stmt of ddl) db.exec(stmt);
    const actual = dumpStructure(db);
    const expected = golden as unknown as Record<string, TableShape>;

    const missing = Object.keys(expected).filter((t) => !actual[t]);
    const extra = Object.keys(actual).filter((t) => !expected[t]);
    expect(missing, "缺表").toEqual([]);
    expect(extra, "多表").toEqual([]);

    for (const t of Object.keys(expected)) {
      const a = actual[t];
      const e = expected[t];
      expect(a.columns.map((c) => c[0]), `${t} 列名序`).toEqual(e.columns.map((c) => c[0]));
      expect(a.columns, `${t} 列全形（型别/NOT NULL/默认值/PK）`).toEqual(e.columns);
      expect(a.foreignKeys, `${t} 外键`).toEqual(
        [...e.foreignKeys].sort((x, y) => x[1].localeCompare(y[1])),
      );
      expect(a.indexes, `${t} 索引`).toEqual(
        [...e.indexes].sort((x, y) => x[0].localeCompare(y[0])),
      );
    }
  });

  it("派生 DDL 在外键开启下可整库执行（拓扑序正确：notifications 晚于 agents/tasks）", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    const ddl = generateAllDdl(schema as unknown as Record<string, unknown>);
    const pos = (needle: string) => ddl.findIndex((s) => s.includes(`"${needle}" (`));
    expect(pos("agents")).toBeLessThan(pos("notifications"));
    expect(pos("tasks")).toBeLessThan(pos("notifications"));
    for (const stmt of ddl) expect(() => db.exec(stmt)).not.toThrow();
  });

  it("CHECK 约束在派生 DDL 下真实生效（坏状态插入被拒）", () => {
    const db = new DatabaseSync(":memory:");
    for (const stmt of generateAllDdl(schema as unknown as Record<string, unknown>)) db.exec(stmt);
    expect(() =>
      db.prepare("INSERT INTO tasks (task_id, name, status) VALUES ('T-CHK','x','bogus')").run(),
    ).toThrow(/CHECK/i);
  });
});
