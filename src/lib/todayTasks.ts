/**
 * 今日任务统计口径（碧霄 2026-02 定稿）：
 * 「今日任务」主数值 = 今天有动作（updatedAt 优先，缺省回退 createdAt）
 *   且状态仍活跃（pending / queued / running）的任务数。
 * done / failed 不计入主数值，只作为副标题口径返回（今日完成 / 今日失败）。
 * 禁止再用全量任务数为今日数据兜底——今天没任务就显示 0。
 */
export const ACTIVE_TASK_STATUSES = ["pending", "queued", "running"] as const;

export interface TodayTaskLike {
  status: string;
  updatedAt?: string | Date;
  createdAt?: string | Date;
}

export interface TodayTaskSummary {
  /** 今日活跃任务数（pending/queued/running），「今日任务」主数值 */
  active: number;
  /** 今日完成数，副标题口径 */
  done: number;
  /** 今日失败数，副标题口径 */
  failed: number;
}

function fallsOnSameDay(value: string | Date | undefined, now: Date): boolean {
  if (value === undefined || value === null || value === "") return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return d.toDateString() === now.toDateString();
}

export function summarizeTodayTasks(
  tasks: TodayTaskLike[],
  now: Date = new Date()
): TodayTaskSummary {
  const summary: TodayTaskSummary = { active: 0, done: 0, failed: 0 };
  for (const t of tasks) {
    if (!fallsOnSameDay(t.updatedAt ?? t.createdAt, now)) continue;
    if ((ACTIVE_TASK_STATUSES as readonly string[]).includes(t.status)) summary.active += 1;
    else if (t.status === "done") summary.done += 1;
    else if (t.status === "failed") summary.failed += 1;
  }
  return summary;
}
