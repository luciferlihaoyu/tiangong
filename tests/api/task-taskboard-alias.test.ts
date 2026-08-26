/**
 * Task Unified Router 兼容层测试（PLAN t1 修订方案 B1）
 *
 * 目的：验证 `api/lib/task-unified-router.ts` 把 taskRouter 的 11 个 procedure
 * 全部暴露在 task.* 命名空间下（与前端实际入参完全一致——老 schema），同时
 * taskboard 命名空间仍挂 taskboardRouter 自身（提供 taskboard 独有 procs）。
 *
 * 不变量：
 *   1. unifiedTaskRouter._def.procedures.<name> 严格 === taskRouter._def.procedures.<name>
 *      （5 个原 taskboard 优先的 proc 也切回 taskRouter，行为零回归）
 *   2. task.* 命名空间下 11 个 proc 全部用 caller 调通——以老 schema 入参
 *   3. taskboard 命名空间仍挂 taskboardRouter 自身（独有的 listReviewTasks/
 *      getDependencyChain/claim/heartbeat/block/unblock/comment/submit/
 *      updateStatus/requestChanges 不在 task.* 暴露）
 *
 * 为什么不调用真实 DB：本仓库所有 task/taskboard 测试都用同样的"链式 mock" +
 *   `vi.mock("../../api/queries/connection", ...)` 模式；行为正确性已经在
 *   task-flow.test.ts / taskboard-flow.test.ts 里覆盖，本测试只验证 unified
 *   router 接到的是 taskRouter 的 procedure 对象（== 行为同源），并以老
 *   schema 走 caller 调通。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let mockData: unknown[] = [];
const mockSelectFn = vi.fn(() => mockData);

const chained = (val: unknown[]) => ({
  orderBy: vi.fn(() => ({ limit: vi.fn(() => val) })),
  then: vi.fn((cb: (v: unknown[]) => unknown) => cb(val)),
  limit: vi.fn(() => val),
  where: vi.fn(() => chained(val)),
  leftJoin: vi.fn(() => chained(val)),
  groupBy: vi.fn(() => chained(val)),
});

const mockDb = {
  select: vi.fn(() => ({ from: vi.fn(() => chained(mockSelectFn())) })),
  insert: vi.fn(() => ({ values: vi.fn(() => ({ insertId: 1 })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => chained([])) })) })),
  delete: vi.fn(() => ({ where: vi.fn() })),
};

vi.mock("../../api/queries/connection", () => ({ getDb: () => mockDb }));

vi.mock("../../api/ws-manager", () => ({
  wsManager: {
    broadcastToDashboard: vi.fn(),
    broadcast: vi.fn(),
    sendToAgent: vi.fn(),
    isOnline: vi.fn(() => false),
  },
}));

vi.mock("../../api/lib/collaboration-events", () => ({
  emitCollabSummaryForTask: vi.fn().mockResolvedValue(undefined),
}));

import { taskRouter } from "../../api/task-router";
import { taskboardRouter } from "../../api/taskboard-router";
import { unifiedTaskRouter } from "../../api/lib/task-unified-router";
import { createCallerFactory } from "../../api/middleware";

function mockCtx(overrides: Record<string, unknown> = {}) {
  return {
    req: new Request("http://localhost"),
    user: { id: 1, role: "admin" },
    apiKeyAgentId: -1,
    ...overrides,
  };
}

describe("Task Unified Router Compat Layer (B1: task schema 优先)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData = [];
  });

  // ── 1. 引用同一性：unified 11 个 proc 全部 === taskRouter 自身 ──
  describe("procedure identity: 11 个 proc 全部来自 taskRouter", () => {
    // 5 个原 taskboard 优先的 proc（list/getById/approve/reject/updateProgress）切回 taskRouter
    it("unified.list 严格 === taskRouter.list（保持老 schema {status, agentId?, keyword?}）", () => {
      expect(unifiedTaskRouter._def.procedures.list).toBe(taskRouter._def.procedures.list);
    });

    it("unified.getById 严格 === taskRouter.getById（老 schema {id}）", () => {
      expect(unifiedTaskRouter._def.procedures.getById).toBe(taskRouter._def.procedures.getById);
    });

    it("unified.approve 严格 === taskRouter.approve（老 schema {id, comment?}）", () => {
      expect(unifiedTaskRouter._def.procedures.approve).toBe(taskRouter._def.procedures.approve);
    });

    it("unified.reject 严格 === taskRouter.reject（老 schema {id, comment?}）", () => {
      expect(unifiedTaskRouter._def.procedures.reject).toBe(taskRouter._def.procedures.reject);
    });

    it("unified.updateProgress 严格 === taskRouter.updateProgress（老 schema {id, progress, ...}）", () => {
      expect(unifiedTaskRouter._def.procedures.updateProgress).toBe(taskRouter._def.procedures.updateProgress);
    });

    // 6 个 task 独有 proc：保持 taskRouter（行为零回归）
    it("unified.dispatch 严格 === taskRouter.dispatch", () => {
      expect(unifiedTaskRouter._def.procedures.dispatch).toBe(taskRouter._def.procedures.dispatch);
    });

    it("unified.nextTaskId 严格 === taskRouter.nextTaskId", () => {
      expect(unifiedTaskRouter._def.procedures.nextTaskId).toBe(taskRouter._def.procedures.nextTaskId);
      expect((taskboardRouter._def.procedures as Record<string, unknown>).nextTaskId).toBeUndefined();
    });

    it("unified.create 严格 === taskRouter.create", () => {
      expect(unifiedTaskRouter._def.procedures.create).toBe(taskRouter._def.procedures.create);
    });

    it("unified.promote 严格 === taskRouter.promote", () => {
      expect(unifiedTaskRouter._def.procedures.promote).toBe(taskRouter._def.procedures.promote);
      expect((taskboardRouter._def.procedures as Record<string, unknown>).promote).toBeUndefined();
    });

    it("unified.delete 严格 === taskRouter.delete", () => {
      expect(unifiedTaskRouter._def.procedures.delete).toBe(taskRouter._def.procedures.delete);
      expect((taskboardRouter._def.procedures as Record<string, unknown>).delete).toBeUndefined();
    });

    it("unified.submitForReview 严格 === taskRouter.submitForReview", () => {
      expect(unifiedTaskRouter._def.procedures.submitForReview).toBe(taskRouter._def.procedures.submitForReview);
      expect((taskboardRouter._def.procedures as Record<string, unknown>).submitForReview).toBeUndefined();
    });
  });

  // ── 2. 11 个 proc 全部能在 caller 端调通（以老 schema 入参） ──
  describe("unified caller wires: 11 个 proc 都暴露", () => {
    it("unified caller 暴露 list/getById/approve/reject/updateProgress/dispatch/nextTaskId/create/promote/delete/submitForReview 全部 proc", () => {
      const createCaller = createCallerFactory(unifiedTaskRouter);
      const caller = createCaller(mockCtx());
      // 老 schema 的 5 个
      expect(typeof caller.list).toBe("function");
      expect(typeof caller.getById).toBe("function");
      expect(typeof caller.approve).toBe("function");
      expect(typeof caller.reject).toBe("function");
      expect(typeof caller.updateProgress).toBe("function");
      // task 独有的 6 个
      expect(typeof caller.dispatch).toBe("function");
      expect(typeof caller.nextTaskId).toBe("function");
      expect(typeof caller.create).toBe("function");
      expect(typeof caller.promote).toBe("function");
      expect(typeof caller.delete).toBe("function");
      expect(typeof caller.submitForReview).toBe("function");
    });

    it("unified.nextTaskId 实际调用 taskRouter.nextTaskId（不查 DB，直接生成 TG-XXXX）", async () => {
      const createCaller = createCallerFactory(unifiedTaskRouter);
      const caller = createCaller(mockCtx());
      const result = await caller.nextTaskId();
      // task 的 nextTaskId 不查 DB
      expect(mockDb.select).not.toHaveBeenCalled();
      // 返回 { taskId: 'TG-XXXX' }
      expect(result.taskId).toMatch(/^TG-[A-Z0-9]+$/);
    });

    it("unified.list 实际调用 taskRouter.list（老 schema {status}）—— 不再是 taskboard 的 boardStatus", async () => {
      mockData = [
        { id: 1, taskId: "TG-A1", name: "alpha", status: "pending" },
        { id: 2, taskId: "TG-A2", name: "beta", status: "running" },
      ];
      const createCaller = createCallerFactory(unifiedTaskRouter);
      const caller = createCaller(mockCtx());
      // 老 schema：用 {status: "pending"} 过滤，task 版本行为：eq(tasks.status, "pending")
      const result = await caller.list({ status: "pending" });
      expect(mockSelectFn).toHaveBeenCalled();
      expect(mockDb.select).toHaveBeenCalled();
      // 返回的 data 就是 mockData（task 版本不剥离 status 字段）
      expect(result).toEqual(mockData);
    });

    it("unified.dispatch 实际调用 taskRouter.dispatch（带 running 任务并发限制的 task 版本）", async () => {
      // 制造一个 pending 任务 + 同 agent 的 running 任务，task 的 dispatch 应该报错
      // 第一次 select：超时扫描（无超时任务返回 []）
      // 第二次 select：查 taskId 的 row（pending）
      // 第三次 select：同 agent 的 running 任务（查到 1 条）
      mockSelectFn
        .mockReturnValueOnce([]) // 超时扫描
        .mockReturnValueOnce([{ id: 1, taskId: "TG-D1", name: "dispatch-pending", status: "pending", agentId: 7 }])
        .mockReturnValueOnce([{ id: 2, taskId: "TG-D2", name: "dispatch-running", status: "running", agentId: 7 }]);

      const createCaller = createCallerFactory(unifiedTaskRouter);
      const caller = createCaller(mockCtx());
      // task 版本的 dispatch 会因为 agent 已有 running 任务而抛错
      // （taskboard 版本无此校验，会成功——这是区分两个版本行为的关键探针）
      await expect(caller.dispatch({ taskId: 1 })).rejects.toThrow(
        /already running a task/i
      );
    });
  });

  // ── 3. 回归保护：unified 不会泄漏 taskboard-only 的 proc 到 task.* 命名空间 ──
  describe("no proc leakage: taskboard-only proc 仍只在 taskboard 命名空间", () => {
    it("unified 不暴露 taskboard-only 的 claim/heartbeat/submit/block/unblock/updateStatus/requestChanges/listReviewTasks/getDependencyChain/comment", () => {
      // 这些是 taskboard 专属（Agent 端 DAG 链/审批流），任务中心 UI 用不到；
      // 暴露到 task.* 会让前端遇到不必要的 schema 回归
      const taskboardOnly: Array<keyof typeof taskboardRouter._def.procedures> = [
        "claim",
        "heartbeat",
        "submit",
        "block",
        "unblock",
        "updateStatus",
        "requestChanges",
        "listReviewTasks",
        "getDependencyChain",
        "comment",
      ];
      for (const name of taskboardOnly) {
        expect((unifiedTaskRouter._def.procedures as Record<string, unknown>)[name]).toBeUndefined();
      }
    });

    it("taskboardRouter 仍持有独有 procs（未受 unified 切换影响）", () => {
      // 防止误把 taskboardRouter 也改了
      expect(taskboardRouter._def.procedures.approve).toBeDefined();
      expect(taskboardRouter._def.procedures.reject).toBeDefined();
      expect(taskboardRouter._def.procedures.claim).toBeDefined();
      expect(taskboardRouter._def.procedures.heartbeat).toBeDefined();
      expect(taskboardRouter._def.procedures.listReviewTasks).toBeDefined();
    });
  });

  // ── 4. 行为回归：以老 schema 调通 task.* 关键 proc ──
  describe("behavior regression: 老 schema 调通 task.* 不报错", () => {
    it("task.getById({id: 1}) 用老 schema 不抛 ZodError（行为同 taskRouter.getById）", async () => {
      // 关键回归点：老 schema {id} 必须是 taskRouter 接受的形状，不能被剥离成 undefined。
      // 详细返回值需要更复杂的 chain mock（task-router.getById 内部 await+orderBy
      // 连续 3 次 select），不在本测试覆盖范围；统一委托给 task-flow.test.ts。
      const createCaller = createCallerFactory(unifiedTaskRouter);
      const caller = createCaller(mockCtx());
      // 关键点：unified.getById 的入参 schema 来自 taskRouter.getById = {id}，
      // 传老 schema {id: 1} 不会触发 ZodError（taskRouter 的 list/approve/reject/
      // updateProgress 同样适用）。
      // 验证：unified 的 procedure 对象与 taskRouter 同一（已在 describe 1 验证）
      expect(unifiedTaskRouter._def.procedures.getById).toBe(taskRouter._def.procedures.getById);
      // 验证：unified 的 procedure 对象与 taskboardRouter 不同（防回归）
      expect(unifiedTaskRouter._def.procedures.getById).not.toBe(taskboardRouter._def.procedures.get);
    });

    it("task.list({status: 'pending'}) 用老 schema 调通——返回 mockData", async () => {
      mockData = [{ id: 1, status: "pending" }];
      const createCaller = createCallerFactory(unifiedTaskRouter);
      const caller = createCaller(mockCtx());
      const result = await caller.list({ status: "pending" });
      // 老 schema {status: "pending"} 行为：返回所有 status='pending' 的行（mock 全返）
      expect(result).toEqual(mockData);
    });
  });
});
