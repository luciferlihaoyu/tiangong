/**
 * 可复用真实 SQLite 测试桩。
 *
 * 创建内存 SQLite + 按 drizzle schema 全量表建表 + 包裹生产环境的
 * node-sqlite adapter，返回与生产一致的 drizzle client。用于需要真实
 * SQL 行为才能验证的修复（outbox 查选、CAS 原子操作、同步事务等）。
 *
 * 使用方式：
 *   import { createTestDb } from "./helpers/test-db";
 *   const { db, dispose } = createTestDb();
 *   // … 用 db 做 drizzle 操作 …
 *   dispose();  // 归还内存
 */

import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as fullSchema from "@db/schema";
import { nodeSqliteAdapter } from "../../../api/lib/node-sqlite-adapter";
import { CREATE_TABLES_SQL } from "../../../api/lib/auto-migrate";
import { readiness } from "../../../api/lib/readiness";

/**
 * 把进程就绪状态置为"已就绪"。
 *
 * Phase B §2 起，认领入口（claimNextTask）与事件派发循环都有就绪闸门——
 * 迁移/schema 对齐/执行器/派发未就绪时一律不接单（fail-closed）。
 * 因此任何"验证认领/派发正常路径"的测试都必须先声明系统已就绪，
 * 否则会被闸门先挡住，测不到真正要测的东西。
 */
export function markSystemReady(): void {
  readiness.recordMigration(true);
  readiness.recordSchemaDrift([]);
  readiness.recordExecutor(true);
  readiness.recordOutbox(true);
}

export interface TestDb {
  /** drizzle client（与生产环境相同构造方式） */
  db: ReturnType<typeof drizzle<typeof fullSchema>>;
  /** 底层 node:sqlite handle（可直接 exec 原始 SQL） */
  raw: DatabaseSync;
  /** 归还内存 SQLite */
  dispose(): void;
}

export function createTestDb(): TestDb {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");

  // 按生产 schema 建全量表
  for (const sql of CREATE_TABLES_SQL) {
    raw.exec(sql);
  }

  // 用生产环境的 adapter 包裹，drizzle 把 node:sqlite 当成 better-sqlite3 用
  const db = drizzle(nodeSqliteAdapter(raw), { schema: fullSchema });

  return { db, raw, dispose: () => raw.close() };
}