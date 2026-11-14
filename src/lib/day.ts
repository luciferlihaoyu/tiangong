/**
 * 本地日口径（2026-11-12 碧霄，随审计修复统一）：
 *
 * 后端按日聚合已统一为**本地日**（api/lib/day-sql.ts 的 'localtime'；容器 TZ=Asia/Shanghai），
 * 前端凡取「今天」「日期边界」也必须用本地日——原先两处各自手写
 * toISOString().slice(0,10)（UTC 日），北京时间 0~8 点会取到昨天，
 * 首页「今日成本」与用量页从此对不上。这里收敛成唯一实现，禁止再散抄。
 */

/** 本地时区的 YYYY-MM-DD（与后端 sqlDayOf 的 localtime 口径一致）。 */
export function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * 本地日的查询边界：[startOfDay, endOfDay]。
 * 不带 Z 后缀 → new Date() 按运行环境本地时区解释，与后端分组边界对齐
 * （usage.byDay 的 from/to 过滤原先带 Z，与本地日分组错开 8 小时，
 * 会漏掉本地今早 0~8 点的用量）。
 */
export function localDayRange(dayKey: string): { from: string; to: string } {
  return { from: `${dayKey}T00:00:00`, to: `${dayKey}T23:59:59.999` };
}
