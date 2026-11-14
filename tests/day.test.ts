/**
 * 本地日口径与看板状态映射测试（2026-11-14 碧霄，随审计修复固化）。
 * 锁住「今日」的本地时区口径 —— 防止有人再写回 toISOString（UTC 日）。
 */
import { describe, expect, it } from "vitest";

import { localDayKey, localDayRange } from "../src/lib/day";
import { BOARD_TO_LIFECYCLE } from "../src/lib/taskStatus";

describe("localDayKey 本地日", () => {
  it("按本地时区取日期，不是 UTC", () => {
    // 该时刻 UTC 是 11-13，东八区已是 11-14 —— localDayKey 必须取 11-14
    const d = new Date(Date.UTC(2026, 10, 13, 17, 30, 0)); // UTC 17:30 = CST 次日 01:30
    expect(localDayKey(d)).toBe("2026-11-14");
  });

  it("与 toISOString（UTC 日）在跨日时段必然不同", () => {
    const d = new Date(Date.UTC(2026, 10, 13, 16, 0, 0)); // UTC 16:00 = CST 次日 00:00
    expect(localDayKey(d)).not.toBe(d.toISOString().slice(0, 10));
  });

  it("格式恒为 YYYY-MM-DD 补零", () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("localDayRange 本地日边界", () => {
  it("不带 Z 后缀（由运行环境按本地时区解释）且覆盖全天", () => {
    const r = localDayRange("2026-11-14");
    expect(r.from).toBe("2026-11-14T00:00:00");
    expect(r.to).toBe("2026-11-14T23:59:59.999");
    expect(r.from.endsWith("Z")).toBe(false);
  });
});

describe("BOARD_TO_LIFECYCLE 看板→生命周期映射", () => {
  it("覆盖全部 10 个看板态，无一遗漏", () => {
    const boardStatuses = [
      "triage",
      "backlog",
      "todo",
      "ready",
      "running",
      "review",
      "blocked",
      "done",
      "failed",
      "cancelled",
    ];
    for (const b of boardStatuses) {
      expect(BOARD_TO_LIFECYCLE[b], `缺少看板态 ${b}`).toBeTruthy();
    }
    expect(Object.keys(BOARD_TO_LIFECYCLE)).toHaveLength(10);
  });

  it("triage 归入「待处理」——新建任务必须能被「待处理」筛选到（事故回归）", () => {
    expect(BOARD_TO_LIFECYCLE.triage).toBe("pending");
    expect(BOARD_TO_LIFECYCLE.blocked).toBe("pending");
    expect(BOARD_TO_LIFECYCLE.todo).toBe("queued");
    expect(BOARD_TO_LIFECYCLE.review).toBe("running");
    expect(BOARD_TO_LIFECYCLE.cancelled).toBe("failed");
  });
});
