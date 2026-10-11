import { describe, expect, it } from "vitest";
import { summarizeTodayTasks } from "../../src/lib/todayTasks";

const NOW = new Date("2026-02-11T12:00:00");
const hoursAgoIso = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const todayIso = () => hoursAgoIso(1);
const yesterdayIso = hoursAgoIso(24);

describe("summarizeTodayTasks（今日任务活跃口径）", () => {
  it("主数值只数今日活跃（pending/queued/running），done/failed 只进副标题口径", () => {
    const tasks = [
      { status: "running", updatedAt: todayIso() },
      { status: "pending", createdAt: todayIso() },
      { status: "queued", updatedAt: hoursAgoIso(2) },
      { status: "done", updatedAt: todayIso() },
      { status: "done", updatedAt: hoursAgoIso(3) },
      { status: "failed", updatedAt: todayIso() },
    ];
    expect(summarizeTodayTasks(tasks, NOW)).toEqual({ active: 3, done: 2, failed: 1 });
  });

  it("昨天创建、昨天完成的任务不计入今日任何口径", () => {
    const tasks = [
      { status: "done", updatedAt: yesterdayIso },
      { status: "running", updatedAt: yesterdayIso },
      { status: "pending", createdAt: yesterdayIso },
    ];
    expect(summarizeTodayTasks(tasks, NOW)).toEqual({ active: 0, done: 0, failed: 0 });
  });

  it("updatedAt 缺省时回退 createdAt；完全无时间戳的任务不计入", () => {
    const tasks = [
      { status: "running", createdAt: todayIso() },
      { status: "done" },
    ];
    expect(summarizeTodayTasks(tasks, NOW)).toEqual({ active: 1, done: 0, failed: 0 });
  });

  it("今天没有任何任务时返回全 0——不允许再用全量任务数兜底", () => {
    const tasks = [{ status: "done", updatedAt: yesterdayIso }];
    expect(summarizeTodayTasks(tasks, NOW)).toEqual({ active: 0, done: 0, failed: 0 });
  });

  it("非法时间字符串按缺失处理，不抛异常", () => {
    const tasks = [
      { status: "running", updatedAt: "not-a-date" },
      { status: "done", createdAt: "also-bad" },
    ];
    expect(summarizeTodayTasks(tasks, NOW)).toEqual({ active: 0, done: 0, failed: 0 });
  });
});
