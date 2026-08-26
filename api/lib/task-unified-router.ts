// api/lib/task-unified-router.ts
// 兼容层：把 taskRouter 和 taskboardRouter 的 procedure 合并到单一 router，
// 让 api/router.ts 在 `task.*` 命名空间下挂载统一 router。
//
// 选型说明（PLAN t1 方案 B1 修订）：
// - tRPC 路由挂载是 router-level，不能 proc-level 选择性挂——单纯让两个名字挂同一
//   router 实例意味着 task 命名空间会失去 task-only 的 procs（dispatch/nextTaskId/
//   create/promote/delete/submitForReview）。
// - 也不能直接 mergeRouters：两个 router 都有 `list/dispatch/create/approve/reject`，
//   命名冲突无法 mergeWithoutOverrides。
// - 因此手动组合：task.* 命名空间下 11 个 proc 全部从 taskRouter 取（保持老 schema，
//   与前端实际入参完全一致——前端传 {status, agentId?, keyword?, id, comment?, reason}）。
//   taskboard 命名空间下挂 taskboardRouter 自身（提供 taskboard 独有 procs：
//   listReviewTasks/getDependencyChain/claim/heartbeat/block/unblock/comment/submit/
//   updateStatus/requestChanges）——通过 api/router.ts 的 taskboard: taskboardRouter
//   直接挂出。
//
// 副作用：
// - 0 行为变化。task.* 的所有 proc 行为与 t1 实施前完全一致。
// - 不删除 task-router.ts（保留供 unit test / 后续按需使用）。
// - 不删除 taskboard-router.ts（taskboard.* 命名空间仍走它）。

import { createRouter } from "../middleware";
import { taskRouter } from "../task-router";
import { taskboardRouter } from "../taskboard-router";

export const unifiedTaskRouter = createRouter({
  // ── 全部 11 个 proc 从 taskRouter 取（保持老 schema，前端入参 0 改动） ──
  list: taskRouter._def.procedures.list,
  getById: taskRouter._def.procedures.getById,
  approve: taskRouter._def.procedures.approve,
  reject: taskRouter._def.procedures.reject,
  updateProgress: taskRouter._def.procedures.updateProgress,
  dispatch: taskRouter._def.procedures.dispatch,
  nextTaskId: taskRouter._def.procedures.nextTaskId,
  create: taskRouter._def.procedures.create,
  promote: taskRouter._def.procedures.promote,
  delete: taskRouter._def.procedures.delete,
  submitForReview: taskRouter._def.procedures.submitForReview,
});

// 暴露 taskboardRouter 给调用方查询（单测、调试用），无副作用。
export { taskboardRouter };
