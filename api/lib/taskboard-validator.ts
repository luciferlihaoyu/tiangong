// 合法的状态流转
const VALID_TRANSITIONS: Record<string, string[]> = {
  triage: ["backlog", "cancelled"],
  backlog: ["todo", "triage", "cancelled"],
  todo: ["ready", "backlog", "cancelled"],
  ready: ["running", "blocked", "backlog", "cancelled"],
  running: ["review", "blocked", "failed", "cancelled"],
  review: ["done", "running", "blocked", "failed", "cancelled"],
  blocked: ["todo", "ready", "running", "cancelled"],
  done: [], // 终端状态
  failed: ["triage"], // 可以重新打开
  cancelled: [], // 终端状态
};

export function validateBoardTransition(from: string, to: string): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

const TERMINAL_STATUSES = ["done", "failed", "cancelled"];

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}
