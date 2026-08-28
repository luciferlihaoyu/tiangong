/**
 * Bootstrap MySQL → SQLite 全量导入（一次性自迁移，幂等）。
 *
 * 背景：天宫 MySQL→SQLite 迁移（#61）。S3 的导入脚本只在本地临时库验证过，
 * 生产 volume 的 SQLite 是 autoMigrate 新建的空库（只有 seed）。本模块在
 * 服务启动时执行：若仍然配置了 MySQL DSN（DATABASE_URL=mysql://...）且
 * SQLite 关键业务表为空（无数据），则从 MySQL 全量导入（48 表，与
 * backups/mysql-dump 同语义），使"部署即自愈"，无需人工在容器里跑脚本。
 *
 * 幂等性：
 *  - 关键表（agents / tasks）任一非空 → 跳过整个导入（认为已迁移/已有数据）
 *  - 逐表导入前先 DELETE 该表（处理分阶段中断），导入后行数与源对账
 *  - 导入完成后进入正常生命周期；下次启动表非空 → 直接跳过
 *
 * 安全：数据只从 MySQL 单向流入 SQLite，不反向写回；失败只 warn 不阻断启动
 * （应用仍可用空库/部分库启动，天宫关键数据由 MySQL 兜底仍在）。
 */
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { env } from "./env";
import { resolveDbPath } from "../queries/connection";

const CRITICAL_TABLES = ["agents", "tasks", "users"];

/** 检查 SQLite 关键表是否为空（任一带行数 → 非空，跳过导入） */
function sqliteHasData(db: DatabaseSync): boolean {
  for (const table of CRITICAL_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number } | undefined;
      if (row && row.n > 0) return true;
    } catch {
      // 表不存在（autoMigrate 未完成）→ 视为空
    }
  }
  return false;
}

/**
 * 执行 MySQL → SQLite 全量导入。
 * @returns 日志数组（调用方打印/记录）；异常时抛错由调用方 catch。
 */
export async function bootstrapMysqlImport(): Promise<string[]> {
  const logs: string[] = [];
  const databaseUrl = env.databaseUrl;
  if (!databaseUrl) {
    logs.push("bootstrap-import: DATABASE_URL not set — skip");
    return logs;
  }
  if (!databaseUrl.startsWith("mysql://") && !databaseUrl.startsWith("mysql2://")) {
    logs.push("bootstrap-import: DATABASE_URL is not MySQL DSN — skip (SQLite native)");
    return logs;
  }

  const dbPath = resolveDbPath(databaseUrl);
  const db = new DatabaseSync(dbPath);

  if (sqliteHasData(db)) {
    logs.push("bootstrap-import: SQLite already has data — skip (idempotent)");
    db.close();
    return logs;
  }

  logs.push(`bootstrap-import: empty SQLite at ${dbPath}, importing from MySQL…`);

  let conn;
  try {
    conn = await createConnection({ uri: databaseUrl, connectTimeout: 10000 });
    const [tables] = await conn.query<Array<RowDataPacket & { TABLE_NAME: string }>>(
      "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY TABLE_NAME",
    );

    let total = 0;
    for (const { TABLE_NAME: table } of tables) {
      const [rows] = await conn.query<Array<RowDataPacket>>("SELECT * FROM `" + table + "`");
      try {
        db.prepare(`DELETE FROM "${table}"`).run();
      } catch {
        // 表不存在则跳过 DELETE，直接 INSERT（autoMigrate 已建表，正常不会走到）
      }
      if (rows.length === 0) {
        logs.push(`  ${table}: 0 rows (empty)`);
        continue;
      }
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => "?").join(",");
      const insertSql = `INSERT INTO "${table}" ("${cols.join('","')}") VALUES (${placeholders})`;
      const stmt = db.prepare(insertSql);
      db.exec("BEGIN");
      try {
        for (const row of rows) {
          const values = cols.map((c) => {
            const v = row[c];
            if (v === undefined || v === null) return null;
            if (typeof v === "string" || typeof v === "number" || typeof v === "bigint" || Buffer.isBuffer(v)) return v;
            return String(v);
          });
          stmt.run(...values);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      const check = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
      logs.push(`  ${table}: ${rows.length} rows imported (db=${check.n})${rows.length !== check.n ? " ⚠️ MISMATCH" : ""}`);
      total += rows.length;
    }
    logs.push(`bootstrap-import: DONE — ${tables.length} tables, ${total} rows`);
    return logs;
  } finally {
    if (conn) await conn.end();
    db.close();
  }
}