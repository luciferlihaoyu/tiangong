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
import { env } from "./env";
import { resolveDbPath } from "../queries/connection";
import { repairMissingColumns } from "./schema-repair";

/**
 * 各表的 timestamp 列（mode:"timestamp"）静态清单。
 * 生成：node -e 括号配对法扫 db/schema.ts（2026-08-28 提取，47 表）。
 * 不用运行时反射原因：生产 dist/boot.js 是 esbuild bundle，getTableConfig
 * 列元数据在 bundle 后不可靠（本地 tsx 源码模式 verified 但 bundle 模式不
 * 工作——生产 9266902 部署 bootstrap 跑通但 repaired 0 就是此因）。静态
 * 常量 bundle 安全、确定性。schema 列变更时需同步此表（可用脚本重生成）。
 */
// AUTO-GENERATED from db/schema.ts — DO NOT EDIT BY HAND
const TIMESTAMP_COLS: Record<string, string[]> = {
  "agent_memories": ["created_at", "updated_at"],
  "agents": ["last_heartbeat", "created_at", "updated_at"],
  "artifact_registry": ["created_at", "updated_at"],
  "audit_events": ["created_at"],
  "connector_registry": ["created_at", "updated_at"],
  "conversations": ["archived_at", "created_at", "updated_at"],
  "departments": ["created_at", "updated_at"],
  "external_agents": ["last_heartbeat", "created_at", "updated_at"],
  "github_audit_log": ["created_at"],
  "github_integrations": ["created_at", "updated_at"],
  "github_pull_requests": ["approved_at", "merged_at", "created_at", "updated_at"],
  "github_repo_permissions": ["created_at", "updated_at"],
  "github_repos": ["created_at", "updated_at"],
  "high_cost_model_auth": ["expires_at", "created_at"],
  "mailbox_messages": ["created_at", "acknowledged_at", "replied_at", "resolved_at", "updated_at"],
  "mcp_api_keys": ["last_used_at", "created_at"],
  "mcp_audit_log": ["created_at"],
  "messages": ["read_at", "expires_at", "acked_at", "delivered_at", "created_at"],
  "model_allowlist": ["created_at"],
  "model_pricing": ["updated_at"],
  "notifications": ["read_at", "created_at"],
  "organizations": ["created_at", "updated_at"],
  "projects": ["created_at", "updated_at"],
  "sealed_artifact_descriptors": ["sealed_at", "retain_until"],
  "sealed_artifact_manifests": ["sealed_at"],
  "secret_vault_items": ["created_at", "updated_at"],
  "service_key_audit_log": ["created_at"],
  "session_messages": ["created_at"],
  "shared_sessions": ["created_at", "updated_at"],
  "staged_objects": ["created_at", "expires_at"],
  "system_settings": ["updated_at"],
  "systems": ["created_at", "updated_at"],
  "task_artifacts": ["created_at"],
  "task_dependencies": [],
  "task_execution_slots": ["acquired_at", "expires_at"],
  "task_messages": ["created_at"],
  "task_outbox_events": ["next_attempt_at", "first_attempt_at", "delivered_at", "dead_letter_at", "created_at", "updated_at"],
  "task_threads": ["created_at", "updated_at"],
  "tasks": ["claimed_at", "dispatched_at", "accepted_at", "completed_at", "failed_at", "timeout_at", "last_heartbeat_at", "worker_lease_expires_at", "cancel_requested_at", "cancel_acknowledged_at", "triaged_at", "backlogged_at", "ready_at", "review_at", "blocked_at", "task_retain_until", "idempotency_retain_until", "created_at", "updated_at"],
  "tiangong_artifact_limits": ["updated_at"],
  "tiangong_provider_identity": ["created_at"],
  "tiangong_service_keys": ["issued_at", "rotation_window_end", "revoked_at", "created_at", "updated_at"],
  "tiangong_task_limits": ["updated_at"],
  "tiangong_worker_leases": ["issued_at", "expires_at", "revoked_at"],
  "token_usage": ["started_at", "created_at"],
  "users": ["created_at", "updated_at", "last_sign_in_at"],
  "workspace_memberships": ["created_at", "updated_at"],
  "workspaces": ["created_at", "updated_at"],
};

/**
 * 把 MySQL datetime 值转 epoch 秒（number）。覆盖三种形态：
 *  - Date 对象（mysql2 默认把 DATETIME 转成 JS Date）：getTime()/1000
 *  - ISO 字符串（'2026-06-27T13:10:30.000Z'）：Date.parse 直接解析
 *  - 其他文本（'2026-08-24 05:30:00' 无 Z → 按 +08:00 解析；
 *    String(Date) 形如 'Mon Jun 27 2026 ...' → Date.parse 兜底）
 * 解析失败/非日期 → 返回原值。
 */
function toEpochSeconds(v: unknown): number | unknown {
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isNaN(ms) ? v : Math.floor(ms / 1000);
  }
  if (typeof v !== "string") return v;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(v)) {
    const ms = Date.parse(v.replace(" ", "T") + (v.includes("Z") ? "" : "+08:00"));
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  const fallback = Date.parse(v);
  if (!Number.isNaN(fallback)) return Math.floor(fallback / 1000);
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

  const schemaTsCols = TIMESTAMP_COLS;
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
        if (tsColsExisting && tsColsExisting.length > 0) {
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
            if (tsCols && tsCols.includes(c)) v = toEpochSeconds(v);
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