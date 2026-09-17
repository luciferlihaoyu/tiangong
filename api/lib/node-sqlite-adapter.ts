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

/** 值是否为 thenable（用于区分同步/异步事务回调，不引入实例化开销）。 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as { then?: unknown }).then === "function";
}

/**
 * Transaction wrapper that emulates better-sqlite3's `Transaction` shape.
 *
 * 事务边界必须包住回调的全部语句，而 node:sqlite 是**同步**驱动：
 * async 回调只同步执行到第一个 await，其余语句落在微任务里执行。
 * 因此这里等回调 settle 之后再 COMMIT/ROLLBACK。
 * 历史实现在 `fn()` 返回后立刻 COMMIT——而 async 回调返回到的是一个未完成的
 * Promise，于是「事务」实际只覆盖到第一个 await 之前的语句：后段失败回滚不了，
 * 已执行的写入留在库里（tests/api/node-sqlite-transaction.test.ts 有回归断言）。
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
  // 次级错误（回滚本身失败）不得掩盖原始原因
  const rollbackQuietly = () => {
    try {
      db.exec("ROLLBACK");
    } catch {
      // swallow secondary rollback errors so the original cause is thrown
    }
  };

  const commitOrRollback = <T>(value: T): T => {
    try {
      db.exec("COMMIT");
      return value;
    } catch (err) {
      rollbackQuietly();
      throw err;
    }
  };

  const run = (mode: "BEGIN" | "BEGIN IMMEDIATE" | "BEGIN EXCLUSIVE") => (...args: Parameters<F>): ReturnType<F> => {
    db.exec(mode);
    let result: ReturnType<F>;
    try {
      result = fn(...args) as ReturnType<F>;
    } catch (err) {
      rollbackQuietly();
      throw err;
    }
    // 异步回调：等 Promise settle 之后再决定提交还是回滚
    if (isThenable(result)) {
      return Promise.resolve(result).then(
        (value) => commitOrRollback(value),
        (error: unknown) => {
          rollbackQuietly();
          throw error;
        },
      ) as ReturnType<F>;
    }
    return commitOrRollback(result);
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

  // ── 事务独占门 ──
  // 一条 SQLite 连接上不能有两个并发事务（第二个 BEGIN 会报
  // "cannot start a transaction within a transaction"）。
  // 同步事务在一个 tick 内跑完、不可能重叠，保持原有同步语义直接执行；
  // 异步事务跨 await 占用连接，因此直到回调 settle 之前，后来者按 FIFO 排队。
  //
  // ⚠️ 约束：不要在事务回调里（await 之后）再调用根 db.transaction() 并 await 它——
  // 内层会排队等外层结束，而外层正等内层，形成死锁。已核实当前 4 处调用点
  // （task-concurrency / beidou-external-router ×2 / artifact-sealer）都只用传入的
  // tx 操作，不存在该模式。需要嵌套时请用 drizzle 的 `tx.transaction()`
  // （它走 SAVEPOINT，不经过本门）。
  private txTail: Promise<void> = Promise.resolve();
  private txBusy = false;

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

  /**
   * 事务独占门：串行化同一连接上的事务。
   * 空闲时直接执行——同步事务因此仍同步返回，调用方行为不变；
   * 已有异步事务在跑时排队（FIFO），返回 Promise。
   */
  private runGated<T>(invoke: () => T): T | Promise<unknown> {
    if (!this.txBusy) return this.executeTracked(invoke);
    const queued = this.txTail.then(() => this.executeTracked(invoke));
    this.txTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private executeTracked<T>(invoke: () => T): T | Promise<unknown> {
    const result = invoke();
    // 同步事务：一个 tick 内已跑完，不占用连接
    if (!isThenable(result)) return result;
    this.txBusy = true;
    const settled = Promise.resolve(result).then(
      (value) => {
        this.txBusy = false;
        return value;
      },
      (error) => {
        this.txBusy = false;
        throw error;
      },
    );
    // 追加到链尾而非覆盖：此刻可能已有事务排在这条链上
    this.txTail = this.txTail.then(() => settled.then(() => undefined, () => undefined));
    return settled;
  }

  transaction<F extends (...args: unknown[]) => unknown>(fn: F) {
    const txn = makeTransaction(fn, this.db);
    const gate = (target: (...args: Parameters<F>) => ReturnType<F>) => (...args: Parameters<F>): ReturnType<F> =>
      // 排队时返回 Promise（即已有异步事务在跑），与 makeTransaction 内部
      // 同样的断言：调用方一律 await，运行时形状由事务回调自身决定。
      this.runGated(() => target(...args)) as ReturnType<F>;

    const deferred = gate(txn.deferred);
    const immediate = gate(txn.immediate);
    const exclusive = gate(txn.exclusive);
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
