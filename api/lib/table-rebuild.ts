/**
 * 表重建（table rebuild）——SQLite 下唯一能表达"NOT NULL + 非常量默认值"、
 * 改主键、改约束这类**不能 ALTER** 的结构变更的通用办法：
 * 建影子表 → 复制数据 → 换名。SQLite 不支持 ALTER COLUMN / DROP CONSTRAINT。
 *
 * 供版本化迁移（api/lib/schema-migrations.ts）的 up() 调用；不放进启动路径——
 * 结构变更是有意识的行为，必须写在某个 named migration 里。
 *
 * 契约（tests/api/table-rebuild.test.ts 背书）：
 *  - 自带事务；若调用方已在事务中则并入外层事务（不嵌套 BEGIN）；
 *  - 失败整体回滚，原表原数据原地不动；
 *  - 完成前行数必须一致（默认校验行数，可选调用方 verify 覆盖）；
 *  - 换名窗口内临时关闭 foreign_keys（PRAGMA 是连接级、不进事务，结束恢复原值）。
 */
import type { DatabaseSync } from "node:sqlite";

const TMP_SUFFIX = "__rebuild";

export interface RebuildTableOptions {
  db: DatabaseSync;
  /** 目标表名 */
  tableName: string;
  /** 新结构的 CREATE TABLE（必须以 `CREATE TABLE [IF NOT EXISTS] "tableName" (` 开头） */
  createTableDdl: string;
  /** INSERT INTO 临时表 (...) SELECT * FROM 目标表 的显式投影列；缺省为整表 `SELECT *` */
  copyColumns?: string[];
  /** 复制后的附加校验（默认行数一致）；抛错即整体回滚 */
  verify?: (db: DatabaseSync, beforeRows: number, afterRows: number) => void;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function rebuildTable(opts: RebuildTableOptions): void {
  const { db, tableName, createTableDdl, copyColumns, verify } = opts;
  const target = quoteIdent(tableName);
  const tmp = quoteIdent(tableName + TMP_SUFFIX);

  const before = (db.prepare(`SELECT COUNT(*) c FROM ${target}`).get() as { c: number }).c;

  // 把 createTableDdl 的目标表名（首个标识符）改写为临时表名。
  // 我们的 DDL 全部出自 ddl.ts 统一形态：`CREATE TABLE [IF NOT EXISTS] "name" (`。
  const header = createTableDdl.match(/^(\s*CREATE TABLE (?:IF NOT EXISTS )?)"((?:[^"]|"")+)"/);
  if (!header) {
    throw new Error(`rebuildTable: createTableDdl must start with CREATE TABLE "${tableName}" ...`);
  }
  const ddlTable = header[2].replaceAll('""', '"');
  if (ddlTable !== tableName) {
    throw new Error(`rebuildTable: createTableDdl creates "${ddlTable}" but expected "${tableName}"`);
  }
  const renamedDdl = header[1].replace("IF NOT EXISTS ", "") + tmp + createTableDdl.slice(header[0].length);

  const fkWas = (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys;
  const hadTx = (db as unknown as { isTransaction?: boolean }).isTransaction === true;
  if (!hadTx) db.exec("BEGIN");
  let ok = false;
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`DROP TABLE IF EXISTS ${tmp}`);
    db.exec(renamedDdl);
    const cols = copyColumns ? ` (${copyColumns.map(quoteIdent).join(", ")})` : "";
    db.exec(`INSERT INTO ${tmp}${cols} SELECT * FROM ${target}`);
    const mid = (db.prepare(`SELECT COUNT(*) c FROM ${tmp}`).get() as { c: number }).c;
    if (typeof verify === "function") verify(db, before, mid);
    else if (mid !== before) throw new Error(`rebuild row count mismatch: ${tableName} ${before} -> ${mid}`);
    db.exec(`DROP TABLE ${target}`);
    db.exec(`ALTER TABLE ${tmp} RENAME TO ${tableName.replaceAll('"', '""')}`);
    ok = true;
  } finally {
    if (!hadTx) db.exec(ok ? "COMMIT" : "ROLLBACK");
    try { db.exec(`PRAGMA foreign_keys = ${fkWas ? "ON" : "OFF"}`); } catch { /* 旧驱动忽略 */ }
  }
}
