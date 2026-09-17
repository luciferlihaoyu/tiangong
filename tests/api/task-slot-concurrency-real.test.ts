import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * 真实路径上的业务不变量：任务并发上限。
 *
 * 与其它测试的差别：这里注入的是 **createTestDb()（真实 node:sqlite 适配器 +
 * 按生产 schema 建的表）**，而不是 fake-db——要验证的正是适配器的事务语义。
 *
 * acquireTaskSlot 是「check-then-act」：先清理过期槽位、再计数、再插入，
 * 完全依赖事务原子性。而适配器曾把 COMMIT 提前到异步回调 settle 之前，
 * 于是「计数」与「插入」落到事务外，同一 tick 的并发请求可以一起通过检查，
 * 直接把 maxConcurrentTasks 突破。
 *
 * 注意：mock 工厂必须保持**同步**。api/lib/auto-migrate.ts 会 import
 * queries/connection，若在工厂里 await import 测试桩就会形成
 * 「工厂 → 测试桩 → auto-migrate → connection（正在求值）」的循环等待而死锁。
 * 因此工厂只返回闭包，真实数据库在 beforeAll 里创建。
 */
const shared = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import("./helpers/test-db").createTestDb>["db"],
}));

vi.mock("../../api/queries/connection", () => ({
  getDb: () => shared.db,
}));

import { createTestDb } from "./helpers/test-db";
import { acquireTaskSlot } from "../../api/lib/task-concurrency";
import { taskExecutionSlots } from "@db/schema";

beforeAll(() => {
  shared.db = createTestDb().db;
});

describe("任务并发槽位（真实 SQLite + 真实适配器）", () => {
  it("同一 tick 并发取槽不得超过 maxConcurrentTasks", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((taskId) =>
        acquireTaskSlot({
          taskId,
          principalKey: "principal-real",
          workspaceSlug: "workspace-real",
          leaseToken: `lease-${taskId}`,
          now,
          expiresAt,
          maxConcurrentTasks: 2,
        }),
      ),
    );

    // 上限为 2：5 个并发请求里只能有 2 个拿到槽位
    expect(results.filter((result) => result.acquired)).toHaveLength(2);

    // 且库里活跃槽位确实只有 2 行（写入真实落库，且没有多写）
    expect(shared.db.select().from(taskExecutionSlots).all()).toHaveLength(2);
  });

  it("达到上限后拒绝，释放后可以重新取到", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const input = {
      taskId: 99,
      principalKey: "principal-release",
      workspaceSlug: "workspace-release",
      leaseToken: "lease-99",
      now,
      expiresAt,
      maxConcurrentTasks: 1,
    };

    await expect(acquireTaskSlot(input)).resolves.toEqual({ acquired: true });
    // 上限为 1 且已占用 → 第二个请求必须被拒
    await expect(
      acquireTaskSlot({ ...input, taskId: 100, leaseToken: "lease-100" }),
    ).resolves.toEqual({ acquired: false, reason: "concurrency_limit" });
    expect(
      shared.db
        .select()
        .from(taskExecutionSlots)
        .all()
        .filter((row) => (row as { principalKey: string }).principalKey === "principal-release"),
    ).toHaveLength(1);

    // 释放占用后又能取到
    shared.db.delete(taskExecutionSlots).run();
    await expect(acquireTaskSlot(input)).resolves.toEqual({ acquired: true });
  });
});
