import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "./helpers/test-db";

/**
 * 外部建单链路在**真实 SQLite 适配器**上的端到端验证。
 *
 * 为什么必须用真实适配器：既有 beidou-external-router 测试全部基于 fake-db，
 * 而 fake-db 的写入返回值是 MySQL 形状（insertId/affectedRows），于是
 * 「读 insertId 拿到 NaN」这个真实驱动下的 bug 被完美掩盖——真实链路上
 * 外部建单会把 NaN 写进 task_outbox_events.task_id（NOT NULL），
 * 直接 "NOT NULL constraint failed" 整条失败。
 *
 * 断言的正是那条曾被破坏的契约：outbox 事件的 task_id 必须等于真实任务主键。
 */
const shared = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("./helpers/test-db").createTestDb>["db"],
}));

// 工厂必须保持同步：auto-migrate 会 import queries/connection，
// 在工厂里 await import 测试桩会形成循环等待而死锁。
vi.mock("../../api/queries/connection", () => ({ getDb: () => shared.db }));

import { beidouExternalRouter, type BeidouExternalCreateInput } from "../../api/beidou-external-router";
import { createCallerFactory, createContext } from "../../api/middleware";
import { issueServiceKey, type IssuedKey } from "../../api/lib/beidou-service-keys";
import { taskOutboxEvents, tasks, tiangongServiceKeys } from "@db/schema";

process.env.TIANGONG_SERVICE_KEY_PEPPER = "real-adapter-beidou-pepper";

const createCaller = createCallerFactory(beidouExternalRouter);

async function callerFor(issued: IssuedKey) {
  const ctx = await createContext({
    req: new Request("http://localhost/api/trpc", {
      headers: {
        authorization: `Bearer ${issued.token}`,
        "x-tg-service-key-id": issued.keyId,
      },
    }),
  });
  return createCaller(ctx);
}

const scopes = ["research-task:create", "research-task:read", "research-task:cancel"];

const baseCreate: BeidouExternalCreateInput = {
  external_ref: "beidou:research:real-001",
  idempotency_key: "real-idem-001",
  operation: "create",
  target: "real adapter task",
  params_snapshot: { query: "真实适配器", limit: 4 },
  origin_system: "beidou",
};

beforeAll(() => {
  shared.db = createTestDb().db;
});

beforeEach(() => {
  // 先删 outbox（它引用 tasks），再删 tasks / keys
  shared.db.delete(taskOutboxEvents).run();
  shared.db.delete(tasks).run();
  shared.db.delete(tiangongServiceKeys).run();
});

describe("外部建单（真实 SQLite 适配器）", () => {
  it("建单成功，且 outbox 的 task_id 是真实任务主键（不是 NaN）", async () => {
    const issued = await issueServiceKey({ workspaceSlug: "beidou-ws", projectSlug: "research", scopes });
    const caller = await callerFor(issued);

    const res = await caller.create(baseCreate);
    expect(res.success).toBe(true);

    const taskRows = shared.db.select().from(tasks).all();
    expect(taskRows).toHaveLength(1);
    const taskRow = taskRows[0] as { id: number; externalRef: string };
    expect(taskRow.externalRef).toBe(baseCreate.external_ref);

    const outbox = shared.db.select().from(taskOutboxEvents).all();
    expect(outbox).toHaveLength(1);
    const event = outbox[0] as { taskId: unknown };
    // 这两条断言就是本次修复的核心契约
    expect(Number.isNaN(event.taskId as number)).toBe(false);
    expect(event.taskId).toBe(taskRow.id);
  });

  it("重复请求（同 external_ref + 同摘要）返回同一任务，不重复建单", async () => {
    const issued = await issueServiceKey({ workspaceSlug: "beidou-ws", projectSlug: "research", scopes });
    const caller = await callerFor(issued);

    const first = await caller.create(baseCreate);
    const second = await caller.create(baseCreate);

    expect(second.duplicate).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    // 幂等：库里仍只有一条任务
    expect(shared.db.select().from(tasks).all()).toHaveLength(1);
  });

  it("并发同摘要重复建单：撞唯一约束的一方回退为幂等成功，而不是抛错", async () => {
    const issued = await issueServiceKey({ workspaceSlug: "beidou-ws", projectSlug: "research", scopes });
    const caller = await callerFor(issued);

    // 两个请求同一 tick 发出：前置查重都发生在任一事务提交之前，
    // 因此其中一个必然撞上唯一约束——这正是旧代码 `ER_DUP_ENTRY`
    // 判断永不匹配、直接把 SQLite 错误抛给调用方的路径。
    const [a, b] = await Promise.allSettled([
      caller.create(baseCreate),
      caller.create(baseCreate),
    ]);

    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("fulfilled");

    const results = [a, b].map((r) => (r as PromiseFulfilledResult<{ success: boolean; duplicate: boolean; task: { id: number | null } }>).value);
    expect(results.every((r) => r.success)).toBe(true);
    // 恰好一方是新建、一方是幂等回退
    expect(results.filter((r) => r.duplicate)).toHaveLength(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    // 两个请求指向同一任务，且库里只有一条
    const ids = new Set(results.map((r) => r.task.id));
    expect(ids.size).toBe(1);
    expect(shared.db.select().from(tasks).all()).toHaveLength(1);
    // outbox 事件也必须只有一条、task_id 正确（不能因竞态重复投递）
    const outbox = shared.db.select().from(taskOutboxEvents).all() as Array<{ taskId: unknown }>;
    expect(outbox).toHaveLength(1);
    expect(Number.isNaN(outbox[0].taskId as number)).toBe(false);
  });
});
