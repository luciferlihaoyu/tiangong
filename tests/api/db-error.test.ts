import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { agents, tasks } from "@db/schema";

/**
 * 约束错误识别契约。
 *
 * 背景：既有代码用 `error.code !== "ER_DUP_ENTRY"` 判断唯一冲突，
 * 而本仓库跑 node:sqlite —— 实测真实 shape 为：
 *   code=ERR_SQLITE_ERROR  errcode=2067  errstr="constraint failed"
 *   message="UNIQUE constraint failed: <table>.<column>"
 * 于是该判断永不匹配，并发竞态下重复建单会直接抛错而非幂等返回。
 *
 * 另一半要求来自路线图：**不能把所有 constraint 错误都当幂等成功**——
 * NOT NULL / 外键 / 其他列或其他表的唯一冲突必须继续抛错，
 * 否则会把真正的数据错误静默吞掉。因此判定必须精确到「表 + 列」。
 */
import { isUniqueConstraintViolation } from "../../api/lib/db-error";

/** 真实驱动的唯一冲突形状（errcode 2067 = SQLITE_CONSTRAINT_UNIQUE） */
function sqliteUnique(table: string, column: string): Error {
  return Object.assign(new Error(`UNIQUE constraint failed: ${table}.${column}`), {
    code: "ERR_SQLITE_ERROR",
    errcode: 2067,
    errstr: "constraint failed",
  });
}

const beidouExpected = { table: "tasks", columns: ["external_ref", "idempotency_key"] };

describe("约束错误识别", () => {
  it("识别目标列上的唯一冲突", () => {
    expect(isUniqueConstraintViolation(sqliteUnique("tasks", "external_ref"), beidouExpected)).toBe(true);
    expect(isUniqueConstraintViolation(sqliteUnique("tasks", "idempotency_key"), beidouExpected)).toBe(true);
  });

  it("同一张表但非目标列的唯一冲突不认（精确到列）", () => {
    expect(isUniqueConstraintViolation(sqliteUnique("tasks", "task_id"), beidouExpected)).toBe(false);
  });

  it("其他表的唯一冲突不认（精确到表）", () => {
    expect(isUniqueConstraintViolation(sqliteUnique("beidou_agents", "external_ref"), beidouExpected)).toBe(false);
  });

  it("NOT NULL / 外键冲突一律不认，避免吞掉真实数据错误", () => {
    const notNull = Object.assign(new Error("NOT NULL constraint failed: tasks.agent_id"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 1299,
      errstr: "constraint failed",
    });
    const foreignKey = Object.assign(new Error("FOREIGN KEY constraint failed"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 787,
      errstr: "constraint failed",
    });
    expect(isUniqueConstraintViolation(notNull, beidouExpected)).toBe(false);
    expect(isUniqueConstraintViolation(foreignKey, beidouExpected)).toBe(false);
    expect(isUniqueConstraintViolation(notNull)).toBe(false);
    expect(isUniqueConstraintViolation(foreignKey)).toBe(false);
  });

  it("兼容 mysql2 历史遗留的 ER_DUP_ENTRY", () => {
    const legacy = Object.assign(new Error("Duplicate entry 'x' for key 'tasks.external_ref'"), {
      code: "ER_DUP_ENTRY",
    });
    expect(isUniqueConstraintViolation(legacy)).toBe(true);
    expect(isUniqueConstraintViolation(legacy, beidouExpected)).toBe(true);
  });

  it("消息不含表列信息时不做列级拦阻（交给回查摘要兜底）", () => {
    // tests/api/helpers/fake-db.ts 的唯一冲突就是这个形状：
    //   new Error("Duplicate entry") 且 code = "ER_DUP_ENTRY"
    // 它没有任何表/列信息，无法精确化——此时必须放行，
    // 否则既有 mock 测试会从 CONFLICT 退化成 INTERNAL_SERVER_ERROR。
    const fakeDbShape = Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });
    expect(isUniqueConstraintViolation(fakeDbShape, beidouExpected)).toBe(true);
  });

  it("普通错误、字符串、null 一律不认", () => {
    expect(isUniqueConstraintViolation(new Error("boom"))).toBe(false);
    expect(isUniqueConstraintViolation("ERR_SQLITE_ERROR")).toBe(false);
    expect(isUniqueConstraintViolation(null)).toBe(false);
    expect(isUniqueConstraintViolation(undefined)).toBe(false);
  });

  it("真实驱动产出的错误对象能被识别（绑定真实 shape，而非手写夹具）", async () => {
    const { db, dispose } = createTestDb();
    await db.insert(agents).values({ agentId: "dup-real", name: "A", system: "t" });
    let caught: unknown = null;
    try {
      await db.insert(agents).values({ agentId: "dup-real", name: "B", system: "t" });
    } catch (error) {
      caught = error;
    }
    dispose();

    expect(caught).not.toBeNull();
    // 目标列 → 认
    expect(isUniqueConstraintViolation(caught, { table: "agents", columns: ["agent_id"] })).toBe(true);
    // 非目标列 → 不认
    expect(isUniqueConstraintViolation(caught, { table: "agents", columns: ["name"] })).toBe(false);
  });

  it("真实驱动的复合唯一索引列全列名，目标列仍能精确命中", async () => {
    // tasks 上 (origin_system, external_ref) 是复合唯一索引，实测 message 为：
    //   "UNIQUE constraint failed: tasks.origin_system, tasks.external_ref"
    // 注意 origin_system 必须非 NULL——SQLite 唯一索引里 NULL 互不冲突，
    // 这也是「探针没报错」曾一度误导分析的原因。
    const { db, dispose } = createTestDb();
    const base = (n: number, extra: Record<string, unknown> = {}) => ({
      taskId: `tg-${n}`,
      name: "N",
      agentId: null,
      description: "d",
      priority: 0,
      input: "{}",
      status: "pending" as const,
      lifecycleStatus: "created" as const,
      originSystem: "beidou",
      externalRef: `ref-${n}`,
      idempotencyKey: `idem-${n}`,
      ...extra,
    });
    await db.insert(tasks).values(base(1) as never);
    let caught: unknown = null;
    try {
      await db.insert(tasks).values(base(2, { externalRef: "ref-1" }) as never);
    } catch (error) {
      caught = error;
    }
    dispose();

    expect(caught).not.toBeNull();
    // 目标列在复合索引里 → 认
    expect(isUniqueConstraintViolation(caught, { table: "tasks", columns: ["external_ref", "idempotency_key"] })).toBe(true);
    // 不在该复合索引里的列 → 不认
    expect(isUniqueConstraintViolation(caught, { table: "tasks", columns: ["task_id"] })).toBe(false);
  });
});
