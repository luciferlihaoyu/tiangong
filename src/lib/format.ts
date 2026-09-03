/**
 * 共享格式化工具（P-merge 方案 B）：
 * 原散落在 TaskCenter / MissionLog / TaskDetail 等页面的 fmtTime 收敛至此。
 * 行为与各页面原实现逐字一致（YYYY-MM-DD HH:mm），避免视觉回归。
 */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
