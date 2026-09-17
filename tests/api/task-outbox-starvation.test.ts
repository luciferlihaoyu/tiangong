/**
 * outbox 查选饥饿回归测试。
 *
 * 已知 bug：dispatchDueOutboxEvents 先 SELECT LIMIT 100 再在 JS 里过滤，
 * 已投递/死信事件排在前面时，LIMIT 之后的待投递事件永远轮不到。
 *
 * 本测试用真实 SQLite（通过 createTestDb）构造 100 条已投递 + 10 条待投递
 * 的场景，直接调用 selectDue 验证 WHERE 是否下推到 SQL。
 */
import { describe, it, expect } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { selectDue } from "../../api/lib/task-outbox";
import { taskOutboxEvents } from "@db/schema";

describe("outbox 查选饥饿", () => {
  it("100 条已投递在前、10 条待投递在后 → selectDue 应选出足额待投递", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);

    // 100 条已投递事件（占满前 100 行）
    for (let i = 1; i <= 100; i++) {
      await db.insert(taskOutboxEvents).values({
        eventId: `delivered-${i}`,
        taskId: 1,
        taskPublicId: "TASK-A",
        externalRef: `ref-${i}`,
        originSystem: "beidou",
        workspaceSlug: "test",
        projectSlug: "test",
        eventType: "state",
        status: "done",
        stateRevision: i,
        traceId: `trace-${i}`,
        payloadDigest: `digest-${i}`,
        keyId: "test-key",
        nextAttemptAt: past,
        deliveredAt: past,   // ← 已投递
      });
    }

    // 10 条待投递事件（排在 101-110，nextAttemptAt 已到投递时间）
    for (let i = 1; i <= 10; i++) {
      await db.insert(taskOutboxEvents).values({
        eventId: `pending-${i}`,
        taskId: 2,
        taskPublicId: "TASK-B",
        externalRef: `ref-pending-${i}`,
        originSystem: "beidou",
        workspaceSlug: "test",
        projectSlug: "test",
        eventType: "state",
        status: "in_progress",
        stateRevision: 1000 + i,
        traceId: `trace-pending-${i}`,
        payloadDigest: `digest-pending-${i}`,
        keyId: "test-key",
        nextAttemptAt: past,    // ← 已到投递时间
        // deliveredAt: null     ← 未投递（不显式传给 drizzle，靠 schema 的默认行为）
      });
    }

    const due = await selectDue(db as never, now);
    // 修复前（JS 侧过滤）只会取前 100 行 = 全部已投递 → 0 条待投递
    // 修复后（WHERE 下推 SQL）选出 10 条
    expect(due.length).toBe(10);
    expect(due.every((e) => e.eventId.startsWith("pending-"))).toBe(true);

    dispose();
  });

  it("死信与未到期事件不应被选出", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60_000);

    const base = {
      taskId: 1,
      taskPublicId: "TASK-A",
      externalRef: "ref",
      originSystem: "beidou",
      workspaceSlug: "test",
      projectSlug: "test",
      eventType: "state" as const,
      status: "done",
      traceId: "trace",
      payloadDigest: "digest",
      keyId: "test-key",
    };

    // 三种都不该被选：已死信、未到投递时间
    await db.insert(taskOutboxEvents).values({ ...base, eventId: "dead", stateRevision: 1, nextAttemptAt: past, deadLetterAt: past });
    await db.insert(taskOutboxEvents).values({ ...base, eventId: "future", stateRevision: 2, nextAttemptAt: future });
    // 唯一该被选的
    await db.insert(taskOutboxEvents).values({ ...base, eventId: "due", stateRevision: 3, nextAttemptAt: past });

    const due = await selectDue(db as never, now);
    expect(due.map((e) => e.eventId)).toEqual(["due"]);

    dispose();
  });

  it("单次仍受 LIMIT 100 约束（防止一次拉爆）", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date();
    const past = new Date(now.getTime() - 60_000);

    for (let i = 1; i <= 150; i++) {
      await db.insert(taskOutboxEvents).values({
        eventId: `due-${i}`,
        taskId: 1,
        taskPublicId: "TASK-A",
        externalRef: `ref-${i}`,
        originSystem: "beidou",
        workspaceSlug: "test",
        projectSlug: "test",
        eventType: "state",
        status: "done",
        stateRevision: i,
        traceId: `trace-${i}`,
        payloadDigest: `digest-${i}`,
        keyId: "test-key",
        nextAttemptAt: past,
      });
    }

    const due = await selectDue(db as never, now);
    expect(due.length).toBe(100);

    dispose();
  });
});