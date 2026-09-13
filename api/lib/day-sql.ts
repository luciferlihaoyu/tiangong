/**
 * 共享的 SQLite 日聚合表达式。
 *
 * 坑（2026-09-13 usage 页白屏事故）：SQLite 的 DATE()/DATETIME() 对裸数字输入
 * 按 Julian day number 解释而非 unix 秒，因此 DATE(整数秒时间戳) 恒返回 NULL。
 * token_usage.created_at 是 integer timestamp（unix 秒），任何直接 DATE(created_at)
 * 的聚合都会得到 date=NULL 分组，前端 date.slice() 直接崩。
 *
 * 兼容写法：先试文本形态（MySQL 迁移遗留的 ISO 文本可直接被 DATE() 解析），
 * 再回退 unixepoch 修饰符（整数秒）。两种历史形态都归一为 'YYYY-MM-DD'。
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export function sqlDayOf(col: AnySQLiteColumn): SQL<string> {
  return sql<string>`COALESCE(DATE(${col}), DATE(${col}, 'unixepoch'))`;
}
