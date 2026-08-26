// api/lib/task-unified-router.ts
// 兼容层：把 taskRouter 和 taskboardRouter 的 procedure 合并到单一 router，
// 让 api/router.ts 在 `task.*` 和 `taskboard.*` 两个命名空间下挂同一组 procedure。
//
// 选型说明（PLAN t1 方案 C）：
// - tRPC 路由挂载是 router-level，不能 proc-level 选择性挂——单纯让两个名字挂同一
//   router 实例意味着 task 命名空间会失去 task-only 的 procs（dispatch/nextTaskId/
//   create/promote/delete/submitForReview）。
// - 也不能直接 mergeRouters：两个 router 都有 `list/dispatch/create/approve/reject`，
//   命名冲突无法 mergeWithoutOverrides。
// - 因此手动组合：taskboard 优先（更全面的 list/get/approve/reject/progress，行为对
//   前端管理视图更友好），task 独有的 procs 从 taskRouter 引入保持原行为。
//
// 副作用：
// - `task.approve` / `task.reject` / `task.updateProgress` / `task.list` /
//   `task.getById` 行为切到 taskboard 版本（更严格的入参/权限，例如 approve 变
//   adminQuery）；t2 负责迁移前端到 taskboard.*，本任务不删 task-router.ts。
// - `task.dispatch` / `task.create` 行为保留 task 版本（避免 taskboard 的差异逻辑
//   干扰 Agent 内部派发/创建路径）。

import { createRouter } from "../middleware";
import { taskRouter } from "../task-router";
import { taskboardRouter } from "../taskboard-router";

export const unifiedTaskRouter = createRouter({
  // ── taskboard 优先（list/get/approve/reject/progress）──
  list: taskboardRouter._def.procedures.list,
  getById: taskboardRouter._def.procedures.get,
  approve: taskboardRouter._def.procedures.approve,
  reject: taskboardRouter._def.procedures.reject,
  updateProgress: taskboardRouter._def.procedures.progress,
  // ── task 独有（taskboard 没有同义 procedure）──
  dispatch: taskRouter._def.procedures.dispatch,
  nextTaskId: taskRouter._def.procedures.nextTaskId,
  create: taskRouter._def.procedures.create,
  promote: taskRouter._def.procedures.promote,
  delete: taskRouter._def.procedures.delete,
  submitForReview: taskRouter._def.procedures.submitForReview,
});
