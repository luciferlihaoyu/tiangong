/**
 * 通知中心——失败教训已记录的快捷调用（NC-3）
 *
 * 6 失败教训挂点（task-runner 主路径 / catch / task-writeback / taskboard reject /
 * a2a fail/timeout / lifecycle sweeper）统一调这个 helper，避免每处重复拼装 payload。
 * 所有挂点主流程不变，失败仍写 xuanji_lesson artifact；通知仅多写一条 notifications
 * 行（60s 防抖自动去重同一任务在多个失败挂点间的重复通知）。
 */
import type { Db } from "./notification";
import { recordNotification } from "./notification";

export interface TaskForLessonNotify {
  id: number;
  taskId: string;
  name: string;
  agentId: number | null;
  error: string | null;
}

/**
 * 记一条 lesson_recorded 通知（尽力而为，recordNotification 自身永不抛错；
 * 调用方仍应包 try/catch 兜底，防御未来行为变化破坏失败主流程）。
 */
export async function notifyLessonRecorded(
  db: Db,
  task: TaskForLessonNotify,
  errorChannel: string
): Promise<void> {
  await recordNotification(db, {
    agentId: task.agentId,
    type: "lesson_recorded",
    taskId: task.id,
    title: `已记录失败教训：${task.name}`,
    body: `${errorChannel}：${(task.error ?? "未记录失败原因").slice(0, 200)}。可被 search_xuanji 检索命中。`,
    metadata: { taskKey: task.taskId, channel: errorChannel, error: (task.error ?? "").slice(0, 500) },
  });
}

/** 预算熔断通知的防抖窗口：24h（默认 60s 对预算通知太频繁——agent 每次认领轮询
 *  都会命中预算熔断，60s 窗口会被持续刷新导致刷屏；24h 一天至多一条） */
export const BUDGET_NOTIFY_DEDUP_WINDOW_MS = 86_400_000; // 24h

/** notifyBudgetExhausted 的最小 agent 视图（agents 行兼容，多余字段忽略） */
export interface BudgetExhaustedAgent {
  id: number;
  name?: string | null;
  budgetCents?: number | null;
  spentCents?: number | null;
}

/**
 * 预算熔断通知（NC-5）：agent 预算耗尽时记一条 budget_exhausted 通知。
 * 内部仍调 recordNotification，但用 24h 防抖窗口（windowMs 覆盖），
 * 预算恢复前同 agent 一天至多一条。尽力而为：失败绝不影响认领决策。
 */
export async function notifyBudgetExhausted(db: Db, agent: BudgetExhaustedAgent): Promise<void> {
  const budgetCents = agent.budgetCents ?? 0;
  const spentCents = agent.spentCents ?? 0;
  await recordNotification(db, {
    agentId: agent.id,
    type: "budget_exhausted",
    taskId: null,
    title: `预算已耗尽：Agent ${agent.name ?? agent.id} 暂停认领`,
    body: `预算 $${(budgetCents / 100).toFixed(2)} 已用完（已用 $${(spentCents / 100).toFixed(2)}）。预算恢复后自动恢复认领，无需人工介入。`,
    metadata: { budgetCents, spentCents },
    windowMs: BUDGET_NOTIFY_DEDUP_WINDOW_MS,
  });
}
