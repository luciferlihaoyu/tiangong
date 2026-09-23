/**
 * outbox 投递租约（claim/lease）与稳定排序 —— 真实 SQLite。
 *
 * 原状况（Phase B §3）：投递循环没有任何 claim——selectDue 选出事件后直接发，
 * 发完才 UPDATE。于是：
 *   1. 事件"在飞行中"时对任何其它派发者仍然可见（多实例/手工触发会重复投递）；
 *   2. `running` 标志只是**进程内**的，进程崩了就没人知道这条事件正在被谁处理；
 *   3. selectDue 没有 ORDER BY，"先发哪些"由存储引擎顺带决定。
 *
 * 正确契约：**至少一次投递**——
 *   - 领取（claim）用一个**有期限的租约**做原子 CAS，租约内别人抢不到；
 *   - 进程崩了租约自然到期，事件重新可领取（所以不会永久卡死）；
 *   - 投递完成（成功/重试/死信）立刻释放租约，不必等它自然过期；
 *   - 重复投递由接收端按 eventId 幂等消化（我们始终带稳定的 X-TG-Event-ID）。
 * 注意：这里是 at-least-once，**不承诺网络场景绝不重复**。
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "./helpers/test-db";
import { taskOutboxEvents } from "@db/schema";
import {
  claimDueEvents,
  completeDelivery,
  selectDue,
  DEFAULT_LEASE_MS,
} from "../../api/lib/task-outbox";

type Db = ReturnType<typeof createTestDb>["db"];

const BASE = {
  taskId: 1,
  taskPublicId: "TASK-L",
  originSystem: "beidou",
  workspaceSlug: "test",
  projectSlug: "test",
  eventType: "state" as const,
  status: "done",
  traceId: "trace-l",
  keyId: "test-key",
};

// state_revision 在 (task_id, state_revision) 上有唯一索引，所以要跨调用递增，
// 不能每次从 1 重来（否则多次 seed 会撞唯一约束）。
let revisionCounter = 0;

async function seed(db: Db, ids: readonly string[], at: Date): Promise<void> {
  for (const id of ids) {
    await db.insert(taskOutboxEvents).values({
      ...BASE,
      eventId: id,
      externalRef: `ref-${id}`,
      stateRevision: ++revisionCounter,
      payloadDigest: `digest-${id}`,
      nextAttemptAt: at,
    });
  }
}

describe("outbox 投递租约", () => {
  it("领取后同一事件不会被后续派发者再领取（租约内互斥）", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date("2026-09-22T10:00:00Z");
    await seed(db, ["e1"], new Date(now.getTime() - 60_000));

    const first = await claimDueEvents(db as never, now);
    expect(first.map((e) => e.eventId)).toEqual(["e1"]);

    // 第二个实例/第二次调用：租约仍有效 → 抢不到
    expect(await claimDueEvents(db as never, now)).toEqual([]);

    dispose();
  });

  it("selectDue 跳过租约未到期的事件（循环不会重复发）", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date("2026-09-22T10:00:00Z");
    await seed(db, ["e1"], new Date(now.getTime() - 60_000));

    await claimDueEvents(db as never, now);

    expect(await selectDue(db as never, now)).toEqual([]);
    // 租约还没到期，哪怕时间往前走一点也仍被挡住
    expect(await selectDue(db as never, new Date(now.getTime() + 30_000))).toEqual([]);

    dispose();
  });

  it("进程崩溃后租约到期 → 事件重新可领取（不会永久卡死）", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date("2026-09-22T10:00:00Z");
    await seed(db, ["e1"], new Date(now.getTime() - 60_000));

    await claimDueEvents(db as never, now, { leaseMs: 60_000 }); // 领了但"崩了"，从未完成

    const afterExpiry = new Date(now.getTime() + 61_000);
    expect((await selectDue(db as never, afterExpiry)).map((e) => e.eventId)).toEqual(["e1"]);
    expect((await claimDueEvents(db as never, afterExpiry)).map((e) => e.eventId)).toEqual(["e1"]);

    dispose();
  });

  it("投递成功立刻释放租约，不必等它自然过期", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date("2026-09-22T10:00:00Z");
    await seed(db, ["e1"], new Date(now.getTime() - 60_000));

    const claimed = await claimDueEvents(db as never, now);
    expect(claimed).toHaveLength(1);
    await completeDelivery(db as never, claimed[0], { kind: "delivered" }, now);

    const row = (await db.select().from(taskOutboxEvents).all()).find((r) => r.eventId === "e1");
    expect(row?.deliveredAt).not.toBeNull();
    expect(row?.claimedAt).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();

    dispose();
  });

  it("重试/死信完成后也不留租约（否则会白等一轮租约）", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date("2026-09-22T10:00:00Z");
    await seed(db, ["retry", "dead"], new Date(now.getTime() - 60_000));

    const claimed = await claimDueEvents(db as never, now);
    expect(claimed).toHaveLength(2);
    for (const event of claimed) {
      await completeDelivery(
        db as never,
        event,
        event.eventId === "retry"
          ? { kind: "retry", nextAttemptAt: new Date(now.getTime() + 60_000) }
          : { kind: "dead_letter" },
        now,
      );
    }

    const rows = await db.select().from(taskOutboxEvents).all();
    for (const row of rows) {
      expect(row.claimedAt).toBeNull();
      expect(row.leaseExpiresAt).toBeNull();
    }
    const retryRow = rows.find((r) => r.eventId === "retry");
    const deadRow = rows.find((r) => r.eventId === "dead");
    expect(retryRow?.attempts).toBe(1);
    expect(retryRow?.deadLetterAt).toBeNull();
    expect(deadRow?.deadLetterAt).not.toBeNull();

    dispose();
  });

  it("已完成/已死信的事件永远不会被领取（回归）", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date("2026-09-22T10:00:00Z");
    const past = new Date(now.getTime() - 60_000);
    await seed(db, ["done", "dead", "due"], past);

    await db
      .update(taskOutboxEvents)
      .set({ deliveredAt: past })
      .where(eq(taskOutboxEvents.eventId, "done"));
    await db
      .update(taskOutboxEvents)
      .set({ deadLetterAt: past })
      .where(eq(taskOutboxEvents.eventId, "dead"));

    expect((await claimDueEvents(db as never, now)).map((e) => e.eventId)).toEqual(["due"]);

    dispose();
  });

  it("领取顺序稳定：按到期时间、再按 id（不依赖存储引擎的顺带顺序）", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date("2026-09-22T10:00:00Z");

    // 故意让"插入顺序"和"到期顺序"不一致
    await seed(db, ["late"], new Date(now.getTime() - 10_000));
    await seed(db, ["early"], new Date(now.getTime() - 50_000));
    await seed(db, ["middle"], new Date(now.getTime() - 30_000));

    expect((await selectDue(db as never, now)).map((e) => e.eventId)).toEqual([
      "early",
      "middle",
      "late",
    ]);

    dispose();
  });

  it("一次只领到额度内的数量（limit 生效）", async () => {
    const { db, dispose } = createTestDb();
    const now = new Date("2026-09-22T10:00:00Z");
    await seed(db, ["a", "b", "c"], new Date(now.getTime() - 60_000));

    expect(await claimDueEvents(db as never, now, { limit: 2 })).toHaveLength(2);
    expect((await claimDueEvents(db as never, now, { limit: 2 })).map((e) => e.eventId)).toEqual(["c"]);

    dispose();
  });

  it("默认租约时长比 HTTP 发送超时（10s）留有余量", () => {
    expect(DEFAULT_LEASE_MS).toBeGreaterThan(10_000);
  });
});
