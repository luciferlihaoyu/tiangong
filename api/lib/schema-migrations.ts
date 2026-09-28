/**
 * 版本化 schema 迁移（§4 残余：统一 schema/DDL/repair 的第三份机制）。
 *
 * 职责划分：
 *  - db/schema.ts + api/lib/ddl.ts：**建库形状**（CREATE TABLE/INDEX，从 schema 派生）；
 *  - schema-repair.ts：**对老库补列**（从 schema 派生，幂等）；
 *  - 本模块：**有状态的一次性迁移**——数据搬迁、列重建（配 api/lib/table-rebuild.ts）、
 *    无法用 ALTER 表达的结构变更。按名字记录在 `schema_migrations` 表，跑过就不再跑。
 *
 * boot/autoMigrate 在建表 + 补列之后调用 runSchemaMigrations。注册 API：
 *   registerSchemaMigration({ name, up(db, logs) })   // 模块加载时注册，按注册序执行
 *
 * 契约：每个迁移在自己的事务里执行（成功才记 name）；失败留待下次启动重试，
 * 失败名单会被 autoMigrate 收进 criticalFailures（readiness therefore 不接单）。
 * up 里拿到的是 node:sqlite DatabaseSync 原生连接（与 autoMigrate 同一连接，
 * 事务语义直用 SQL BEGIN/COMMIT）。
 */
import type { DatabaseSync } from "node:sqlite";

export interface RegisteredSchemaMigration {
  /** 稳定唯一名（如 "0002-notifications-system-agent"）；跑过的名字被跳过 */
  name: string;
  up: (db: DatabaseSync, logs: string[]) => void;
}

const registry: RegisteredSchemaMigration[] = [];

/** 模块加载期调用；同 name 重复注册视为配置错误立即抛出 */
export function registerSchemaMigration(m: RegisteredSchemaMigration): void {
  if (registry.some((x) => x.name === m.name)) {
    throw new Error(`duplicate schema migration name: ${m.name}`);
  }
  registry.push(m);
}

export function listRegisteredSchemaMigrations(): string[] {
  return registry.map((x) => x.name);
}

export interface SchemaMigrationRun {
  applied: string[];
  skipped: string[];
  failures: { name: string; error: string }[];
}

function ensureMigrationsTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
}

function appliedNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM schema_migrations").all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** 执行所有未应用的注册迁移；纯函数（直测可传入自建连接） */
export function runSchemaMigrations(
  db: DatabaseSync,
  logs: string[] = [],
): SchemaMigrationRun {
  const run: SchemaMigrationRun = { applied: [], skipped: [], failures: [] };
  if (registry.length === 0) return run;
  ensureMigrationsTable(db);
  const done = appliedNames(db);
  for (const m of registry) {
    if (done.has(m.name)) {
      run.skipped.push(m.name);
      continue;
    }
    try {
      db.exec("BEGIN");
      m.up(db, logs);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
        .run(m.name, Math.floor(Date.now() / 1000));
      db.exec("COMMIT");
      run.applied.push(m.name);
      logs.push(`schema-migration applied: ${m.name}`);
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* 无事务可回滚时忽略 */ }
      const message = e instanceof Error ? e.message : String(e);
      run.failures.push({ name: m.name, error: message.slice(0, 200) });
      logs.push(`schema-migration FAILED: ${m.name}: ${message.slice(0, 120)}`);
    }
  }
  return run;
}
