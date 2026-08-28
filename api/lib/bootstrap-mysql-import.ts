/**
 * Bootstrap MySQL → SQLite 全量导入（一次性自迁移，逐表幂等）。
 *
 * 背景：天宫 MySQL→SQLite 迁移（#61）。S3 的导入脚本只在本地临时库验证过，
 * 生产 volume 的 SQLite 是 autoMigrate 新建的库。本模块在服务启动时执行：
 * 若仍配置 MySQL DSN（DATABASE_URL=mysql://...），则从 MySQL 逐表补齐
 * SQLite 中的空表，使"部署即自愈"，无需人工进容器跑脚本。
 *
 * 逐表幂等（关键）：对每张表独立判断——SQLite 该表已有行 → 跳过（保留
 * 存量数据，避免覆盖新写入）；该表为空 → 从 MySQL DELETE+INSERT 全量导入。
 * 这覆盖了部分失败的中间态（如旧部署 tasks 缺列导致中断：agents 已导、
 * tasks 及其后表为空），下一轮部署自动补齐剩余空表，且不重导已有数据。
 *
 * 前置修复：旧部署建出的表可能缺列（tasks 缺 board_* 等 13 列），先跑
 * repairMissingColumns（ALTER TABLE ADD COLUMN）再判断/导入。
 *
 * 安全：数据只从 MySQL 单向流入 SQLite，不反向写回；失败只 warn 不阻断
 * 启动（应用仍可用已有数据启动）。
 */
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { env } from "./env";
import { resolveDbPath } from "../queries/connection";
import { repairMissingColumns } from "./schema-repair";

/**
 * 解析 db/schema.ts，返回 { 表名: Set<timestamp 列名> }。
 * 与 scripts/migrate-mysql-to-sqlite.mjs 同一套括号配对法（避免引入 TS AST）。
 * MySQL datetime 是 'YYYY-MM-DD HH:MM:SS' 字符串；SQLite 该列声明为 INTEGER
 * （drizzle mode:"timestamp"），字符串插入会以 TEXT 存储，读回 drizzle 返回
 * null → 前端渲染崩（退化点）。导入时需把字符串转 epoch 秒。
 */
function parseSchemaTimestampCols(): Record<string, Set<string>> {
  const schemaPath = path.resolve(__dirname, "../../db/schema.ts");
  const schemaText = fs.readFileSync(schemaPath, "utf8");
  const tables: Record<string, Set<string>> = {};
  const tableStartRe = /sqliteTable\(\s*"([\w_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = tableStartRe.exec(schemaText)) !== null) {
    const tableName = m[1];
    let i = m.index;
    while (i < schemaText.length && schemaText[i] !== "{") i++;
    let depth = 1;
    const bodyStart = i + 1;
    i++;
    while (i < schemaText.length && depth > 0) {
      const ch = schemaText[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    const body = schemaText.slice(bodyStart, i - 1);
    const tsSet = new Set<string>();
    const tsRe = /integer\(\s*"([\w_]+)"\s*,\s*\{\s*mode:\s*["']timestamp["']/g;
    let tm: RegExpExecArray | null;
    while ((tm = tsRe.exec(body)) !== null) tsSet.add(tm[1]);
    tables[tableName] = tsSet;
  }
  return tables;
}

/** 把 MySQL datetime 字符串转 epoch 秒（number）；非字符串/无效值返回原值。 */
function toEpochSeconds(v: unknown): number | unknown {
  if (typeof v !== "string") return v;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)) {
    const ms = Date.parse(v.replace(" ", "T") + (v.includes("Z") ? "" : "+08:00"));
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return v;
}

/**
 * 执行 MySQL → SQLite 增量导入（只补空表）。
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

  // 旧部署（#61-S4c 前）可能在 volume 建出缺列的表（tasks 缺 board_* 等 13 列），
  // autoMigrate 的 IF NOT EXISTS 不重建 → 先补列再判断/导入。
  try {
    const repairLogs = repairMissingColumns(db);
    if (repairLogs.length) logs.push(...repairLogs);
  } catch (e) {
    logs.push(`schema-repair error (continue): ${e instanceof Error ? e.message : String(e)}`);
  }

  logs.push(`bootstrap-import: db=${dbPath}, importing empty tables from MySQL…`);

  const schemaTsCols = parseSchemaTimestampCols();
  let conn;
  try {
    conn = await createConnection({ uri: databaseUrl, connectTimeout: 10000 });
    const [tables] = await conn.query<Array<RowDataPacket & { TABLE_NAME: string }>>(
      "SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY TABLE_NAME",
    );

    let imported = 0;
    let skipped = 0;
    for (const { TABLE_NAME: table } of tables) {
      let localCount = 0;
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
        localCount = r?.n ?? 0;
      } catch {
        // 表不存在（autoMigrate 未建）→ 按 0 行处理，导入时创建表会失败并记录
      }
      if (localCount > 0) {
        // 存量表：修复历史导入遗留的 TEXT 时间戳（旧版 bootstrap 未转换，
        // MySQL datetime 字符串存成 TEXT → drizzle 返回 null → 前端渲染崩）。
        const tsColsExisting = schemaTsCols[table];
        if (tsColsExisting && tsColsExisting.size > 0) {
          let fixed = 0;
          for (const col of tsColsExisting) {
            // rowid AS rid：SQLite 整数主键别名 rowid 会被 node:sqlite 映射为 id，
            // 显式别名保证拿到 rowid（TEXT PK 表也适用）。
            const bad = db
              .prepare(`SELECT rowid AS rid FROM "${table}" WHERE typeof("${col}") = 'text' AND "${col}" IS NOT NULL`)
              .all() as Array<{ rid: number }>;
            for (const r of bad) {
              const v = db.prepare(`SELECT "${col}" AS v FROM "${table}" WHERE rowid = ?`).get(r.rid) as { v: string };
              const sec = toEpochSeconds(v.v);
              if (typeof sec === "number") {
                db.prepare(`UPDATE "${table}" SET "${col}" = ? WHERE rowid = ?`).run(sec, r.rid);
                fixed++;
              }
            }
          }
          if (fixed > 0) logs.push(`  ${table}: repaired ${fixed} text-timestamp rows`);
        }
        skipped++;
        continue;
      }

      const [rows] = await conn.query<Array<RowDataPacket>>("SELECT * FROM `" + table + "`");
      if (rows.length === 0) {
        logs.push(`  ${table}: 0 rows (empty source)`);
        continue;
      }
      const cols = Object.keys(rows[0]);
      const tsCols = schemaTsCols[table];
      const placeholders = cols.map(() => "?").join(",");
      const insertSql = `INSERT INTO "${table}" ("${cols.join('","')}") VALUES (${placeholders})`;
      const stmt = db.prepare(insertSql);
      db.exec("BEGIN");
      try {
        for (const row of rows) {
          const values = cols.map((c) => {
            let v = row[c];
            if (v === undefined || v === null) return null;
            if (tsCols && tsCols.has(c)) v = toEpochSeconds(v);
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
      const status = rows.length !== check.n ? " ⚠️ MISMATCH" : "";
      logs.push(`  ${table}: ${rows.length} rows imported (db=${check.n})${status}`);
      imported++;
    }
    logs.push(`bootstrap-import: DONE — ${tables.length} tables, imported ${imported}, skipped-with-data ${skipped}`);
    return logs;
  } finally {
    if (conn) await conn.end();
    db.close();
  }
}