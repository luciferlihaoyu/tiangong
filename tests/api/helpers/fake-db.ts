/**
 * In-memory fake for `api/queries/connection` (drizzle mysql2).
 *
 * Implements just enough of the drizzle query surface used by the Beidou
 * service-principal code paths (Todo 20):
 *   - select().from(t).where(cond)[.orderBy(...)][.limit(n)]
 *   - select({ col: t.col }).from(t).where(cond)
 *   - insert(t).values(row)
 *   - update(t).set(patch).where(cond)
 *   - delete(t).where(cond)
 *
 * Conditions are evaluated by introspecting the drizzle `SQL` chunk tree
 * produced by `eq` / `and` / `like` (chunk pattern: string chunks, column
 * objects with `.name` + `.table`, `Param` objects with `.value`, nested SQL
 * for `and`/`or`). No real SQL is ever executed.
 *
 * Rows are stored per table (keyed by the drizzle `Symbol(drizzle:Name)`
 * table name). Autoincrement `id` columns are assigned when absent.
 */

import * as schema from "@db/schema";

export type FakeDbRow = Record<string, unknown>;

type Token =
  | { kind: "str"; value: string }
  | { kind: "col"; name: string }
  | { kind: "val"; value: unknown };

const TABLE_NAME = Symbol.for("drizzle:Name");

function tableName(table: unknown): string {
  const name = (table as Record<symbol, unknown>)[TABLE_NAME];
  if (typeof name === "string") return name;
  throw new Error(`fake-db: cannot resolve table name for ${String(table)}`);
}

function isColumn(chunk: unknown): chunk is { name: string; table: unknown } {
  return (
    typeof chunk === "object" &&
    chunk !== null &&
    typeof (chunk as { name?: unknown }).name === "string" &&
    (chunk as { table?: unknown }).table !== undefined
  );
}

function flattenTokens(sql: unknown): Token[] {
  const out: Token[] = [];
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (node.trim().length > 0) out.push({ kind: "str", value: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.queryChunks)) {
      for (const chunk of obj.queryChunks as unknown[]) visit(chunk);
      return;
    }
    if (isColumn(node)) {
      out.push({ kind: "col", name: node.name });
      return;
    }
    // drizzle StringChunk: { value: string[] } — treat as text token.
    // (Shape-based detection: constructor names can change under bundling.)
    if (
      Array.isArray(obj.value) &&
      obj.value.length > 0 &&
      typeof obj.value[0] === "string"
    ) {
      const text = obj.value[0];
      if (text.trim().length > 0) out.push({ kind: "str", value: text });
      return;
    }
    if ("value" in obj) {
      out.push({ kind: "val", value: obj.value });
      return;
    }
    throw new Error(`fake-db: unsupported SQL chunk ${String(node)}`);
  };
  visit(sql);
  return out;
}

function likeMatch(actual: unknown, pattern: string): boolean {
  const needle = pattern.replace(/^%/, "").replace(/%$/, "");
  return String(actual ?? "").includes(needle);
}

/**
 * Recursive-descent evaluation over flattened condition tokens.
 * Handles: [col op val] triples, parentheses, `and` / `or` combinators.
 */
function evalTokens(tokens: Token[], row: FakeDbRow): boolean {
  let idx = 0;

  const peekStr = (): string | null => {
    const t = tokens[idx];
    return t && t.kind === "str" ? t.value.trim() : null;
  };

  const parseTerm = (): boolean => {
    const t = tokens[idx];
    if (t && t.kind === "str" && t.value.trim() === "(") {
      idx++;
      const inner = parseOr();
      if (tokens[idx]?.kind === "str" && tokens[idx].value.trim() === ")") idx++;
      return inner;
    }
    // Expect: col op val
    const col = tokens[idx];
    if (!col || col.kind !== "col") {
      throw new Error(`fake-db: expected column token, got ${JSON.stringify(tokens[idx])}`);
    }
    idx++;
    const op = peekStr();
    if (!op) throw new Error("fake-db: expected operator token");
    const opLower = op.toLowerCase();
    // isNull / isNotNull 无值 token，须在读取 value 之前判断（大小写不敏感：
    // drizzle isNull() 产小写，raw sql`... IS NULL` 产大写，都能识别）。
    if (opLower === "is null" || opLower === "is not null") {
      idx++;
      const actual = row[col.name];
      return opLower === "is null" ? actual === null : actual !== null;
    }
    idx++;
    const val = tokens[idx];
    // drizzle passes `like` patterns as a raw string chunk (not a Param).
    const value = val?.kind === "val" ? val.value : val?.kind === "str" ? val.value : undefined;
    if (value === undefined) throw new Error("fake-db: expected value token");
    idx++;
    const actual = row[col.name];
    switch (op) {
      case "=":
      case "==":
        return actual === value;
      case "!=":
        return actual !== value;
      case "like":
        return likeMatch(actual, String(value));
      case "<":
        return (actual as number) < (value as number);
      case ">":
        return (actual as number) > (value as number);
      case "<=":
        return (actual as number) <= (value as number);
      case ">=":
        return (actual as number) >= (value as number);
      case "is":
        return value === null ? actual === null : false;
      default:
        throw new Error(`fake-db: unsupported operator "${op}"`);
    }
  };

  const parseAnd = (): boolean => {
    let result = parseTerm();
    for (;;) {
      const next = peekStr();
      if (next === "and") {
        idx++;
        // 先求值再组合：即使左侧已决定结果，也必须消费右侧 token，
        // 否则解析位置错乱（短路求值会让后续条件被静默丢弃）。
        const rhs = parseTerm();
        result = result && rhs;
      } else {
        break;
      }
    }
    return result;
  };

  const parseOr = (): boolean => {
    let result = parseAnd();
    for (;;) {
      const next = peekStr();
      if (next === "or") {
        idx++;
        const rhs = parseAnd();
        result = result || rhs;
      } else {
        break;
      }
    }
    return result;
  };

  return parseOr();
}

function evaluate(cond: unknown, row: FakeDbRow): boolean {
  if (cond === undefined) return true;
  return evalTokens(flattenTokens(cond), row);
}

type SelectCols = Record<string, { name: string }>;

const COLUMNS = Symbol.for("drizzle:Columns");

type ColumnMap = { propToDb: Map<string, string>; dbToProp: Map<string, string> };

export class FakeDb {
  readonly tables = new Map<string, FakeDbRow[]>();
  readonly nextIds = new Map<string, number>();
  readonly tableObjects = new Map<string, unknown>();
  readonly columnMaps = new Map<string, ColumnMap>();
  private transactionTail: Promise<void> = Promise.resolve();
  private failInsertTable: string | null = null;

  register(table: unknown): void {
    const name = tableName(table);
    if (this.tables.has(name)) return;
    this.tables.set(name, []);
    this.nextIds.set(name, 1);
    this.tableObjects.set(name, table);
    const cols = (table as Record<symbol, Record<string, { name: string }>>)[COLUMNS] ?? {};
    const propToDb = new Map<string, string>();
    const dbToProp = new Map<string, string>();
    for (const [prop, col] of Object.entries(cols)) {
      propToDb.set(prop, col.name);
      dbToProp.set(col.name, prop);
    }
    this.columnMaps.set(name, { propToDb, dbToProp });
  }

  private columnMapOf(table: unknown): ColumnMap {
    this.register(table);
    return this.columnMaps.get(tableName(table))!;
  }

  /** Property-named row → db-named row (as stored). */
  private toDbRow(table: unknown, row: FakeDbRow): FakeDbRow {
    const { propToDb } = this.columnMapOf(table);
    const out: FakeDbRow = {};
    for (const [prop, value] of Object.entries(row)) {
      out[propToDb.get(prop) ?? prop] = value;
    }
    return out;
  }

  /** Db-named row (stored) → property-named row (as drizzle returns). */
  private fromDbRow(table: unknown, row: FakeDbRow): FakeDbRow {
    const { dbToProp } = this.columnMapOf(table);
    const out: FakeDbRow = {};
    for (const [dbName, value] of Object.entries(row)) {
      out[dbToProp.get(dbName) ?? dbName] = value;
    }
    return out;
  }

  private rowsOf(table: unknown): FakeDbRow[] {
    const name = tableName(table);
    this.register(table);
    return this.tables.get(name)!;
  }

  select(projection?: SelectCols) {
    return {
      from: (table: unknown) => {
        const rows = this.rowsOf(table);
        let filtered = rows.filter(() => true);
        let limit: number | null = null;
        const applyProjection = (r: FakeDbRow): FakeDbRow => {
          if (!projection) return r;
          const out: FakeDbRow = {};
          for (const [alias, col] of Object.entries(projection)) {
            out[alias] = r[col.name];
          }
          return out;
        };
        const chain: Record<string, unknown> = {
          where: (cond: unknown) => {
            filtered = rows.filter((r) => evaluate(cond, r));
            return chain;
          },
          orderBy: () => chain,
          limit: (n: number) => {
            limit = n;
            return chain;
          },
          then: (
            resolve: (rows: FakeDbRow[]) => unknown,
            reject?: (err: unknown) => unknown,
          ) =>
            Promise.resolve(
              (limit === null ? filtered : filtered.slice(0, limit)).map(applyProjection),
            ).then(
              (mapped) => resolve(mapped.map((r) => this.fromDbRow(table, r))),
              reject,
            ),
          values: undefined,
        };
        return chain;
      },
    };
  }

  insert(table: unknown) {
    return {
      values: (row: FakeDbRow | FakeDbRow[]) => {
        const rows = Array.isArray(row) ? row : [row];
        const name = tableName(table);
        if (this.failInsertTable === name) {
          this.failInsertTable = null;
          return Promise.reject(new Error(`fake-db: forced insert failure for ${name}`));
        }
        this.register(table);
        const store = this.tables.get(name)!;
        const ids = this.nextIds.get(name)!;
        const inserted: FakeDbRow[] = [];
        for (const r of rows) {
          const copy: FakeDbRow = { ...this.toDbRow(table, r) };
          // 模拟 defaultNow()：表含 created_at 列且未显式传值时补当前时间
          // （通知中心防抖窗口按 createdAt 查询需要；对既有测试无影响——缺列时跳过）。
          const createdAtDbName = this.columnMaps.get(name)?.propToDb.get("createdAt");
          if (createdAtDbName && copy[createdAtDbName] === undefined) {
            copy[createdAtDbName] = new Date();
          }
          const duplicate = name === "tasks" && store.find((stored) =>
            stored.origin_system !== null && stored.origin_system !== undefined &&
            stored.origin_system === copy.origin_system &&
            (stored.external_ref === copy.external_ref || stored.idempotency_key === copy.idempotency_key)
          );
          const duplicateOutbox = name === "task_outbox_events" && store.find((stored) =>
            stored.task_id === copy.task_id && stored.state_revision === copy.state_revision
          );
          if (duplicate || duplicateOutbox) {
            const error = new Error("Duplicate entry") as Error & { code: string };
            error.code = "ER_DUP_ENTRY";
            throw error;
          }
          if (copy.id === undefined || copy.id === null) copy.id = ids;
          store.push(copy);
          inserted.push(copy);
          this.nextIds.set(name, ids + 1);
        }
        return Promise.resolve({ insertId: inserted[0]?.id, affectedRows: inserted.length });
      },
    };
  }

  transaction<T>(operation: (tx: FakeDb) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const tables = new Map(Array.from(this.tables, ([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
      const nextIds = new Map(this.nextIds);
      try {
        return await operation(this);
      } catch (error) {
        this.tables.clear();
        for (const [name, rows] of tables) this.tables.set(name, rows);
        this.nextIds.clear();
        for (const [name, id] of nextIds) this.nextIds.set(name, id);
        throw error;
      }
    };
    const result = this.transactionTail.then(run, run);
    this.transactionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  failNextInsert(table: unknown): void {
    this.failInsertTable = tableName(table);
  }

  update(table: unknown) {
    return {
      set: (patch: FakeDbRow) => ({
        where: (cond: unknown) => {
          const rows = this.rowsOf(table);
          const dbPatch = this.toDbRow(table, patch);
          let affectedRows = 0;
          for (const r of rows) {
            if (evaluate(cond, r)) {
              affectedRows++;
              Object.assign(r, dbPatch);
            }
          }
          return Promise.resolve({ affectedRows });
        },
      }),
    };
  }

  delete(table: unknown) {
    return {
      where: (cond: unknown) => {
        const rows = this.rowsOf(table);
        const kept = rows.filter((r) => !evaluate(cond, r));
        this.tables.set(tableName(table), kept);
        return Promise.resolve({ affectedRows: rows.length - kept.length });
      },
    };
  }

  reset(): void {
    for (const name of this.tables.keys()) {
      this.tables.set(name, []);
      this.nextIds.set(name, 1);
    }
  }

  /** Rows of a schema table (property-named), for assertions. */
  rowsOfTable(table: unknown): FakeDbRow[] {
    return this.rowsOf(table).map((r) => this.fromDbRow(table, r));
  }

  /** Rows by raw DB name (property-named), for audit/tests. */
  rowsByName(dbName: string): FakeDbRow[] {
    const table = this.tableObjects.get(dbName);
    if (!table) throw new Error(`fake-db: unknown table ${dbName}`);
    return this.rowsOfTable(table);
  }
}

/** Registry so `vi.mock` factories and tests share one instance per file. */
export const fakeDbRegistry: { instance: FakeDb | null } = { instance: null };

export function createFakeDb(): FakeDb {
  const db = new FakeDb();
  // Pre-register every schema table so ordering never matters.
  for (const table of Object.values(schema)) {
    const maybe = table as Record<symbol, unknown>;
    if (maybe && typeof maybe === "object" && maybe !== null && typeof maybe[TABLE_NAME] === "string") {
      db.register(table);
    }
  }
  return db;
}
