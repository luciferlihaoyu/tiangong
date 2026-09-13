/**
 * 2026-09-13 usage/ops 页面白屏事故回归测试。
 *
 * 根因：SQLite DATE() 对裸数字输入按 Julian day number 解释而非 unix 秒，
 * 因此 DATE(created_at)（integer timestamp 列）恒返回 NULL，byDay/modelDay
 * 聚合产出 date=null 分组，前端 d.date.slice(5) 直接抛 TypeError 白屏。
 *
 * 既有测试基建（usage-flow 的链式 mock、helpers/fake-db.ts）都不真正执行
 * SQL（见 fake-db.ts 头注释 "No real SQL is ever executed"），此类日期函数
 * bug 从源头就拦不住；本文件用真实 node:sqlite 执行生产同款聚合表达式
 * （经 drizzle SQLiteSyncDialect 渲染，与 usage-router/ops-router 出品一致）。
 */
import { DatabaseSync } from "node:sqlite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { tokenUsage } from "@db/schema";
import { sqlDayOf } from "../../api/lib/day-sql";

// 与 db/schema.ts 的 token_usage 对齐（本测试只用到聚合相关列）。
const CREATE_TOKEN_USAGE = `
CREATE TABLE token_usage (
  id integer PRIMARY KEY,
  model text NOT NULL,
  provider text DEFAULT 'unknown',
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  total_tokens integer NOT NULL DEFAULT 0,
  cached_prompt_tokens integer DEFAULT 0,
  uncached_prompt_tokens integer DEFAULT 0,
  call_count integer NOT NULL DEFAULT 1,
  cost_cents integer NOT NULL DEFAULT 0,
  cost_micros integer NOT NULL DEFAULT 0,
  currency text DEFAULT 'USD',
  exchange_rate text DEFAULT '1.0',
  cost_display text DEFAULT '0',
  task_id integer,
  agent_id integer,
  session_key text,
  source text DEFAULT 'manual',
  trace_id text,
  started_at integer,
  high_cost_model text DEFAULT 'false',
  created_at integer NOT NULL
);
`;

const sqlite = new DatabaseSync(":memory:");
const dialect = new SQLiteSyncDialect();

beforeAll(() => {
  sqlite.exec(CREATE_TOKEN_USAGE);
});

// 用例间清数据：共享内存库不清理会跨用例串数据（分组计数与 SUM 全都会漂移）。
beforeEach(() => {
  sqlite.exec("DELETE FROM token_usage");
});

/** 把共享表达式渲染成生产 SQL 文本（与 router 中 drizzle 生成一致）。 */
function dayExprText(): string {
  return dialect.sqlToQuery(sqlDayOf(tokenUsage.createdAt)).sql;
}

/** 复刻 usage-router.byDay 的聚合形态（同款表达式 + groupBy + orderBy）。 */
function byDayShape(): Array<{ date: string | null; total_tokens: number }> {
  const day = dayExprText();
  return sqlite
    .prepare(
      `SELECT ${day} AS date, COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM token_usage GROUP BY ${day} ORDER BY ${day} DESC`,
    )
    .all() as Array<{ date: string | null; total_tokens: number }>;
}

/** 通过 drizzle 语义插入一条整数秒记录（timestamp mode 存 unix 秒）。 */
function seedSeconds(id: number, epochSeconds: number) {
  sqlite
    .prepare(
      `INSERT INTO token_usage (id, model, created_at, total_tokens) VALUES (?, 'test-model', ?, 150)`,
    )
    .run(id, epochSeconds);
}

/** 直接插入一条文本 ISO 时间记录（模拟 MySQL 迁移遗留形态）。 */
function seedText(id: number, isoText: string) {
  sqlite
    .prepare(
      `INSERT INTO token_usage (id, model, created_at, total_tokens) VALUES (?, 'test-model', ?, 0)`,
    )
    .run(id, isoText);
}

describe("sqlDayOf — usage/ops 白屏事故回归（真实 SQLite 执行）", () => {
  it("整数秒 created_at 聚合出非空 YYYY-MM-DD 日期（事故形态：DATE() 恒 NULL）", () => {
    seedSeconds(1, 1757736000); // 2025-09-13 04:00:00 UTC
    seedSeconds(2, 1757736000);

    const rows = byDayShape();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.date, "聚合日期不得为 null/空（否则前端 date.slice 白屏）").toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    }
  });

  it("两个不同日期的数据按日期分成两组，而非全部塌缩进一个 NULL 组", () => {
    seedSeconds(3, 1757736000); // 2025-09-13
    seedSeconds(4, 1757822400); // 2025-09-14

    const rows = byDayShape();
    const dates = rows.map((r) => r.date).sort();
    expect(dates).toEqual(["2025-09-13", "2025-09-14"]);
  });

  it("混合整数秒与迁移遗留文本 ISO 时间，归一为同一日期分组", () => {
    seedSeconds(5, 1757736000); // 2025-09-13（drizzle 整数秒写入）
    seedText(6, "2025-09-13 04:00:00"); // 迁移遗留文本形态

    const rows = byDayShape();
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0].total_tokens).toBe(150);
  });
});
