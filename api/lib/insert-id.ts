/**
 * 统一读取 INSERT 的自增主键（单一事实源）
 *
 * 坑（2026-09-13 会话中心战况室事故）：本仓库跑在 node:sqlite 适配器上
 * （api/lib/node-sqlite-adapter.ts），`StatementSync.run()` 返回的是
 * `{ changes, lastInsertRowid }`，**没有 `insertId`**。历史代码普遍写
 * `(result as any).insertId`——拿到 undefined，于是「数据已落库但调用方以为
 * 没建成」，静默丢 id、跳过后续广播/写入，非常难查（本次就踩了）。
 *
 * 兼容两种形态：better-sqlite3 生态里 lastInsertRowid 是主，insertId 是
 * mysql2 迁移遗留的兜底。0 / 负数视为无效（无自增结果）。
 */
export interface InsertResultLike {
  readonly lastInsertRowid?: number | bigint;
  readonly insertId?: number;
}

/** 返回自增主键；无有效值时返回 0（调用方按 0 判空）。 */
export function getInsertId(result: unknown): number {
  if (result === null || result === undefined) return 0;
  const r = result as InsertResultLike;
  if (typeof r.lastInsertRowid === "number" || typeof r.lastInsertRowid === "bigint") {
    const id = Number(r.lastInsertRowid);
    if (Number.isFinite(id) && id > 0) return id;
  }
  if (typeof r.insertId === "number" && Number.isFinite(r.insertId) && r.insertId > 0) {
    return r.insertId;
  }
  return 0;
}

/**
 * 统一读取 UPDATE/DELETE 的受影响行数（单一事实源）。
 *
 * 同一个迁移坑的另一半：node:sqlite 返回 `changes`，历史代码读 `affectedRows`。
 * 更阴险的是它的失败方式——`Number((r as any).affectedRows)` 得到 **NaN**，
 * 而 `NaN !== 1` 恒为真，于是「受影响行数必须等于 1」这类 CAS 守卫
 * **永远抛错**：制品封存恒报 stale_state、beidou 状态变更恒报 CONFLICT。
 *
 * 所以本函数**绝不返回 NaN**：无法识别形状时返回 0，让守卫走到
 * 「0 !== 1 → 抛错」这条明确、可诊断的分支。
 */
export function getAffectedRows(result: unknown): number {
  if (result === null || result === undefined) return 0;
  const r = result as { readonly changes?: unknown; readonly affectedRows?: unknown };
  // changes 优先：真实驱动是 node:sqlite，affectedRows 只是 mysql2 兼容兜底
  if (typeof r.changes === "number" && Number.isFinite(r.changes)) return r.changes;
  if (typeof r.changes === "bigint") return Number(r.changes);
  if (typeof r.affectedRows === "number" && Number.isFinite(r.affectedRows)) return r.affectedRows;
  return 0;
}
