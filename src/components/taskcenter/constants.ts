/**
 * TaskCenter 共享常量 — 自 src/pages/TaskCenter.tsx 逐段搬迁（原 L84-120），行为保持。
 */

// A2A-lite v0.1: lifecycle status display
export const LIFECYCLE_LABELS: Record<string, string> = {
  created: "已创建",
  queued: "已排队",
  claimed: "已认领",
  dispatched: "已投递",
  accepted: "已接受",
  working: "工作中",
  awaiting_result: "等待结果",
  submitted: "已提交",
  reviewing: "审核中",
  completed: "已完成",
  failed: "已失败",
  timeout: "已超时",
  cancelled: "已取消",
};

export const PRIORITY_LABELS: Record<number, string> = {
  0: "普通",
  1: "低",
  2: "中",
  3: "高",
  4: "紧急",
  5: "最高",
};

export const AGENT_STATUS_COLORS: Record<string, string> = {
  online: "var(--success)",
  busy: "var(--warning)",
  idle: "var(--text-muted)",
};

export const AGENT_STATUS_LABELS: Record<string, string> = {
  online: "在线",
  busy: "忙碌",
  idle: "空闲",
};
