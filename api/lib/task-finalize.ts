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
import { syncTaskMemoryToXuanji, syncTaskLessonToXuanji, type CompletedTaskView, type Db } from "./xuanji-sync";
import { syncTaskArtifactsToAlist } from "./alist-sync";
import { notifyLessonRecorded } from "./notification-hooks";
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

/**
 * 失败/取消/超时的**统一终态动作**（与完成路径对称）。所有把任务推进到
 * "失败类终态"的路径都必须经由这里，不要在调用点自己拼装动作——历史上正是
 * 三处各写各的，导致动作集不一致：
 *   - 超时 sweeper 只做"教训 + 通知"，漏了产物归档与协作父任务汇总；
 *   - MCP cancel_task 只把 status 写成 failed，**什么归档都不做**；
 * 后果不是"少写日志"而是功能缺口：被取消/超时的协作子任务永远不触发父任务汇总
 * （要等其它兄弟完成），取消任务的教训也不进记忆、检索不到。
 *
 * 各步骤各自 catch，单个接收端失败不阻断其余步骤，也绝不影响终态写入本身。
 *
 * @param options.errorChannel 通知里标注的失败挂点（如 lifecycle.sweeper / mcp.cancel）
 * @param options.errorText 覆盖展示/归档用的失败原因（超时是编排层推断出来的文案，
 *   任务行的 error 字段可能为空，所以允许调用方显式给）
 */
export async function finalizeFailedTask(
  db: Db,
  task: FinalizeTaskView,
  options: { readonly errorChannel?: string; readonly errorText?: string | null } = {},
): Promise<void> {
  const errorText = options.errorText ?? task.error ?? null;
  const view: FinalizeTaskView = { ...task, error: errorText };

  // 1) 璇玑记忆：失败教训入库（lesson kind，与成功记录走同一 writeTaskMemory
  //    但用独立 type=xuanji_lesson 幂等键，不污染成功归档）
  try {
    await syncTaskLessonToXuanji(db, view);
  } catch (error) {
    console.warn(`[task-finalize] xuanji lesson sync failed for task ${task.taskId}: ${describeError(error)}`);
  }

  // 2) AList：失败任务通常无产物，但若用户在 taskArtifacts 留了"失败现场"附件仍归档
  try {
    await syncTaskArtifactsToAlist(db, view);
  } catch (error) {
    console.warn(`[task-finalize] alist artifact sync failed for task ${task.taskId}: ${describeError(error)}`);
  }

  // 3) 协作汇总（与完成路径同语义）
  try {
    await maybeSummarizeParent(db, view);
  } catch (error) {
    console.warn(`[task-finalize] parent collab summary failed for task ${task.taskId}: ${describeError(error)}`);
  }

  // 4) 失败教训通知（NC-3）：原先只有 sweeper 内联做，取消路径完全没有通知。
  //    recordNotification 自带 60s 防抖，同一任务多挂点重复触发不会刷屏。
  try {
    await notifyLessonRecorded(
      db,
      {
        id: task.id,
        taskId: task.taskId,
        name: task.name,
        // 无执行代理的任务传 null，交给通知层按"无归属即跳过"的既有设计处理。
        // 【纠正】这里原先沿用 sweeper 的哨兵值 0 并注释说"运行时没开 FK、生产能写进去"——
        // 生产实测证明那是错的：node:sqlite 的 enableForeignKeyConstraints **默认为 true**，
        // 用一个未设任何 PRAGMA 的新连接打开生产库，PRAGMA foreign_keys 报 1；生产
        // notifications.agent_id 也只有真实 agent（1 与 17），没有 0 行。
        // 也就是说 notifications.agent_id 是 NOT NULL + REFERENCES agents(id)，而 0 不是任何
        // 一行真实 agent ⇒ **每次插入都 FK 失败并被兜底 catch 吞掉**：51 个任务里 21 个没有
        // 执行代理，这些任务的失败教训通知一直在静默丢失（教训本身照常入璇玑，不受影响）。
        // 传 null 至少让它变成"按设计跳过"而不是"报错被吞"。
        // 真正的修法（未做，需产品决策）：给系统通知一个归属——要么新建"系统"agent 行，
        // 要么把 agent_id 改成可空（SQLite 不能直接改可空性，需重建表，属 §4 版本化迁移范畴）。
        agentId: task.agentId ?? null,
        error: errorText,
      },
      options.errorChannel ?? "task.failed",
    );
  } catch (error) {
    console.warn(`[task-finalize] lesson notification failed for task ${task.taskId}: ${describeError(error)}`);
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
