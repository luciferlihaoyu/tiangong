// 任务完成统一归档入口（finalize hook）
//
// 所有任务完成路径（内部 Runner、task.updateProgress、task.approve、
// taskboard.updateStatus、taskboard.approve、a2a.review）在 DB 更新为终态之后，
// 必须经由本 helper 触发归档接收端，禁止在调用点直接调用单个 sync——
// 钩子曾复制到六个调用点导致新增接收端时逐点手补、补漏（外部 dsh 路径漏传 AList）。
// 新增归档接收端（未来的通知、汇总等）只改本文件，六个调用点自动全覆盖。
//
// 非致命保证：两个 sync 自身已 catch 一切、绝不抛错；这里仍对每个 sync 单独
// 兜底 catch + warn，防御未来 sync 行为变化破坏完成路径，且单个接收端失败
// 不阻断其余接收端。幂等标记（task_artifacts type 检查）由各 sync 自持。
//
// 协作汇总（任务 1.3）：本任务是协作子任务且全部兄弟任务终态时，末尾触发
// autoSummarizeCollab 生成父任务汇总并双归档。多级 DAG 会链式向上
// （孙完成 → 子汇总 → finalize(子) → 触发父汇总 → finalize(父) → ……），
// 每层向上都要求新的 parentTaskId 非空，根任务的 parentTaskId 为 null 自然
// 终止；深度受 DAG 层数限制，无递归失控风险。

import { eq } from "drizzle-orm";
import { tasks } from "@db/schema";
import { syncTaskMemoryToXuanji, type CompletedTaskView, type Db } from "./xuanji-sync";
import { syncTaskArtifactsToAlist } from "./alist-sync";
import { autoSummarizeCollab } from "./task-validator";

/**
 * 完成视图可选携带 parentTaskId（协作子任务链式汇总用）。
 * 既有六个完成调用点不传该字段——不破坏其签名；缺省时 helper 内部用
 * 单次主键查询补齐（每次任务完成多一次 PK 查询，可接受，换取零调用点改动）。
 */
export type FinalizeTaskView = CompletedTaskView & Readonly<{ parentTaskId?: number | null }>;

/**
 * 任务完成后的统一归档入口：先写璇玑记忆，后上传 AList 产物（与原内部 Runner 行为一致），
 * 最后在适用时触发协作父任务汇总。永不抛错；调用方无需包裹 try/catch。
 */
export async function finalizeCompletedTask(db: Db, task: FinalizeTaskView): Promise<void> {
  // 1) 璇玑记忆：任务产出沉淀为长期记忆
  try {
    await syncTaskMemoryToXuanji(db, task);
  } catch (error) {
    console.warn(`[task-finalize] xuanji memory sync failed for task ${task.taskId}: ${describeError(error)}`);
  }

  // 2) AList：任务产物上传网盘（外部 dsh 完成路径曾在此断链）
  try {
    await syncTaskArtifactsToAlist(db, task);
  } catch (error) {
    console.warn(`[task-finalize] alist artifact sync failed for task ${task.taskId}: ${describeError(error)}`);
  }

  // 3) 协作汇总：本任务是协作子任务时，尝试汇总父任务（尚有兄弟未终态则内部 no-op）
  try {
    await maybeSummarizeParent(db, task);
  } catch (error) {
    // 汇总失败绝不影响完成路径：任务本身已完成归档，汇总可由下次兄弟任务完成或人工重试补齐
    console.warn(`[task-finalize] parent collab summary failed for task ${task.taskId}: ${describeError(error)}`);
  }
}

/** 若本任务是协作子任务，则触发父任务自动汇总；父任务缺失/未指定时静默 no-op。 */
async function maybeSummarizeParent(db: Db, task: FinalizeTaskView): Promise<void> {
  let parentTaskId: number | null | undefined = task.parentTaskId;
  if (parentTaskId === undefined) {
    // 调用点未携带 parentTaskId → 单次主键查询补齐（区分于显式 null = 确定无父任务）
    const row = await db
      .select({ parentTaskId: tasks.parentTaskId })
      .from(tasks)
      .where(eq(tasks.id, task.id))
      .then((rows) => rows[0]);
    parentTaskId = row?.parentTaskId ?? null;
  }
  if (parentTaskId === null || parentTaskId === undefined) return;
  await autoSummarizeCollab(parentTaskId);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
