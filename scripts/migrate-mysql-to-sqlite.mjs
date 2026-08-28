#!/usr/bin/env node
/**
 * S3 (PLAN_SQLITE_MIGRATION) — MySQL dump → SQLite 导入 + 行数对账
 *
 * 输入：`backups/mysql-dump/<table>.json` + `manifest.json`（S0 dump 产物）。
 * 输出：目标 SQLite 库（默认 `data/tiangong.db`，可用 --db 覆盖），
 *       逐表行数对账，import-report.txt。
 *
 * 关键决策：
 * 1. Schema 用 `api/lib/auto-migrate.ts` 提供的 autoMigrate(force) 重建；
 *    走 `npx tsx` 子进程（仓库已有 tsx，0 新增依赖）。
 * 2. 数据导入走 `node:sqlite` 原生 DatabaseSync，纯 ESM。
 * 3. 类型转换规则按 `db/schema.ts` 解析出的 `{table: timestampColSet}` 决定：
 *    - 命中 timestamp 列 + 字符串值 → Math.floor(Date.parse/1000) 转 epoch 秒
 *    - 其他列保持原值
 * 4. 幂等：默认跳过已非空表；--force 时整库重建（autoMigrate 内部 DROP+RECREATE）。
 *
 * 验证（按 PLAN S3）：
 *   node scripts/migrate-mysql-to-sqlite.mjs --dry-run
 *   node scripts/migrate-mysql-to-sqlite.mjs --db /tmp/tiangong-s3-test.db
 *   期望：48 表 MATCH，总 4934 行守恒。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

// ── 1. 参数解析 ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    db: null,
    dumpDir: null,
    dryRun: false,
    force: false,
    noRecreate: false,
    only: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") {
      args.db = argv[++i];
    } else if (a === "--dump-dir") {
      args.dumpDir = argv[++i];
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--no-recreate") {
      args.noRecreate = true;
    } else if (a === "--only") {
      args.only = argv[++i]?.split(",").map((s) => s.trim()).filter(Boolean) ?? null;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      console.error(`Unknown arg: ${a}`);
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/migrate-mysql-to-sqlite.mjs [options]

Options:
  --db <path>           Target SQLite file (default: data/tiangong.db)
  --dump-dir <path>     Dump directory (default: backups/mysql-dump)
  --dry-run             Print plan only, do not write to database
  --force               Drop and recreate schema via autoMigrate(force=true)
  --no-recreate         Skip autoMigrate even if db is empty (assume schema already exists)
  --only <t1,t2,...>    Only import these tables (comma-separated)
  --help, -h            Show this help

Exit codes:
  0  All 48 tables MATCH
  1  At least one MISMATCH
  2  Script error (missing dump, schema error, etc.)
`);
}

// ── 2. 路径与常量 ───────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DEFAULT_DUMP_DIR = path.join(REPO_ROOT, "backups", "mysql-dump");
const DEFAULT_DB = path.join(REPO_ROOT, "data", "tiangong.db");
const SCHEMA_FILE = path.join(REPO_ROOT, "db", "schema.ts");

// ── 3. 从 db/schema.ts 解析 timestamp 列集合 ────────────────────────────
/**
 * 解析 db/schema.ts：对每个 `sqliteTable("name", { ... })` 块，
 * 找出 `integer("col", { mode: "timestamp" })` 模式的列名，存为 Set。
 * 也顺便收 `text("col", { mode: "json" })` 备用（目前只有 notifications.metadata）。
 *
 * 用括号配对法抓 sqliteTable 函数体，比 AST 简单且不引入 ts 解析器。
 */
function parseSchemaTypes(schemaText) {
  const tables = {};
  const tableStartRe = /sqliteTable\(\s*"([\w_]+)"/g;
  let m;
  while ((m = tableStartRe.exec(schemaText)) !== null) {
    const tableName = m[1];
    // 找 sqliteTable 后第一个 {，再配对到深度 0
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

    // timestamp 集合
    const tsSet = new Set();
    const tsRe = /integer\(\s*"([\w_]+)"\s*,\s*\{\s*mode:\s*["']timestamp["']/g;
    let tm;
    while ((tm = tsRe.exec(body)) !== null) {
      tsSet.add(tm[1]);
    }

    // json 集合
    const jsonSet = new Set();
    const jsonRe = /text\(\s*"([\w_]+)"\s*,\s*\{\s*mode:\s*["']json["']/g;
    let jm;
    while ((jm = jsonRe.exec(body)) !== null) {
      jsonSet.add(jm[1]);
    }

    tables[tableName] = { timestamp: tsSet, json: jsonSet };
  }
  return tables;
}

// ── 4. 通过子进程调 autoMigrate(force) 重建 schema ────────────────────
function runAutoMigrate(targetDbPath, force) {
  // auto-migrate.ts 用 process.env.DATABASE_URL 定位 db；直传过去。
  // tsx -e 必须用相对路径（绝对路径在 -e 模式下解析失败），所以固定 cwd=REPO_ROOT。
  const inner = [
    "import { autoMigrate } from './api/lib/auto-migrate.ts';",
    "async function main() {",
    `  const logs = await autoMigrate(${force ? "true" : "false"});`,
    "  console.log('---AUTOMIGRATE_LOGS_BEGIN---');",
    "  for (const l of logs) console.log(l);",
    "  console.log('---AUTOMIGRATE_LOGS_END---');",
    "  console.log('AUTOMIGRATE_LOG_COUNT:' + logs.length);",
    "}",
    "main().catch((e) => {",
    "  console.error('AUTOMIGRATE_ERR:' + (e && e.message ? e.message : String(e)));",
    "  process.exit(1);",
    "});",
  ].join("\n");

  const r = spawnSync("npx", ["--no-install", "tsx", "-e", inner], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: targetDbPath },
    encoding: "utf-8",
    timeout: 90_000,
    maxBuffer: 32 * 1024 * 1024,
  });

  if (r.status !== 0) {
    console.error("autoMigrate child process failed (exit " + r.status + "):");
    if (r.stdout) console.error(r.stdout);
    if (r.stderr) console.error(r.stderr);
    throw new Error(`autoMigrate exited with code ${r.status}`);
  }

  // 解析子进程输出
  const lines = (r.stdout || "").split("\n");
  let inside = false;
  const logs = [];
  for (const line of lines) {
    if (line === "---AUTOMIGRATE_LOGS_BEGIN---") {
      inside = true;
      continue;
    }
    if (line === "---AUTOMIGRATE_LOGS_END---") {
      inside = false;
      continue;
    }
    if (inside) logs.push(line);
  }
  const countMatch = (r.stdout || "").match(/AUTOMIGRATE_LOG_COUNT:(\d+)/);
  const logCount = countMatch ? Number(countMatch[1]) : -1;
  return { logs, logCount, stdout: r.stdout };
}

// ── 5. 类型转换 ─────────────────────────────────────────────────────────
/**
 * 把 JSON dump 的值转换为 SQLite 接受的形式。
 *  - timestamp 列 + 字符串值：epoch 秒（Math.floor(Date.parse/1000)）
 *  - timestamp 列 + null：保持 null
 *  - timestamp 列 + 数字：保持原数字（dump 里偶有纯 epoch）
 *  - JSON 列：drizzle mode:json 期望 string|object；dump 都是 string，直接用
 *  - 其他：原样
 */
function convertValue(value, colName, tableType) {
  if (value === null || value === undefined) return null;
  if (tableType.timestamp.has(colName)) {
    if (typeof value === "string") {
      const ms = Date.parse(value);
      if (Number.isNaN(ms)) {
        throw new Error(`Invalid ISO datetime for column ${colName}: ${value}`);
      }
      return Math.floor(ms / 1000);
    }
    if (typeof value === "number") return value;
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
    return value;
  }
  if (tableType.json.has(colName)) {
    if (typeof value === "string") return value; // 已是 JSON 字符串
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }
  return value;
}

// ── 6. 主流程 ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }

  const dumpDir = path.resolve(args.dumpDir ?? DEFAULT_DUMP_DIR);
  const dbPath = path.resolve(args.db ?? DEFAULT_DB);
  const isDryRun = args.dryRun;
  const isForce = args.force;
  const isRecreate = !args.noRecreate;

  if (!existsSync(dumpDir)) {
    console.error(`Dump directory not found: ${dumpDir}`);
    return 2;
  }
  const manifestPath = path.join(dumpDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`manifest.json not found: ${manifestPath}`);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  console.log(`[s3] dump:    ${dumpDir}`);
  console.log(`[s3] db:      ${dbPath}`);
  console.log(`[s3] mode:    ${isDryRun ? "dry-run" : isForce ? "force-recreate" : "incremental"}`);
  console.log(`[s3] tables:  ${manifest.totalTables} (manifest totalRows=${manifest.totalRows})`);

  // 解析 schema
  const schemaText = readFileSync(SCHEMA_FILE, "utf-8");
  const tableTypes = parseSchemaTypes(schemaText);
  const schemaTableNames = Object.keys(tableTypes);
  const manifestTableNames = Object.keys(manifest.tables);

  // 校验：schema 与 manifest 一致
  const schemaSet = new Set(schemaTableNames);
  const manifestSet = new Set(manifestTableNames);
  const missingInSchema = [...manifestSet].filter((t) => !schemaSet.has(t));
  const missingInManifest = [...schemaSet].filter((t) => !manifestSet.has(t));
  if (missingInSchema.length) {
    console.warn(`[s3] WARN tables in dump but not in db/schema.ts: ${missingInSchema.join(", ")}`);
  }
  if (missingInManifest.length) {
    console.warn(`[s3] WARN tables in db/schema.ts but no dump: ${missingInManifest.join(", ")}`);
  }

  if (isDryRun) {
    // 干跑：只打计划
    let planSourceRows = 0;
    for (const [t, n] of Object.entries(manifest.tables)) {
      if (n > 0) planSourceRows += n;
      console.log(`[plan] ${t.padEnd(40)} source=${String(n).padStart(5)} ts=${tableTypes[t]?.timestamp.size ?? 0} json=${tableTypes[t]?.json.size ?? 0}`);
    }
    console.log(`[plan] non-empty tables: ${Object.values(manifest.tables).filter((n) => n > 0).length}/${manifest.totalTables}`);
    console.log(`[plan] planSourceRows: ${planSourceRows}`);
    console.log(`[plan] Would call: npx tsx -e \"autoMigrate(${isForce})\", DATABASE_URL=${dbPath}`);
    return 0;
  }

  // 真跑：建库/重建
  ensureParentDir(dbPath);
  const dbExists = existsSync(dbPath);
  if (isRecreate && (!dbExists || isForce)) {
    console.log(`[s3] running autoMigrate(${isForce}) to ${isForce ? "DROP+RECREATE" : "create"} schema at ${dbPath} ...`);
    const { logs } = runAutoMigrate(dbPath, isForce);
    const nonOk = logs.filter((l) => !/(OK|FORCE RECREATED|no-op|seeded)/.test(l));
    console.log(`[s3] autoMigrate done: ${logs.length} log lines, ${nonOk.length} unexpected entries.`);
    if (nonOk.length > 0 && nonOk.length <= 20) {
      for (const l of nonOk) console.log(`[s3]   autoMigrate: ${l}`);
    }
  } else {
    console.log(`[s3] skipping autoMigrate (db exists, no --force, no --no-recreate=false).`);
  }

  const db = new DatabaseSync(dbPath);
  // 与 auto-migrate 保持一致：开外键
  try {
    db.exec("PRAGMA foreign_keys = ON");
  } catch {
    /* ignore */
  }

  // 列出实际目标表
  const targetTables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  );
  // 排除 sqlite 内部表
  targetTables.delete("sqlite_sequence");

  const results = [];
  const tablesToProcess = args.only ?? manifestTableNames;
  let totalSource = 0;
  let totalImported = 0;
  let totalSourceRows = 0;
  let totalImportedRows = 0;

  for (const table of tablesToProcess) {
    const sourceCount = manifest.tables[table] ?? 0;
    totalSource += sourceCount;
    if (!targetTables.has(table)) {
      results.push({ table, source: sourceCount, imported: 0, status: "MISSING_TABLE" });
      console.error(`[s3] ${table}: MISSING_TABLE (not in target schema)`);
      continue;
    }

    const dumpFile = path.join(dumpDir, `${table}.json`);
    if (!existsSync(dumpFile)) {
      results.push({ table, source: sourceCount, imported: 0, status: "MISSING_DUMP_FILE" });
      console.error(`[s3] ${table}: MISSING_DUMP_FILE (${dumpFile})`);
      continue;
    }

    let rows = [];
    try {
      const raw = readFileSync(dumpFile, "utf-8");
      const trimmed = raw.trim();
      rows = trimmed === "" || trimmed === "[]" || trimmed === "null" ? [] : JSON.parse(trimmed);
    } catch (e) {
      results.push({ table, source: sourceCount, imported: 0, status: `JSON_PARSE_ERROR: ${e.message.slice(0, 60)}` });
      console.error(`[s3] ${table}: JSON_PARSE_ERROR (${e.message})`);
      continue;
    }

    // 实际 source 行数（与 manifest 交叉验证，差异要报）
    if (rows.length !== sourceCount) {
      console.warn(`[s3] ${table}: manifest says ${sourceCount} but file has ${rows.length} rows; using file count`);
    }
    const effectiveSource = rows.length;
    totalSourceRows += effectiveSource;

    if (effectiveSource === 0) {
      // 无需导入；记录 0
      const importedCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c);
      results.push({ table, source: 0, imported: importedCount, status: "EMPTY" });
      totalImported += importedCount;
      totalImportedRows += importedCount;
      console.log(`[s3] ${table.padEnd(40)} source=0  status=EMPTY  db_now=${importedCount}`);
      continue;
    }

    // 目标表已非空：默认跳过；--force 时清空
    const existing = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c);
    if (existing > 0 && !isForce) {
      results.push({ table, source: effectiveSource, imported: existing, status: "SKIPPED_NONEMPTY" });
      console.warn(`[s3] ${table}: SKIPPED (target has ${existing} rows, pass --force to overwrite)`);
      continue;
    }

    if (isForce && existing > 0) {
      db.exec(`DELETE FROM "${table}"`);
    }

    // 取目标表列（PRAGMA）
    const colInfo = db.prepare(`PRAGMA table_info("${table}")`).all();
    const targetCols = colInfo.map((c) => c.name);
    const colSet = new Set(targetCols);
    const tableType = tableTypes[table] ?? { timestamp: new Set(), json: new Set() };

    // 选 dump 中存在 + 目标存在的列（保持 dump 列序，方便人工对照）
    const cols = Object.keys(rows[0]).filter((c) => colSet.has(c));
    if (cols.length === 0) {
      results.push({ table, source: effectiveSource, imported: 0, status: "NO_MATCHING_COLUMNS" });
      console.error(`[s3] ${table}: NO_MATCHING_COLUMNS between dump and target`);
      continue;
    }

    const placeholders = cols.map(() => "?").join(",");
    const colList = cols.map((c) => `"${c}"`).join(",");
    const insertSql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`;

    // 大批 INSERT 走单事务
    const insertStmt = db.prepare(insertSql);
    let imported = 0;
    const failed = [];
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const params = cols.map((c) => convertValue(row[c], c, tableType));
        try {
          insertStmt.run(...params);
          imported++;
        } catch (e) {
          failed.push({ row, err: e.message?.slice(0, 120) });
        }
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    if (failed.length > 0) {
      console.error(`[s3] ${table}: ${failed.length} row(s) failed; first: ${failed[0].err}`);
      if (failed.length > 0) {
        const firstRowJson = JSON.stringify(failed[0].row).slice(0, 200);
        console.error(`[s3]   first bad row sample: ${firstRowJson}`);
      }
    }

    // 对账
    const dbCount = Number(db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get().c);
    const status = dbCount === effectiveSource ? "MATCH" : "MISMATCH";
    results.push({ table, source: effectiveSource, imported: dbCount, status });
    totalImported += dbCount;
    totalImportedRows += dbCount;
    console.log(
      `[s3] ${table.padEnd(40)} source=${String(effectiveSource).padStart(5)}  imported=${String(dbCount).padStart(5)}  status=${status}${failed.length ? `  failed=${failed.length}` : ""}`
    );
  }

  // 收尾
  db.close();

  // 写报告
  const reportPath = path.join(dumpDir, "import-report.txt");
  const matchCount = results.filter((r) => r.status === "MATCH" || r.status === "EMPTY").length;
  const mismatchCount = results.filter((r) => r.status === "MISMATCH").length;
  const skippedCount = results.filter((r) => r.status === "SKIPPED_NONEMPTY").length;
  const errorCount = results.filter(
    (r) => r.status === "MISSING_TABLE" || r.status === "MISSING_DUMP_FILE" || r.status === "NO_MATCHING_COLUMNS" || r.status.startsWith("JSON_PARSE_ERROR")
  ).length;
  const lines = [
    `# MySQL dump → SQLite 导入报告 (S3)`,
    `generatedAt: ${new Date().toISOString()}`,
    `dumpDir:     ${dumpDir}`,
    `db:          ${dbPath}`,
    `mode:        ${isForce ? "force" : isDryRun ? "dry-run" : "incremental"}`,
    `manifestTotalRows: ${manifest.totalRows}`,
    `sourceTotalRows:   ${totalSourceRows}`,
    `importedTotalRows: ${totalImportedRows}`,
    "",
    "## 汇总",
    `MATCH:    ${matchCount}`,
    `MISMATCH: ${mismatchCount}`,
    `SKIPPED:  ${skippedCount}`,
    `ERROR:    ${errorCount}`,
    `TOTAL:    ${results.length}`,
    "",
    "## 逐表",
    "table                                   source  imported  status",
    ...results.map(
      (r) =>
        `${r.table.padEnd(40)} ${String(r.source).padStart(6)}  ${String(r.imported).padStart(8)}  ${r.status}`
    ),
    "",
  ];
  writeFileSync(reportPath, lines.join("\n"), "utf-8");
  console.log(`[s3] report: ${reportPath}`);
  console.log(
    `[s3] summary: MATCH=${matchCount} MISMATCH=${mismatchCount} SKIPPED=${skippedCount} ERROR=${errorCount}`
  );
  return mismatchCount + errorCount > 0 ? 1 : 0;
}

function ensureParentDir(p) {
  const parent = path.dirname(p);
  if (parent && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error("[s3] FATAL:", err.stack || err.message || err);
    process.exit(2);
  });
