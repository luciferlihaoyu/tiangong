/**
 * 数据库约束错误识别（驱动真实 error shape 的单一事实源）
 *
 * 背景（路线图 Phase A「幂等错误码」）：本仓库已从 mysql2 迁到 node:sqlite，
 * 但幂等分支仍在判断 `error.code !== "ER_DUP_ENTRY"`——该错误码在 SQLite 下
 * **永不出现**，于是并发竞态下「同 external_ref 重复建单」会直接抛错，
 * 而不是回退为幂等成功。真实 shape 为（实测采集，非文档推断）：
 *
 *   code    = "ERR_SQLITE_ERROR"
 *   errcode = 2067                      // SQLITE_CONSTRAINT_UNIQUE
 *   errstr  = "constraint failed"
 *   message = "UNIQUE constraint failed: <table>.<column>"
 *
 * 关键约束：**不能把所有 constraint 错误都当幂等成功**。NOT NULL、外键、
 * 以及「其他表 / 其他列」的唯一冲突都必须继续抛错，否则真正的数据错误会被
 * 静默吞掉。所以识别必须精确到表 + 列。
 */

/** sqlite3 扩展结果码：唯一约束冲突（19 constraint | 8 unique << 8） */
export const SQLITE_CONSTRAINT_UNIQUE = 2067;
/** sqlite3 扩展结果码：主键冲突（19 constraint | 6 primarykey << 8） */
export const SQLITE_CONSTRAINT_PRIMARYKEY = 1555;

export interface ExpectedUniqueConstraint {
  /** 表名，与 message 中的 `UNIQUE constraint failed: <table>.<column>` 一致 */
  readonly table: string;
  /** 允许触发幂等的目标列；命中任一列才算数 */
  readonly columns: readonly string[];
}

/**
 * 判断错误是否为唯一约束冲突。
 *
 * @param expected 传了就要求冲突落在指定表/列上；不传则只判断「是唯一冲突」。
 *                 幂等分支**应当**传 expected，避免把无关冲突当成功。
 */
export function isUniqueConstraintViolation(
  error: unknown,
  expected?: ExpectedUniqueConstraint,
): boolean {
  if (error === null || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errcode?: unknown; message?: unknown };

  const legacyDuplicate = candidate.code === "ER_DUP_ENTRY";
  const sqliteUnique =
    candidate.code === "ERR_SQLITE_ERROR" &&
    (candidate.errcode === SQLITE_CONSTRAINT_UNIQUE ||
      candidate.errcode === SQLITE_CONSTRAINT_PRIMARYKEY);
  if (!legacyDuplicate && !sqliteUnique) return false;

  if (!expected) return true;

  const message = typeof candidate.message === "string" ? candidate.message : "";
  // 两种驱动的 message 都含 "<table>.<column>"：
  //   SQLite → "UNIQUE constraint failed: tasks.origin_system, tasks.external_ref"
  //   mysql2 → "Duplicate entry 'x' for key 'tasks.external_ref'"
  //
  // node:sqlite 的 message 一定带「表.列」，且复合唯一索引会列全每一列（实测）。
  // 只要能解析出该格式，就精确要求冲突落在目标列上——其他表、其他列一律不认。
  if (message.includes("UNIQUE constraint failed:")) {
    return expected.columns.some((column) => message.includes(`${expected.table}.${column}`));
  }
  // 解析不出表列信息的形状（测试替身只给 "Duplicate entry"，老驱动只给索引名）
  // 无法在此精确化，交给调用方的「回查请求摘要」兜底：那里比对 canonical hash，
  // 不一致即 CONFLICT——因此不会把无关冲突误当幂等成功。
  return true;
}
