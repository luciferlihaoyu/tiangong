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
