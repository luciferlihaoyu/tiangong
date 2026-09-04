/**
 * 共享格式化工具（P-merge 方案 B + P-cleanup）：
 * 原散落在 TaskCenter / MissionLog / TaskDetail / AgentDetail / AgentList /
 * MailboxPanel / EventStream / SessionPanel 等页面的 fmtTime 收敛至此。
 *
 * 行为与各页面原实现逐字一致，避免视觉回归。
 *  - fmtTime:     YYYY-MM-DD HH:mm
 *  - fmtTimeSec:  HH:mm:ss
 *  - fmtDateShort: MM-DD HH:mm
 *  - fmtTimeOrDash: 接受 null/undefined，空值返回 "—"
 */

const pad = (n: number) => n.toString().padStart(2, "0");

/** YYYY-MM-DD HH:mm；接受 null/undefined 时返回 "—"（AgentDetail/AgentList 等场景） */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** HH:mm:ss（实时事件流使用，强调秒级） */
export function fmtTimeSec(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** MM-DD HH:mm（会话列表等短格式）；null/undefined 返回 "—" */
export function fmtDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 同 fmtTime 行为，但参数可为 null/undefined（明确语义的别名） */
export const fmtTimeOrDash = fmtTime;
