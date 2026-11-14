/**
 * day-sql 日聚合表达式测试（2026-11-14 碧霄，随审计修复固化）。
 *
 * 锁住两个行为：
 * 1. 表达式带 'localtime' —— 「今日」按部署环境本地时区（容器 TZ=Asia/Shanghai）聚合，
 *    与 ops-router 的 setHours(0,0,0,0)、前端 localDayKey 同口径。
 *    （事故：DATE(x,'unixepoch') 默认按 UTC 解释，北京时间 0~8 点被划到前一天，
 *    首页「今日成本」与用量页差一天。）
 * 2. 整数秒与 ISO 文本两种历史形态都能归一出日期（白屏事故防线：不得返回 NULL）。
 */
import { DatabaseSync } from "node:sqlite";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { sqlDayOf } from "../api/lib/day-sql";

/** 把 drizzle SQL 模板摊平成可读文本（chunk 仅 StringChunk 与 Column 两种）。 */
function sqlText(expr: ReturnType<typeof sql<string>>): string {
  return expr.queryChunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const maybe = chunk as { value?: unknown; name?: unknown };
      // drizzle placeholder（sql`?` 的参数槽）——输出占位符本身
      if (typeof maybe.name === "string") return "?";
      if (Array.isArray(maybe.value)) return (maybe.value as string[]).join("");
      if (typeof maybe.value === "string") return maybe.value;
      return "?";
    })
    .join("");
}

describe("sqlDayOf 表达式", () => {
  it("带 unixepoch 与 localtime 修饰符（本地日口径）", () => {
    const text = sqlText(sqlDayOf(sql`created_at`));
    expect(text).toContain("'unixepoch'");
    expect(text).toContain("'localtime'");
  });

  it("整数秒与 ISO 文本都归一为日期、且凌晨样本按本地日（node:sqlite 实执行）", () => {
    const expr = sqlText(sqlDayOf(sql`?`));
    const db = new DatabaseSync(":memory:");
    const q = (v: number | string) => String(db.prepare(`SELECT ${expr} AS d`).get(v, v)?.d);

    // CST 2026-11-13 04:00 = UTC 2026-11-12 20:00 —— UTC 日是 11-12，本地日必须是 11-13
    const cstEarlyMorning = Math.floor(Date.parse("2026-11-13T04:00:00+08:00") / 1000);
    expect(q(cstEarlyMorning)).toBe("2026-11-13");

    // CST 白天样本两种口径一致，不得回归
    const cstDaytime = Math.floor(Date.parse("2026-11-12T22:28:00+08:00") / 1000);
    expect(q(cstDaytime)).toBe("2026-11-12");

    // MySQL 迁移遗留的 ISO 文本形态也要能解析（不得返回 NULL —— 9-13 白屏事故防线）
    expect(q("2026-11-12T14:28:37Z")).toBe("2026-11-12");
  });
});
