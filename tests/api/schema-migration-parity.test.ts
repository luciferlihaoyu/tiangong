/**
 * Schema ↔ 迁移一致性守卫（2026-08-25 部署验收发现）
 *
 * 背景：线上 Zeabur 的数据库 schema 由启动时 autoMigrate（api/lib/auto-migrate.ts）
 * + migrateV2（api/lib/migrate-v2.ts）负责——两者都是硬编码 DDL 清单。
 * NC-1 给 db/schema.ts 加了 notifications 表，但两条迁移路径都没加对应
 * CREATE TABLE → 线上调 agent.notifications.* 必报 ER_NO_SUCH_TABLE。
 * workspaces 同样缺迁移（workspace-router 已挂载）。
 *
 * 本测试防止再次漂移：schema 里**被运行时引用的表**必须能被至少一条迁移路径建出来。
 *
 * 已知死表白名单：schema 定义了但运行时零引用，无需迁移（未来清理 schema 时删除）：
 *   agent_memories / external_agents / session_messages / shared_sessions
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/** 迁移死表白名单——schema 有定义但运行时无任何引用 */
const DEAD_SCHEMA_TABLES = new Set([
  "agent_memories",
  "external_agents",
  "session_messages",
  "shared_sessions",
]);

function extractSchemaTables(): string[] {
  const src = readFileSync(join(REPO_ROOT, "db", "schema.ts"), "utf-8");
  const names = new Set<string>();
  for (const m of src.matchAll(/mysqlTable\(\s*"(\w+)"/g)) names.add(m[1]!);
  return [...names].sort();
}

function extractMigratedTables(): Set<string> {
  const names = new Set<string>();
  for (const file of ["api/lib/auto-migrate.ts", "api/lib/migrate-v2.ts"]) {
    const src = readFileSync(join(REPO_ROOT, file), "utf-8");
    for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?/g)) {
      names.add(m[1]!);
    }
  }
  return names;
}

/** 活表判定：白名单死表之外的 schema 表都按"运行时引用"对待（保守——宁可多要求迁移） */
function isTableReferencedAtRuntime(table: string): boolean {
  return !DEAD_SCHEMA_TABLES.has(table);
}

describe("schema ↔ 迁移一致性（部署验收守卫）", () => {
  it("每张被运行时引用的 schema 表都有迁移路径可建", () => {
    const schemaTables = extractSchemaTables();
    const migrated = extractMigratedTables();

    expect(schemaTables.length).toBeGreaterThan(20);

    // 活表 = 非白名单死表。对每张活表，要求其名字出现在某条 CREATE TABLE 里，
    // 或在 migrate-v2 的 MIGRATIONS 列（ALTER 目标表必已存在）中出现过。
    const v2Src = readFileSync(join(REPO_ROOT, "api/lib/migrate-v2.ts"), "utf-8");
    const missing: string[] = [];
    for (const t of schemaTables) {
      if (!isTableReferencedAtRuntime(t)) continue;
      const inCreate = migrated.has(t);
      const inV2Alter = new RegExp(`table:\\s*"${t}"`).test(v2Src);
      if (!inCreate && !inV2Alter) missing.push(t);
    }
    expect(missing, "以下 schema 表没有任何迁移路径（线上会缺表）").toEqual([]);
  });

  it("notifications 表有完整 DDL：6 值枚举 + 双索引", () => {
    const autoSrc = readFileSync(join(REPO_ROOT, "api/lib/auto-migrate.ts"), "utf-8");
    expect(autoSrc).toContain("CREATE TABLE IF NOT EXISTS notifications");
    expect(autoSrc).toContain("'task_approved'");
    expect(autoSrc).toContain("idx_notifications_agent_read");
    expect(autoSrc).toContain("idx_notifications_created_at");
  });

  it("workspaces 表有 DDL（workspace-router 已挂载）", () => {
    const autoSrc = readFileSync(join(REPO_ROOT, "api/lib/auto-migrate.ts"), "utf-8");
    expect(autoSrc).toContain("CREATE TABLE IF NOT EXISTS workspaces");
  });
});
