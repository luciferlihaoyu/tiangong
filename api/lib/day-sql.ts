/**
 * 共享的 SQLite 日聚合表达式。
 *
 * 坑（2026-09-13 usage 页白屏事故）：SQLite 的 DATE()/DATETIME() 对裸数字输入
 * 按 Julian day number 解释而非 unix 秒，因此 DATE(整数秒时间戳) 恒返回 NULL。
 * token_usage.created_at 是 integer timestamp（unix 秒），任何直接 DATE(created_at)
 * 的聚合都会得到 date=NULL 分组，前端 date.slice() 直接崩。
 *
 * 兼容写法：先试 unixepoch 修饰符（整数秒，主流形态），再回退纯 DATE()（MySQL 迁移
 * 遗留的 ISO 文本可被直接解析）。两种历史形态都归一为 'YYYY-MM-DD'。
 *
 * 时区（2026-11-12 碧霄修正，实测 case）：DATE() 默认把 unixepoch 按 **UTC** 解释，
 * 而 ops-router 的「今日」用 setHours(0,0,0,0)（进程本地时区，容器 TZ=Asia/Shanghai），
 * 前端浏览器同样是本地时区——同一张表因此有两个分母：北京时间 0~8 点之间，UTC 日还是
 * 昨天，两边的「今日」直接差一天（实测 CST 04:00 的错误日聚合正是此形状）。
 * 统一按本地日聚合：'localtime' 跟随进程 TZ，与 TZ 环境变量保持一致。
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export function sqlDayOf(col: AnySQLiteColumn): SQL<string> {
  return sql<string>`COALESCE(DATE(${col}, 'unixepoch', 'localtime'), DATE(${col}, 'localtime'))`;
}
