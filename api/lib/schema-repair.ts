/**
 * 轻量 schema 修复：对已存在的 SQLite 表补齐缺失列（ALTER TABLE ADD COLUMN）。
 *
 * 背景（#61-S4c）：da74c0d 部署在 volume 建出旧的 tasks 表（缺 Phase 2
 * board_* 等 13 列）；后续 autoMigrate 的 CREATE TABLE IF NOT EXISTS 不会
 * 改已有表 → 数据能导入但查询报 no such column。本模块启动时（autoMigrate
 * 之后、bootstrap 导入之前）对关键表做列对齐。
 *
 * 只做"补列"（非破坏）：缺列 → ALTER TABLE ADD COLUMN <name> <type>。
 * SQLite ALTER ADD COLUMN 仅支持可空或有默认值的列；这里补的列都满足。
 */
import { DatabaseSync } from "node:sqlite";

type ColDef = Readonly<{ name: string; type: string; tail: string }>;

/** 各表缺失列的修复清单（与 db/schema.ts 对齐；当前只 tasks 有历史缺列） */
const REPAIRS: Record<string, ColDef[]> = {
  tasks: [
    { name: "board_status", type: "TEXT", tail: "DEFAULT 'triage'" },
    { name: "board_labels", type: "TEXT", tail: "" },
    { name: "board_notes", type: "TEXT", tail: "" },
    { name: "source_url", type: "TEXT", tail: "" },
    { name: "last_heartbeat_at", type: "INTEGER", tail: "" },
    { name: "heartbeat_interval_ms", type: "INTEGER", tail: "DEFAULT 300000" },
    { name: "reviewer_id", type: "INTEGER", tail: "" },
    { name: "review_result", type: "TEXT", tail: "" },
    { name: "triaged_at", type: "INTEGER", tail: "" },
    { name: "backlogged_at", type: "INTEGER", tail: "" },
    { name: "ready_at", type: "INTEGER", tail: "" },
    { name: "review_at", type: "INTEGER", tail: "" },
    { name: "blocked_at", type: "INTEGER", tail: "" },
  ],
};

/**
 * 修复指定 DB 文件的缺失列。
 * @returns 各表的补列日志。
 */
export function repairMissingColumns(db: DatabaseSync): string[] {
  const logs: string[] = [];
  for (const [table, cols] of Object.entries(REPAIRS)) {
    let existing: string[] = [];
    try {
      existing = (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);
    } catch {
      continue; // 表不存在（autoMigrate 未建）→ 跳过
    }
    const missing = cols.filter((c) => !existing.includes(c.name));
    if (missing.length === 0) continue;
    for (const c of missing) {
      const ddl = `ALTER TABLE "${table}" ADD COLUMN "${c.name}" ${c.type} ${c.tail}`.trim();
      try {
        db.exec(ddl);
        logs.push(`schema-repair: ${table} +${c.name} (${c.type})`);
      } catch (e) {
        logs.push(`schema-repair: ${table} +${c.name} FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return logs;
}
