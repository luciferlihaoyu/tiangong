import { Clock, Pause, Play, CheckCircle, AlertTriangle } from "lucide-react";

/**
 * 共享任务状态表（P-merge 方案 B）：
 * 原散落在 TaskCenter / TaskDetail 的两份 STATUS_CONFIG 收敛至此。
 * 内容与两处原实现逐字一致（label/color/bg/icon），避免视觉回归。
 * - TaskCenter：icon + label 一起用
 * - TaskDetail：只用 label/color/bg（多余字段类型上安全）
 */
export const TASK_STATUS_CONFIG: Record<
  string,
  { label: string; color: string; bg: string; icon: React.ReactNode }
> = {
  pending: { label: "待处理", color: "var(--text-muted)", bg: "rgba(180,200,255,0.03)", icon: <Clock size={12} /> },
  queued: { label: "已排队", color: "var(--accent-cyan)", bg: "rgba(74,158,255,0.08)", icon: <Pause size={12} /> },
  running: { label: "执行中", color: "var(--warning)", bg: "var(--accent-glow-gold)", icon: <Play size={12} /> },
  done: { label: "已完成", color: "var(--success)", bg: "rgba(76,175,125,0.08)", icon: <CheckCircle size={12} /> },
  failed: { label: "失败", color: "var(--accent-red)", bg: "var(--accent-glow-red)", icon: <AlertTriangle size={12} /> },
};

/**
 * 看板状态 → 生命周期状态的完整反向映射（2026-11-12 审计修复）。
 *
 * boardStatus 是看板 10 值（triage/backlog/todo/ready/running/review/blocked/done/failed/cancelled），
 * 顶栏筛选是生命周期 5 值（pending/queued/running/done/failed）。原实现只用单向
 * statusToBoardStatus 把 pending 翻成 backlog 去查后端，导致 triage/blocked/cancelled
 * 的任务在任何筛选项下都查不出来——新建任务默认就是 triage，选「待处理」反而
 * 看不见自己刚建的单。现在前端拉全量后按这张完整映射归类再筛。
 */
export const BOARD_TO_LIFECYCLE: Record<string, string> = {
  triage: "pending",
  backlog: "pending",
  blocked: "pending",
  todo: "queued",
  ready: "queued",
  running: "running",
  review: "running",
  done: "done",
  failed: "failed",
  cancelled: "failed",
};
