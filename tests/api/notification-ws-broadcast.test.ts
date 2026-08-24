/**
 * 通知中心 t1：recordNotification 写库成功后推 notification_created dashboard 事件
 *
 * 覆盖：
 *   - 正常 insert 后触发一次 broadcast（type=notification_created + notification.type/title/body）
 *   - broadcast 抛错被独立 try/catch 吞掉（recordNotification 永不抛错语义）
 *   - null agentId 早退 → 不 broadcast
 *   - dedup 命中（60s 窗口内同 type+taskId）→ 第二次不 broadcast
 *
 * wsManager 以 hoisted 对象 mock（同 notification-hooks / xuanji-lesson 模式），
 * db 用 tests/api/helpers/fake-db.ts（真实 where 求值 + createdAt 默认），
 * 防抖窗口用 vi.useFakeTimers + setSystemTime 确定性控制。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakeDb } from "./helpers/fake-db";
import { notifications } from "@db/schema";
import type { RecordNotificationInput } from "../../api/lib/notification";
import { recordNotification } from "../../api/lib/notification";

// wsManager 以 hoisted 对象暴露：断言调用 + mockImplementationOnce 驱动广播异常路径
const wsMocks = vi.hoisted(() => ({
  broadcastToDashboard: vi.fn(),
  broadcast: vi.fn(),
  sendToAgent: vi.fn(),
  isOnline: vi.fn(() => false),
}));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));

const db = createFakeDb();
const notifyDb = db as unknown as Parameters<typeof recordNotification>[0];

const T = new Date("2025-01-01T00:00:00.000Z");

beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  wsMocks.broadcastToDashboard.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
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

describe("recordNotification broadcast（t1）", () => {
  it("正常 insert 后触发一次 broadcast，事件为 notification_created 且含通知字段", async () => {
    await recordNotification(notifyDb, baseInput());

    expect(wsMocks.broadcastToDashboard).toHaveBeenCalledTimes(1);
    const event = wsMocks.broadcastToDashboard.mock.calls[0]?.[0] as {
      type: string;
      notification: Record<string, unknown>;
    };
    expect(event.type).toBe("notification_created");
    expect(event.notification).toMatchObject({
      type: "task_approved",
      agentId: 5,
      taskId: 7,
      title: "审批通过：生成周报",
      body: "任务已批准执行",
      readAt: null,
    });
    expect(db.rowsOfTable(notifications)).toHaveLength(1);
  });

  it("broadcast 抛错被吞：recordNotification 正常返回且行已落库", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    wsMocks.broadcastToDashboard.mockImplementationOnce(() => {
      throw new Error("ws boom");
    });

    await expect(recordNotification(notifyDb, baseInput())).resolves.toBeUndefined();
    expect(db.rowsOfTable(notifications)).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("broadcast failed"));
    warnSpy.mockRestore();
  });

  it("null agentId 早退 → 不触发 broadcast", async () => {
    await recordNotification(notifyDb, baseInput({ agentId: null }));
    expect(wsMocks.broadcastToDashboard).not.toHaveBeenCalled();
    expect(db.rowsOfTable(notifications)).toHaveLength(0);
  });

  it("dedup 命中（60s 窗口内同 type+taskId）→ 第二次不 broadcast", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    await recordNotification(notifyDb, baseInput());
    await recordNotification(notifyDb, baseInput());

    expect(wsMocks.broadcastToDashboard).toHaveBeenCalledTimes(1);
    expect(db.rowsOfTable(notifications)).toHaveLength(1);
  });
});
