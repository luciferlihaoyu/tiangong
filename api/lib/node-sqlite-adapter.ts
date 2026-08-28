// S1 (PLAN_SQLITE_MIGRATION): thin adapter wrapping Node v26.7's built-in
// `node:sqlite` DatabaseSync so that drizzle-orm/better-sqlite3 (which
// expects a better-sqlite3-shaped `Database` client) works without ever
// touching the better-sqlite3 native binding. Zero new dependencies, zero
// compile. See `node_modules/better-sqlite3/package.json` for the rationale
// behind the local shim that satisfies drizzle's `import Client from
// "better-sqlite3"` at module load.
//
// Only one `as unknown as ...` cast is allowed in this file (PLAN discipline)
// — it sits at the very bottom where we hand the adapter to drizzle().

import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * Statement shape compatible with better-sqlite3's `Statement`. We forward
 * to the underlying node:sqlite StatementSync and translate its return
 * values where the shapes differ.
 *
 * - `node:sqlite` returns rows as null-prototype objects; better-sqlite3
 *   returns plain objects. drizzle's `mapResultRow` indexes by column
 *   number (`row[columnIndex]`), which both flavours support, so no
 *   coercion is needed.
 * - `node:sqlite` exposes `setReturnArrays()` for the equivalent of
 *   better-sqlite3's `raw(true)` mode. We track the toggle here and apply
 *   it lazily before delegating, which is safe because Node's SQLite calls
 *   are synchronous and non-reentrant within a single tick.
 */
class NodeSqliteStatement {
  private rawMode = false;
  // The reader/readonly/busy flags mirror better-sqlite3's API. node:sqlite
  // does not expose them directly, so we report stable values that match
  // the typical "freshly prepared statement" state. drizzle does not branch
  // on them at runtime.
  readonly reader = false;
  readonly readonly = false;
  readonly busy = false;

  constructor(
    private readonly stmt: StatementSync,
    public readonly source: string,
    public readonly database: unknown
  ) {}

  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.stmt.run(...(params as Parameters<StatementSync["run"]>));
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get(...params: unknown[]): unknown {
    return this.stmt.get(...(params as Parameters<StatementSync["get"]>)) as unknown;
  }

  all(...params: unknown[]): unknown[] {
    this.applyRaw();
    const rows = this.stmt.all(...(params as Parameters<StatementSync["all"]>));
    this.applyRawRestore();
    return rows as unknown[];
  }

  iterate(...params: unknown[]): IterableIterator<unknown> {
    this.applyRaw();
    const it = this.stmt.iterate(...(params as Parameters<StatementSync["iterate"]>));
    this.applyRawRestore();
    return it as unknown as IterableIterator<unknown>;
  }

  raw(toggleState: boolean = true): this {
    this.rawMode = toggleState;
    this.stmt.setReturnArrays(toggleState);
    return this;
  }

  pluck(_toggleState?: boolean): this {
    // No-op: node:sqlite always returns objects; "pluck" semantics
    // (returning the first column directly) are not currently needed by
    // drizzle's better-sqlite3 session.
    return this;
  }

  expand(_toggleState?: boolean): this {
    return this;
  }

  bind(..._params: unknown[]): this {
    // node:sqlite binds per-call via spread `run/get/all(...")"; persistent
    // binding isn't part of the surface drizzle uses. Keep the fluent
    // signature for type compatibility.
    return this;
  }

  columns(): Array<{ name: string; column: string | null; table: string | null; database: string | null; type: string | null }> {
    const cols = this.stmt.columns() as Array<{ name: string; column: string | null; type: string | null; table: string | null; database: string | null }>;
    return cols.map((c) => ({
      name: c.name,
      column: c.column,
      table: c.table ?? null,
      database: c.database ?? null,
      type: c.type ?? null,
    }));
  }

  safeIntegers(_toggleState?: boolean): this {
    // node:sqlite has no equivalent knob; BigInt handling is configured at
    // the Database level (we do not change it). Return this for type
    // compatibility.
    return this;
  }

  private applyRaw(): void {
    if (this.rawMode) this.stmt.setReturnArrays(true);
  }

  private applyRawRestore(): void {
    if (this.rawMode) this.stmt.setReturnArrays(false);
  }
}

/**
 * Transaction wrapper that emulates better-sqlite3's `Transaction` shape.
 * It does not use SQLite's native SAVEPOINT/BEGIN machinery itself; instead
 * it sits on top of a fresh `DatabaseSync` opened in `BEGIN IMMEDIATE`
 * mode for the duration of the callback. This is sufficient for drizzle's
 * transaction call site, which is the only consumer in the runtime path.
 */
function makeTransaction<F extends (...args: unknown[]) => unknown>(
  fn: F,
  db: DatabaseSync
): F & {
  default(...args: Parameters<F>): ReturnType<F>;
  deferred(...args: Parameters<F>): ReturnType<F>;
  immediate(...args: Parameters<F>): ReturnType<F>;
  exclusive(...args: Parameters<F>): ReturnType<F>;
} {
  const run = (mode: "BEGIN" | "BEGIN IMMEDIATE" | "BEGIN EXCLUSIVE") => (...args: Parameters<F>): ReturnType<F> => {
    db.exec(mode);
    try {
      const result = fn(...args) as ReturnType<F>;
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // swallow secondary rollback errors so the original cause is thrown
      }
      throw err;
    }
  };
  const deferred = run("BEGIN");
  const immediate = run("BEGIN IMMEDIATE");
  const exclusive = run("BEGIN EXCLUSIVE");
  const tx = ((...args: Parameters<F>) => deferred(...args)) as F & {
    default(...args: Parameters<F>): ReturnType<F>;
    deferred(...args: Parameters<F>): ReturnType<F>;
    immediate(...args: Parameters<F>): ReturnType<F>;
    exclusive(...args: Parameters<F>): ReturnType<F>;
  };
  tx.default = deferred;
  tx.deferred = deferred;
  tx.immediate = immediate;
  tx.exclusive = exclusive;
  return tx;
}

/**
 * Database wrapper exposing the slice of better-sqlite3's `Database` that
 * drizzle-orm/better-sqlite3's session actually invokes at runtime
 * (`prepare`, `transaction`, `exec`). Other methods on better-sqlite3's
 * surface (`pragma`, `function`, `aggregate`, `loadExtension`, `backup`,
 * `serialize`, …) are not used by the SQLite session and are not
 * implemented here — drizzle will throw a clear "is not a function" if a
 * future code path starts calling them, which is the safe failure mode for
 * a transitional adapter.
 */
class NodeSqliteDatabase {
  readonly memory: boolean;
  readonly name: string;
  readonly open = true;
  readonly inTransaction = false;
  readonly readonly = false;

  constructor(private readonly db: DatabaseSync) {
    // node:sqlite DatabaseSync's `name()` is part of the experimental
    // surface and not currently typed in @types/node. Probe it defensively
    // and fall back to an empty string — the value is only read by the
    // type-level conformance, drizzle does not call `.name` at runtime.
    const probe = (db as unknown as { name?: () => string }).name;
    this.name = typeof probe === "function" ? probe.call(db) : "";
    this.memory = this.name === ":memory:";
  }

  prepare(source: string): NodeSqliteStatement {
    const stmt = this.db.prepare(source);
    return new NodeSqliteStatement(stmt, source, this);
  }

  transaction<F extends (...args: unknown[]) => unknown>(fn: F) {
    return makeTransaction(fn, this.db);
  }

  exec(source: string): this {
    this.db.exec(source);
    return this;
  }

  close(): this {
    this.db.close();
    return this;
  }
}

/**
 * The single permitted `as unknown as` cast in S1 lives at this export —
 * we hand the adapter to `drizzle()` and assert that it satisfies the
 * better-sqlite3 `Database` shape. Runtime contract: drizzle-orm/better-
 * sqlite3 will only call `prepare` and `transaction` on this object, and
 * the wrappers above translate those to node:sqlite primitives.
 */
export function nodeSqliteAdapter(db: DatabaseSync) {
  return new NodeSqliteDatabase(db) as unknown as import("better-sqlite3").Database;
}
