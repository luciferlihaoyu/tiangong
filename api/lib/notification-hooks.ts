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
