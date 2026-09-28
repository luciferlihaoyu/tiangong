/**
 * 从 db/schema.ts（drizzle）**运行时派生** SQLite DDL —— 单一事实源。
 *
 * §4 残余（版本化迁移统一）：此前建表 DDL 手写在 auto-migrate.ts（900+ 行 SQL），
 * 与 db/schema.ts 是两份并行定义——往 schema 加列/表而忘了同步 SQL，本地全绿、
 * 生产炸 no such column（#61-S4c 的根源之一）。schema-repair 的补列清单此前已从
 * schema 派生，缺的正是 CREATE TABLE/INDEX 本身这份；本模块把它也派生掉。
 *
 * 派生规则（每条都有黄金快照等价性测试背书，见 tests/api/schema-ddl-golden.test.ts；
 * 快照冻结自重写前的手写 SQL 在真实 SQLite 上实际建出的库结构）：
 *  - 列：name / 型别（getSQLType）/ PRIMARY KEY / NOT NULL / 列级 UNIQUE / 常量默认值。
 *  - NOT NULL 的整型时间戳列带 $defaultFn（应用层默认 `new Date()`）：渲染为
 *    `DEFAULT (unixepoch())`——手写 SQL 的既有合同（72/72 列逐一吻合，应用层默认
 *    照旧生效，SQL 层默认只兜底带外写入）。
 *  - 单列整型主键：渲染 `INTEGER PRIMARY KEY AUTOINCREMENT`（与手写 SQL 的 45 处
 *    一致；TEXT 主键/复合主键不加）。
 *  - CHECK：来自 schema.ts 第三参 check()（41 条已从手写 SQL 逐条搬入 db/schema.ts），
 *    去掉 drizzle 渲染出的 `"表名".` 列前缀以贴齐手写形态。
 *  - 外键：cfg.foreignKeys（inline .references() 由 drizzle 归并到这里）渲染成表级
 *    FOREIGN KEY 子句；当前全库仅 notifications 两处（agents/tasks，CASCADE）。
 *  - 索引：cfg.indexes（uniqueIndex 定义带 unique 标志）+ uniqueConstraints →
 *    CREATE [UNIQUE] INDEX。
 *  - 建表顺序：外键依赖拓扑排序（外键开启时被引用表必须先建），其余保持 schema
 *    导出顺序。
 */
import { SQLiteTable, getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";

const dialect = new SQLiteSyncDialect();

function sqlTextOf(expr: unknown): string {
  return dialect.sqlToQuery(expr as never).sql;
}

/** 常量默认值渲染；SQL 表达式走 dialect；无法识别返回 null（调用方决定是否兜底） */
function renderDefault(v: unknown, colType: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object" && typeof (v as { getSQL?: unknown }).getSQL === "function") {
    return sqlTextOf(v);
  }
  if (typeof v === "string") return `'${v.replace(/'/g, "''")}'`;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "bigint") return String(v);
  if (typeof v === "boolean") {
    // 整型列渲染 0/1（贴齐手写合同 DEFAULT 0）；文本列渲染 'true'/'false'
    return colType === "integer" ? (v ? "1" : "0") : v ? "'true'" : "'false'";
  }
  return null;
}

type AnyCol = {
  name: string;
  notNull: boolean;
  primary: boolean;
  isUnique: boolean;
  default?: unknown;
  defaultFn?: unknown;
  columnType: string;
  getSQLType: () => string;
};

export function generateColumnLines(table: SQLiteTable): string[] {
  const cfg = getTableConfig(table);
  const compositePkCols = new Set(
    (cfg.primaryKeys ?? []).flatMap((pk: { columns: { name: string }[] }) =>
      pk.columns.map((c) => c.name)),
  );
  return cfg.columns.map((raw) => {
    const c = raw as unknown as AnyCol;
    const parts: string[] = [`"${c.name}"`, c.getSQLType()];
    const isCompositePkMember = compositePkCols.has(c.name);
    if (c.primary && !isCompositePkMember) {
      parts.push("PRIMARY KEY", c.getSQLType() === "integer" ? "AUTOINCREMENT" : "");
    }
    if (c.isUnique) parts.push("UNIQUE");
    // 单列主键（整型=rowid 别名强制非空；TEXT=SQLite 遗留怪癖与现实合同都是
    // notnull=0）——手写合同一律不带显式 NOT NULL，这里贴齐；复合主键成员照常带。
    const isSinglePk = c.primary && !isCompositePkMember;
    if (c.notNull && !isSinglePk) parts.push("NOT NULL");
    if (c.default === undefined && c.defaultFn !== undefined && c.notNull
        && c.columnType === "SQLiteTimestamp") {
      parts.push("DEFAULT (unixepoch())");
    } else {
      const d = renderDefault(c.default, c.getSQLType());
      if (d !== null) parts.push(`DEFAULT ${d}`);
    }
    return parts.filter(Boolean).join(" ");
  });
}

export function generateForeignKeyLines(table: SQLiteTable): string[] {
  const cfg = getTableConfig(table);
  const lines: string[] = [];
  for (const fk of cfg.foreignKeys) {
    const ref = fk.reference();
    const target = getTableConfig(ref.foreignTable);
    const action = (fk as unknown as { onDelete?: string }).onDelete;
    lines.push(
      `FOREIGN KEY (${ref.columns.map((c: { name: string }) => `"${c.name}"`).join(", ")})`
      + ` REFERENCES "${target.name}" (${ref.foreignColumns.map((c: { name: string }) => `"${c.name}"`).join(", ")})`
      + (action ? ` ON DELETE ${action.toUpperCase()}` : ""),
    );
  }
  return lines;
}

export function generateCheckLines(table: SQLiteTable): string[] {
  const cfg = getTableConfig(table) as unknown as {
    name: string;
    checks?: { fn?: unknown; value?: unknown; sql?: unknown }[];
  };
  const prefix = `"${cfg.name}".`;
  return (cfg.checks ?? []).map((chk) => {
    const raw = sqlTextOf(chk.fn ?? chk.value ?? chk.sql);
    return `CHECK (${raw.split(prefix).join("")})`;
  });
}

/** 复合主键（primaryKey() 声明）单独成行；单列 PK 已在列行里 */
export function generatePrimaryKeyLines(table: SQLiteTable): string[] {
  const cfg = getTableConfig(table);
  return ((cfg.primaryKeys ?? []) as { columns: { name: string }[] }[])
    .map((pk) => `PRIMARY KEY (${pk.columns.map((c) => `"${c.name}"`).join(", ")})`);
}

export function generateTableDdl(table: SQLiteTable): string {
  const cfg = getTableConfig(table);
  const body = [
    ...generateColumnLines(table),
    ...generatePrimaryKeyLines(table),
    ...generateForeignKeyLines(table),
    ...generateCheckLines(table),
  ].join(",\n  ");
  // IF NOT EXISTS：与手写 SQL 相同的幂等语义（重跑/老库不重建）
  return `CREATE TABLE IF NOT EXISTS "${cfg.name}" (\n  ${body}\n)`;
}

export function generateTableIndexDdl(table: SQLiteTable): string[] {
  const cfg = getTableConfig(table) as unknown as {
    name: string;
    indexes?: { config: { name?: string; unique: boolean; columns: { name: string }[] } }[];
    uniqueConstraints?: { config: { name?: string; columns: { name: string }[] } }[];
  };
  const out: string[] = [];
  for (const idx of cfg.indexes ?? []) {
    const name = idx.config.name;
    if (!name) continue;
    const cols = idx.config.columns.map((c) => c.name);
    const unique = idx.config.unique ? "UNIQUE " : "";
    out.push(`CREATE ${unique}INDEX ${name} ON "${cfg.name}" (${cols.join(", ")})`);
  }
  for (const uq of cfg.uniqueConstraints ?? []) {
    const name = uq.config.name;
    if (!name) continue;
    const cols = uq.config.columns.map((c) => c.name);
    out.push(`CREATE UNIQUE INDEX ${name} ON "${cfg.name}" (${cols.join(", ")})`);
  }
  return out;
}

export function schemaTables(mod: Record<string, unknown>): SQLiteTable[] {
  return Object.values(mod).filter((v): v is SQLiteTable => v instanceof SQLiteTable);
}

/** 外键依赖拓扑排序；无外键约束保持 schema 导出顺序 */
export function topoSortTables(tables: SQLiteTable[]): SQLiteTable[] {
  const byName = new Map<string, SQLiteTable>();
  for (const t of tables) byName.set(getTableConfig(t).name, t);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const name = getTableConfig(t).name;
    const set = new Set<string>();
    for (const fk of getTableConfig(t).foreignKeys) {
      const target = getTableConfig(fk.reference().foreignTable).name;
      if (target !== name) set.add(target);
    }
    deps.set(name, set);
  }
  const ordered: SQLiteTable[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string): void => {
    const st = state.get(name);
    if (st === "done") return;
    if (st === "visiting") throw new Error(`foreign key cycle at ${name}`);
    state.set(name, "visiting");
    for (const dep of deps.get(name) ?? []) visit(dep);
    state.set(name, "done");
    const t = byName.get(name);
    if (t) ordered.push(t);
  };
  for (const t of tables) visit(getTableConfig(t).name);
  return ordered;
}

/**
 * 完整建库 DDL：拓扑序 [建表1, 表1索引..., 建表2, 表2索引...]。
 * 替代手写 CREATE_TABLES_SQL；消费方（autoMigrate / test-db helper）语义不变。
 */
export function generateAllDdl(mod: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const t of topoSortTables(schemaTables(mod))) {
    out.push(generateTableDdl(t));
    out.push(...generateTableIndexDdl(t));
  }
  return out;
}
