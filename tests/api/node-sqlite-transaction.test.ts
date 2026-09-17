import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { agents } from "@db/schema";

/**
 * node:sqlite 适配器的事务语义。
 *
 * 背景：node:sqlite 是**同步**驱动，而业务代码写成
 *   await db.transaction(async (tx) => { await tx.insert(...); ... })
 * 历史实现里 BEGIN 之后立刻 COMMIT，即回调返回 Promise 时就提交——
 * 而 async 回调只会同步执行到第一个 await，其余语句在微任务里、即事务外执行。
 * 后果：事务不再是原子的，回调后段失败也无法回滚（部分写入已落库）。
 * 这里的每一例都是对「原子性」这一契约的可执行断言。
 */
describe("node:sqlite 适配器事务语义", () => {
  it("同步回调抛错必须回滚", () => {
    const { db, dispose } = createTestDb();
    try {
      expect(() =>
        db.transaction((tx) => {
          tx.insert(agents).values({ agentId: "s1", name: "Sync", system: "test" }).run();
          throw new Error("sync-boom");
        }),
      ).toThrow("sync-boom");
      expect(db.select().from(agents).all()).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("异步回调抛错必须回滚（await 之后的失败不得留下已提交写入）", async () => {
    const { db, dispose } = createTestDb();
    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(agents).values({ agentId: "a1", name: "Async", system: "test" });
          await Promise.resolve();
          throw new Error("async-boom");
        }),
      ).rejects.toThrow("async-boom");
      // 关键断言：回调失败了，就不该有任何一行落库
      expect(db.select().from(agents).all()).toHaveLength(0);
    } finally {
      dispose();
    }
  });

  it("异步回调成功必须整体提交", async () => {
    const { db, dispose } = createTestDb();
    try {
      await db.transaction(async (tx) => {
        await tx.insert(agents).values({ agentId: "ok1", name: "Ok1", system: "test" });
        await tx.insert(agents).values({ agentId: "ok2", name: "Ok2", system: "test" });
      });
      const ids = (db.select().from(agents).all() as Array<{ agentId: string }>)
        .map((row) => row.agentId)
        .sort();
      expect(ids).toEqual(["ok1", "ok2"]);
    } finally {
      dispose();
    }
  });

  it("同一 tick 内并发发起的事务必须串行完成，且互不污染", async () => {
    const { db, dispose } = createTestDb();
    try {
      // A 回滚、B 提交：两者交叠时，A 的回滚不得把 B 的写入一起抹掉。
      const a = db.transaction(async (tx) => {
        await tx.insert(agents).values({ agentId: "con-a", name: "A", system: "test" });
        await Promise.resolve();
        throw new Error("concurrent-boom");
      });
      const b = db.transaction(async (tx) => {
        await tx.insert(agents).values({ agentId: "con-b", name: "B", system: "test" });
      });

      await expect(a).rejects.toThrow("concurrent-boom");
      await expect(b).resolves.toBeUndefined();

      const ids = (db.select().from(agents).all() as Array<{ agentId: string }>)
        .map((row) => row.agentId);
      expect(ids).toEqual(["con-b"]);
    } finally {
      dispose();
    }
  });
});
