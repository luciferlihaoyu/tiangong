/**
 * 通知中心 NC-2：recordNotification helper 单元测试
 *
 * 覆盖：
 *   - 正常插入完整字段（title/body/type/agentId/taskId/metadata）
 *   - null agentId 早退 / 空 title / 空 body 跳过（+ warn）
 *   - 60s 防抖窗口：窗口内去重、窗口外允许、异 taskId 不去重、null 与具体 taskId 不互判
 *   - windowMs 覆盖（NC-5 预算熔断 24h 窗口的支撑）
 *   - 落库异常兜底（永不抛错）
 *   - findDuplicateNotification 防抖查询单元
 *
 * 用 tests/api/helpers/fake-db.ts（真实 where 求值 + createdAt 默认），
 * 防抖窗口用 vi.useFakeTimers + setSystemTime 确定性控制。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakeDb } from "./helpers/fake-db";
import { notifications } from "@db/schema";
import type { RecordNotificationInput } from "../../api/lib/notification";
import {
  recordNotification,
  findDuplicateNotification,
  NOTIFICATION_DEDUP_WINDOW_MS,
} from "../../api/lib/notification";

const db = createFakeDb();
const notifyDb = db as unknown as Parameters<typeof recordNotification>[0];

const T = new Date("2025-01-01T00:00:00.000Z");

beforeEach(() => {
  db.reset();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function baseInput(overrides: Partial<RecordNotificationInput> = {}): RecordNotificationInput {
  return {
    agentId: 5,
    type: "task_approved",
    taskId: 7,
    title: "审批通过：生成周报",
    body: "任务已批准执行",
    ...overrides,
  };
}

describe("recordNotification（NC-2）", () => {
  it("正常插入：完整字段 → 1 行落库", async () => {
    await recordNotification(notifyDb, baseInput({ metadata: { reason: "ok" } }));

    const rows = db.rowsOfTable(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      agentId: 5,
      type: "task_approved",
      taskId: 7,
      title: "审批通过：生成周报",
      body: "任务已批准执行",
      metadata: { reason: "ok" },
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
    expect(rows[0]?.readAt).toBeUndefined();
  });

  it("null agentId 早退 → 0 行", async () => {
    await recordNotification(notifyDb, baseInput({ agentId: null }));
    expect(db.rowsOfTable(notifications)).toHaveLength(0);
  });

  it("空 title → 0 行 + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recordNotification(notifyDb, baseInput({ title: "" }));
    expect(db.rowsOfTable(notifications)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[notification]"));
  });

  it("空 body → 0 行 + warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recordNotification(notifyDb, baseInput({ body: "" }));
    expect(db.rowsOfTable(notifications)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("同 agentId+type+taskId 60s 内去重（调 2 次 → 1 行）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    await recordNotification(notifyDb, baseInput());
    await recordNotification(notifyDb, baseInput());
    expect(db.rowsOfTable(notifications)).toHaveLength(1);
  });

  it("60s 外允许重复（时间前进 120s → 2 行）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    await recordNotification(notifyDb, baseInput());
    vi.setSystemTime(new Date(T.getTime() + 120_000));
    await recordNotification(notifyDb, baseInput());
    expect(db.rowsOfTable(notifications)).toHaveLength(2);
  });

  it("不同 taskId 不去重 → 2 行", async () => {
    await recordNotification(notifyDb, baseInput({ taskId: 7 }));
    await recordNotification(notifyDb, baseInput({ taskId: 8 }));
    expect(db.rowsOfTable(notifications)).toHaveLength(2);
  });

  it("taskId=null 不与 taskId=123 互判 → 2 行", async () => {
    await recordNotification(notifyDb, baseInput({ taskId: 123 }));
    await recordNotification(notifyDb, baseInput({ taskId: null }));
    expect(db.rowsOfTable(notifications)).toHaveLength(2);
  });

  it("落库异常 → 永不抛错 + 0 行（警告吞掉）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    db.failNextInsert(notifications);
    await expect(recordNotification(notifyDb, baseInput())).resolves.toBeUndefined();
    expect(db.rowsOfTable(notifications)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to record"));
  });

  it("windowMs 覆盖（24h 预算熔断窗口）：5 分钟前同 agent 预算通知仍去重 → 1 行", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    // 先直接落一条 5 分钟前的 budget_exhausted（模拟上次熔断通知）
    await db.insert(notifications).values({
      agentId: 5,
      type: "budget_exhausted",
      taskId: null,
      title: "预算已耗尽",
      body: "预算耗尽通知",
      createdAt: new Date(T.getTime() - 5 * 60_000),
    });
    // 60s 默认窗口早已过期，但 24h 窗口内 → 仍去重
    await recordNotification(notifyDb, {
      agentId: 5,
      type: "budget_exhausted",
      taskId: null,
      title: "预算已耗尽",
      body: "预算耗尽通知",
      windowMs: 86_400_000,
    });
    expect(db.rowsOfTable(notifications)).toHaveLength(1);
  });
});

describe("findDuplicateNotification（防抖查询单元）", () => {
  it("窗口内同 agent+type+taskId → true；窗口外/异 agent/异 type → false", async () => {
    await db.insert(notifications).values({
      agentId: 5,
      type: "task_approved",
      taskId: 7,
      title: "a",
      body: "b",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    const now = new Date("2025-01-01T00:00:30.000Z");

    expect(
      await findDuplicateNotification(notifyDb, {
        agentId: 5,
        type: "task_approved",
        taskId: 7,
        windowMs: NOTIFICATION_DEDUP_WINDOW_MS,
        now,
      })
    ).toBe(true);
    // 窗口外（2 分钟后）→ false
    expect(
      await findDuplicateNotification(notifyDb, {
        agentId: 5,
        type: "task_approved",
        taskId: 7,
        windowMs: NOTIFICATION_DEDUP_WINDOW_MS,
        now: new Date("2025-01-01T00:02:00.000Z"),
      })
    ).toBe(false);
    // 异 agent → false
    expect(
      await findDuplicateNotification(notifyDb, {
        agentId: 6,
        type: "task_approved",
        taskId: 7,
        windowMs: NOTIFICATION_DEDUP_WINDOW_MS,
        now,
      })
    ).toBe(false);
    // 异 type → false
    expect(
      await findDuplicateNotification(notifyDb, {
        agentId: 5,
        type: "task_rejected",
        taskId: 7,
        windowMs: NOTIFICATION_DEDUP_WINDOW_MS,
        now,
      })
    ).toBe(false);
  });

  it("taskId=null 的记录只被 null 查询命中，不被 taskId=123 命中", async () => {
    await db.insert(notifications).values({
      agentId: 5,
      type: "budget_exhausted",
      taskId: null,
      title: "a",
      body: "b",
      createdAt: new Date("2025-01-01T00:00:00.000Z"),
    });
    const now = new Date("2025-01-01T00:00:30.000Z");

    expect(
      await findDuplicateNotification(notifyDb, {
        agentId: 5,
        type: "budget_exhausted",
        taskId: null,
        windowMs: NOTIFICATION_DEDUP_WINDOW_MS,
        now,
      })
    ).toBe(true);
    expect(
      await findDuplicateNotification(notifyDb, {
        agentId: 5,
        type: "budget_exhausted",
        taskId: 123,
        windowMs: NOTIFICATION_DEDUP_WINDOW_MS,
        now,
      })
    ).toBe(false);
  });
});
