/**
 * Task ↔ Taskboard Alias 兼容层测试（PLAN t1）
 *
 * 目的：验证 `api/lib/task-unified-router.ts` 把 taskRouter 和 taskboardRouter
 * 的 procedure 合并到 unifiedTaskRouter 后，task.* 命名空间下的 procedure 与
 * taskboard.* 命名空间下的同名 procedure 路由到完全相同的处理函数（同一 proc
 * 对象 = 同 source = 行为同源）。
 *
 * 不变量：
 *   1. unifiedTaskRouter._def.procedures.<name> 严格 === taskboardRouter._def.procedures.<name>
 *      或 === taskRouter._def.procedures.<name>（按合并策略选定）
 *   2. task.* 命名空间（appRouter.task）下能列出 taskboard 优先采纳的 procs，
 *      且能从 caller 调通
 *   3. task 独有的 procs（dispatch/create/nextTaskId/promote/delete/submitForReview）
 *      必须来自 taskRouter（来自 taskboardRouter 会改变 Agent 端行为，t1 不允许）
 *
 * 为什么不调用真实 DB：本仓库所有 task/taskboard 测试都用同样的"链式 mock" +
 *   `vi.mock("../../api/queries/connection", ...)` 模式；行为正确性已经在
 *   task-flow.test.ts / taskboard-flow.test.ts 里覆盖，本测试只验证两个 router
 *   真的接到同一份 procedure 对象（== 行为同源）。
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

describe("Task ↔ Taskboard Alias Compat Layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockData = [];
  });

  // ── 1. 引用同一性（unified.* 与某个 source router 共享 procedure 对象） ──
  describe("procedure identity", () => {
    it("unified.list 严格 === taskboardRouter.list", () => {
      expect(unifiedTaskRouter._def.procedures.list).toBe(taskboardRouter._def.procedures.list);
    });

    it("unified.getById 严格 === taskboardRouter.get（key 映射：task.getById → board.get）", () => {
      expect(unifiedTaskRouter._def.procedures.getById).toBe(taskboardRouter._def.procedures.get);
    });

    it("unified.approve 严格 === taskboardRouter.approve", () => {
      expect(unifiedTaskRouter._def.procedures.approve).toBe(taskboardRouter._def.procedures.approve);
    });

    it("unified.reject 严格 === taskboardRouter.reject", () => {
      expect(unifiedTaskRouter._def.procedures.reject).toBe(taskboardRouter._def.procedures.reject);
    });

    it("unified.updateProgress 严格 === taskboardRouter.progress（key 映射）", () => {
      expect(unifiedTaskRouter._def.procedures.updateProgress).toBe(taskboardRouter._def.procedures.progress);
    });

    // ── task 独有 procs：必须来自 taskRouter（保持 Agent 端派发/创建原行为） ──
    it("unified.dispatch 严格 === taskRouter.dispatch（taskboard 也同名，但 task 版本校验更严：running 任务并发限制）", () => {
      expect(unifiedTaskRouter._def.procedures.dispatch).toBe(taskRouter._def.procedures.dispatch);
      // 防回归：确保 unified 不会漂移成 taskboard 的 dispatch
      expect(unifiedTaskRouter._def.procedures.dispatch).not.toBe(taskboardRouter._def.procedures.dispatch);
    });

    it("unified.create 严格 === taskRouter.create（保留 tRPC 风格入参 + mergeTaskMetadata 行为）", () => {
      expect(unifiedTaskRouter._def.procedures.create).toBe(taskRouter._def.procedures.create);
      expect(unifiedTaskRouter._def.procedures.create).not.toBe(taskboardRouter._def.procedures.create);
    });

    it("unified.nextTaskId 严格 === taskRouter.nextTaskId（taskboard 完全没有）", () => {
      expect(unifiedTaskRouter._def.procedures.nextTaskId).toBe(taskRouter._def.procedures.nextTaskId);
      // taskboard 没有 nextTaskId，unified 也不该凭空引入
      expect((unifiedTaskRouter._def.procedures as Record<string, unknown>).nextTaskId).toBeDefined();
      expect((taskboardRouter._def.procedures as Record<string, unknown>).nextTaskId).toBeUndefined();
    });

    it("unified.promote 严格 === taskRouter.promote（taskboard 完全没有）", () => {
      expect(unifiedTaskRouter._def.procedures.promote).toBe(taskRouter._def.procedures.promote);
      expect((taskboardRouter._def.procedures as Record<string, unknown>).promote).toBeUndefined();
    });

    it("unified.delete 严格 === taskRouter.delete（taskboard 完全没有）", () => {
      expect(unifiedTaskRouter._def.procedures.delete).toBe(taskRouter._def.procedures.delete);
      expect((taskboardRouter._def.procedures as Record<string, unknown>).delete).toBeUndefined();
    });

    it("unified.submitForReview 严格 === taskRouter.submitForReview（taskboard 完全没有）", () => {
      expect(unifiedTaskRouter._def.procedures.submitForReview).toBe(taskRouter._def.procedures.submitForReview);
      expect((taskboardRouter._def.procedures as Record<string, unknown>).submitForReview).toBeUndefined();
    });
  });

  // ── 2. unified caller 端能调通（验证 tRPC 11 接受从 _def.procedures 拉出的 proc） ──
  describe("unified caller wires", () => {
    it("unified caller 暴露 list/getById/approve/reject/updateProgress/dispatch/nextTaskId/create/promote/delete/submitForReview 全部 proc", () => {
      const createCaller = createCallerFactory(unifiedTaskRouter);
      const caller = createCaller(mockCtx());
      // 共享给 taskboard 的 5 个
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

    it("unified.list 实际调用 taskboardRouter.list（共享同一对象，所以 mock 数据被同一 handler 消费）", async () => {
      mockData = [
        { id: 1, taskId: "TG-A1", name: "alpha", boardStatus: "todo" },
        { id: 2, taskId: "TG-A2", name: "beta", boardStatus: "running" },
      ];
      const createCaller = createCallerFactory(unifiedTaskRouter);
      const caller = createCaller(mockCtx());
      const result = await caller.list({ boardStatus: "todo" });
      // taskboard list 的实现是 select().from(tasks).where(...).orderBy(...).limit(200)
      // 验证 mockSelectFn 被调用过（与 taskboard 行为同源）
      expect(mockSelectFn).toHaveBeenCalled();
      // 验证 mockDb.select() 入口被触发
      expect(mockDb.select).toHaveBeenCalled();
      // 返回的 data 就是 mockData
      expect(result).toEqual(mockData);
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

  // ── 3. 行为同源：unified 和 taskboard 的 caller 对同一输入返回同结构数据 ──
  describe("behavior parity between task.* and taskboard.*", () => {
    it("task.list 和 taskboard.list 共享同一 proc 对象（== 行为完全同源）", () => {
      // 这一断言最关键：两个 caller 调到的不是"长得一样的实现"，而是"同一个对象"
      expect(unifiedTaskRouter._def.procedures.list).toBe(taskboardRouter._def.procedures.list);
      // 反向：taskboardRouter.list 本身不等于 taskRouter.list
      expect(taskboardRouter._def.procedures.list).not.toBe(taskRouter._def.procedures.list);
    });

    it("task.approve 和 taskboard.approve 共享同一 proc 对象（权限校验/通知/落库都走 taskboard 那条更全的路径）", () => {
      expect(unifiedTaskRouter._def.procedures.approve).toBe(taskboardRouter._def.procedures.approve);
      expect(taskboardRouter._def.procedures.approve).not.toBe(taskRouter._def.procedures.approve);
    });

    it("task.reject 和 taskboard.reject 共享同一 proc 对象", () => {
      expect(unifiedTaskRouter._def.procedures.reject).toBe(taskboardRouter._def.procedures.reject);
      expect(taskboardRouter._def.procedures.reject).not.toBe(taskRouter._def.procedures.reject);
    });
  });

  // ── 4. 反向断言：unified 不会泄漏不应该暴露的 proc ──
  describe("no proc leakage", () => {
    it("unified 不暴露 taskboard-only 的 claim/heartbeat/submit/block/unblock/updateStatus/requestChanges/listReviewTasks/getDependencyChain/comment", () => {
      // 这些是 taskboard 专属（Agent 端 DAG 链/审批流），任务中心 UI 用不到；
      // 暴露到 task.* 会让 t2 前端迁移时遇到不必要的旧输入形状回归
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
  });
});
