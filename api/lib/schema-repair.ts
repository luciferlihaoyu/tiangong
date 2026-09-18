/**
 * 轻量 schema 修复：对已存在的 SQLite 表补齐缺失列（ALTER TABLE ADD COLUMN）。
 *
 * 背景（#61-S4c 事故 + Phase B 旧库升级）：da74c0d 部署在 volume 建出旧的 tasks
 * 表（缺 Phase 2 board_* 等 13 列）；autoMigrate 的 CREATE TABLE IF NOT EXISTS
 * 不会改已有表 → 数据在，查询报 no such column。
 *
 * 本模块原先有两个问题，都会让"下次加列"再次静默失效：
 *   1. 补列清单是**手写**的（只列了 13 个 tasks.board_*）。往 db/schema.ts
 *      加一列而忘了同步这里，生产就会在运行时炸，而本地测试全绿。
 *      → 现在改为**从 db/schema.ts 派生**（单一事实源）。
 *   2. 它只被 bootstrap-mysql-import 调用，而该函数对非 MySQL DSN 提前 return，
 *      于是原生 SQLite（当前生产形态）从来不补列。
 *      → 现在由 autoMigrate 在建表之后无条件调用。
 *
 * SQLite 对 ALTER TABLE ADD COLUMN 有硬限制（已实测确认）：
 *   - 不允许非常量默认值：`DEFAULT (unixepoch())` / `CURRENT_TIMESTAMP` 都会被拒；
 *   - 不允许无默认值的 NOT NULL 列；
 *   - 不能添加主键列。
 * 因此这里只做"能做的"，**其余一律明确上报**（skipped + 原因），绝不静默略过，
 * 也绝不用"降级成可空列"的方式蒙混过去（那会让库与 schema 语义不符）。
 */
import { DatabaseSync } from "node:sqlite";
import { SQLiteTable, getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@db/schema";

export interface SchemaRepairAdded {
  table: string;
  column: string;
  /** 实际执行的 DDL，便于人工核对 */
  ddl: string;
}

export interface SchemaRepairSkipped {
  table: string;
  column: string;
  reason: string;
}

export interface SchemaRepairResult {
  added: SchemaRepairAdded[];
  skipped: SchemaRepairSkipped[];
}

/** 常量默认值的 SQL 字面量渲染；非常量（SQL 表达式/未定义）返回 null */
function literalDefaultOf(value: unknown): string | null {
  if (typeof value === "string") return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return null;
}

type ColumnLike = {
  name: string;
  notNull: boolean;
  hasDefault: boolean;
  primaryKey?: boolean;
  default?: unknown;
  getSQLType: () => string;
};

/**
 * 修复指定 DB 的缺失列。
 *
 * 只做非破坏的补列；任何单列失败都记入 skipped 而不抛出，
 * 以便启动流程继续（调用方据此决定就绪状态）。
 */
export function repairMissingColumns(db: DatabaseSync): SchemaRepairResult {
  const added: SchemaRepairAdded[] = [];
  const skipped: SchemaRepairSkipped[] = [];

  // schema 导出的是各表具体类型的联合，instanceof 收窄为宽类型会触发 TS2677，
  // 故这里只断言"是 SQLite 表"，具体配置交给 getTableConfig。
  const tables = Object.values(schema as unknown as Record<string, unknown>).filter(
    (value) => value instanceof SQLiteTable,
  );

  for (const table of tables) {
    let config: ReturnType<typeof getTableConfig>;
    try {
      config = getTableConfig(table as never);
    } catch {
      continue;
    }
    const tableName = config.name;

    let existing: string[];
    try {
      existing = (db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>).map((c) => c.name);
    } catch {
      continue;
    }
    // 表不存在（autoMigrate 未建）→ 跳过，交给建表逻辑
    if (existing.length === 0) continue;

    // 表级复合主键的成员列也不能用 ADD COLUMN 补
    const compositePk = new Set<string>();
    for (const pk of (config as unknown as { primaryKeys?: Array<{ columns: Array<{ name: string }> }> }).primaryKeys ?? []) {
      for (const col of pk.columns) compositePk.add(col.name);
    }

    for (const rawColumn of config.columns) {
      const column = rawColumn as unknown as ColumnLike;
      if (existing.includes(column.name)) continue;

      if (column.primaryKey || compositePk.has(column.name)) {
        skipped.push({ table: tableName, column: column.name, reason: "主键列无法用 ALTER TABLE ADD COLUMN 添加" });
        continue;
      }

      const literal = literalDefaultOf(column.default);
      if (column.hasDefault && literal === null && column.default !== undefined) {
        skipped.push({
          table: tableName,
          column: column.name,
          reason: "默认值是 SQL 表达式（如 unixepoch()/CURRENT_TIMESTAMP），SQLite 拒绝 ADD COLUMN",
        });
        continue;
      }
      if (column.notNull && literal === null) {
        skipped.push({
          table: tableName,
          column: column.name,
          reason: "NOT NULL 且无可用的常量默认值（客户端默认值无法用于 ADD COLUMN）",
        });
        continue;
      }

      const notNullClause = column.notNull ? " NOT NULL" : "";
      const defaultClause = literal === null ? "" : ` DEFAULT ${literal}`;
      const ddl = `ALTER TABLE "${tableName}" ADD COLUMN "${column.name}" ${column.getSQLType()}${notNullClause}${defaultClause}`;
      try {
        db.exec(ddl);
        added.push({ table: tableName, column: column.name, ddl });
      } catch (error) {
        skipped.push({
          table: tableName,
          column: column.name,
          reason: `ADD COLUMN 失败: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return { added, skipped };
}

/** 把修复结果转成启动日志行 */
export function describeSchemaRepair(result: SchemaRepairResult): string[] {
  const logs: string[] = [];
  if (result.added.length === 0 && result.skipped.length === 0) {
    logs.push("schema-repair: 已与 db/schema.ts 对齐，无需补列");
    return logs;
  }
  for (const item of result.added) logs.push(`schema-repair: ${item.table} +${item.column}`);
  for (const item of result.skipped) {
    logs.push(`schema-repair: SKIPPED ${item.table}.${item.column} — ${item.reason}`);
  }
  return logs;
}
