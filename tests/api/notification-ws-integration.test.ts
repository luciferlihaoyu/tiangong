/**
 * 通知中心 t3：recordNotification → broadcastToDashboard 端到端集成测试
 *
 * 与 t1（notification-ws-broadcast.test.ts）互补：
 *   - t1 单元级：mock 掉整个 ws-manager，关注 broadcast 异常 / 去重 / 早退路径
 *   - t3 端到端 fake 模式：调真实 recordNotification（写 fake db + 触发
 *     broadcastToDashboard），断言事件 shape 完整（type/title/body/createdAt/readAt）
 *
 * wsManager 以 hoisted importActual 方式 mock：保留真实单例的其余方法，仅把
 * broadcastToDashboard 替换为 vi.fn。db 用 tests/api/helpers/fake-db.ts
 * （真实 where 求值 + createdAt 默认），防抖窗口用 fake timers 确定性控制。
 * 不需要起真实 WebSocket server——mock 掉 broadcastToDashboard 即可。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakeDb } from "./helpers/fake-db";
import { notifications } from "@db/schema";
import { recordNotification } from "../../api/lib/notification";
import type { RecordNotificationInput } from "../../api/lib/notification";
import { wsManager } from "../../api/ws-manager";

// hoisted：mock factory 与测试体共享同一个 broadcastToDashboard mock
const wsMocks = vi.hoisted(() => ({ broadcastToDashboard: vi.fn() }));
vi.mock("../../api/ws-manager", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/ws-manager")>("../../api/ws-manager");
  return {
    wsManager: {
      ...actual.wsManager,
      broadcastToDashboard: wsMocks.broadcastToDashboard,
    },
  };
});

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

/** 取第一次 broadcastToDashboard 的入参事件（payload） */
function lastEvent(): { type: string; notification: Record<string, unknown> } {
  return wsMocks.broadcastToDashboard.mock.calls[0]?.[0] as {
    type: string;
    notification: Record<string, unknown>;
  };
}

describe("recordNotification → broadcastToDashboard 集成（t3）", () => {
  it("完整 payload：调一次后 broadcast 一次，事件 shape 含 type/title/body/createdAt/readAt", async () => {
    await recordNotification(notifyDb, {
      agentId: 1,
      type: "lesson_recorded",
      taskId: 42,
      title: "测试",
      body: "测试失败",
      metadata: { foo: "bar" },
    });

    expect(wsManager.broadcastToDashboard).toHaveBeenCalledTimes(1);
    const event = lastEvent();
    expect(event.type).toBe("notification_created");

    const n = event.notification;
    expect(n.type).toBe("lesson_recorded");
    expect(n.title).toBe("测试");
    expect(n.body).toBe("测试失败");
    expect(n.agentId).toBe(1);
    expect(n.taskId).toBe(42);
    expect(n.metadata).toEqual({ foo: "bar" });

    expect(typeof n.createdAt).toBe("string");
    const createdAt = n.createdAt as string;
    expect(Number.isNaN(Date.parse(createdAt))).toBe(false);
    expect(new Date(createdAt).toISOString()).toBe(createdAt); // ISO 格式

    expect(n.readAt).toBeNull();
  });

  it("dedup 命中（60s 窗口内同 agentId+type+taskId）→ 第二次不重复 broadcast", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    const input: RecordNotificationInput = {
      agentId: 2,
      type: "task_completed",
      taskId: 9,
      title: "任务完成",
      body: "已完成",
    };

    await recordNotification(notifyDb, input);
    expect(wsManager.broadcastToDashboard).toHaveBeenCalledTimes(1);

    await recordNotification(notifyDb, input);
    expect(wsManager.broadcastToDashboard).toHaveBeenCalledTimes(1);
    expect(db.rowsOfTable(notifications)).toHaveLength(1);
  });

  it("null agentId → 早退，broadcast 0 次", async () => {
    await recordNotification(notifyDb, {
      agentId: null,
      type: "lesson_recorded",
      taskId: 42,
      title: "测试",
      body: "测试失败",
    });

    expect(wsManager.broadcastToDashboard).not.toHaveBeenCalled();
    expect(db.rowsOfTable(notifications)).toHaveLength(0);
  });

  it("落库与广播同时发生（非互斥）：1 行落库 + 1 次 broadcast", async () => {
    await recordNotification(notifyDb, {
      agentId: 3,
      type: "task_approved",
      taskId: 8,
      title: "审批通过",
      body: "已批准",
    });

    const rows = db.rowsOfTable(notifications);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("task_approved");
    expect(rows[0].title).toBe("审批通过");

    expect(wsManager.broadcastToDashboard).toHaveBeenCalledTimes(1);
    expect(lastEvent().notification.type).toBe("task_approved");
  });
});
