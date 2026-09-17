/**
 * test-db helper 自身烟雾测试：建表 → 写入 → 读取。
 * 这既是测试桩自身的品质保证，也是使用范例。
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "./test-db";
import { agents } from "@db/schema";

describe("test-db helper", () => {
  it("创建内存 SQLite 建全量表 → 插入 agent → 读回", async () => {
    const { db, dispose } = createTestDb();

    // 写入一条 agent
    const result = await db.insert(agents).values({
      agentId: "test-001",
      name: "Smoke Agent",
      system: "test",
    });

    // node-sqlite adapter 经 drizzle 返回的 shape：
    //   { changes: number; lastInsertRowid: number | bigint }
    const { changes, lastInsertRowid } = result as unknown as {
      changes?: number;
      lastInsertRowid?: number | bigint;
    };
    // 确认写入成功（changes 是底层受影响行数，lastInsertRowid 是自增主键）
    expect(changes).toBe(1);
    expect(typeof lastInsertRowid).toBe("number");

    // 读回
    const rows = db.select().from(agents).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentId).toBe("test-001");

    dispose();
  });

  it("两次 createTestDb 获得独立实例，互不污染", () => {
    const a = createTestDb();
    a.db.insert(agents).values({ agentId: "a-only", name: "A", system: "test" });

    const b = createTestDb();
    expect(b.db.select().from(agents).all()).toHaveLength(0);

    a.dispose();
    b.dispose();
  });
});