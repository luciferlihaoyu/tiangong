/**
 * DbBackup 单元测试（2026-11-14 碧霄，随 A1 修复固化）。
 *
 * 锁住两件事：
 * 1. listSnapshots 只认严格快照名 —— 手工留底（tiangong-pre-tsfix-*.db 之类）
 *    不得参与节流/轮换。这是"每分钟全库 VACUUM 一次"事故（11-03 手工留底
 *    被当最新快照打穿 1 天节流）的回归防线。
 * 2. 快照 → 校验 → 轮换整链可用，轮换永不删手工留底。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createConsistentSnapshot,
  listSnapshots,
  pruneSnapshots,
  verifySnapshot,
} from "../api/lib/db-backup";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tg-dbbackup-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个最小可用的 SQLite 库文件（1 张表 1 行），VACUUM INTO 才能工作。 */
function seedSourceDb(name: string): string {
  const src = path.join(dir, name);
  writeFileSync(src, Buffer.alloc(0));
  return src;
}

describe("listSnapshots 快照名识别", () => {
  it("只认 tiangong-YYYYMMDD-HHMMSS.db，手工留底不算快照", () => {
    writeFileSync(path.join(dir, "tiangong-20261114-131710.db"), "x");
    // 事故主角形状：合法前缀+后缀，但名字段不是时间戳
    writeFileSync(path.join(dir, "tiangong-pre-tsfix-20261103-224815.db"), "x");
    writeFileSync(path.join(dir, "tiangong-pre-pluginfix-20261103-124445.db"), "x");
    writeFileSync(path.join(dir, "readme.txt"), "x");
    writeFileSync(path.join(dir, "tiangong-20261114-notime.db"), "x");

    const snaps = listSnapshots(dir);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].name).toBe("tiangong-20261114-131710.db");
  });

  it("按文件名时间升序（旧→新），createdAt 用 UTC 解析", () => {
    writeFileSync(path.join(dir, "tiangong-20261114-090000.db"), "x");
    writeFileSync(path.join(dir, "tiangong-20261113-090000.db"), "x");
    writeFileSync(path.join(dir, "tiangong-20261114-130000.db"), "x");

    const snaps = listSnapshots(dir);
    expect(snaps.map((s) => s.name)).toEqual([
      "tiangong-20261113-090000.db",
      "tiangong-20261114-090000.db",
      "tiangong-20261114-130000.db",
    ]);
    // 2026-11-14T09:00:00Z
    expect(snaps[2].createdAt.toISOString()).toBe("2026-11-14T13:00:00.000Z");
  });
});

describe("pruneSnapshots 轮换", () => {
  it("保留最新 keep 份真快照；手工留底永不入列、永不被删", () => {
    const manual = path.join(dir, "tiangong-pre-tsfix-20261103-224815.db");
    writeFileSync(manual, "precious");
    for (const t of ["010000", "020000", "030000", "040000", "050000"]) {
      writeFileSync(path.join(dir, `tiangong-20261114-${t}.db`), "x");
    }

    const pruned = pruneSnapshots(dir, 2);
    expect(pruned.kept).toEqual(["tiangong-20261114-040000.db", "tiangong-20261114-050000.db"]);
    // 手工留底分毫不动
    expect(() => expect(manual).not.toBeUndefined()).toBeTruthy();
    const { statSync } = require("node:fs") as typeof import("node:fs");
    expect(statSync(manual).size).toBe("precious".length);
    // 目录里真快照只剩 2 份 + 手工留底
    const remaining = listSnapshots(dir).length;
    expect(remaining).toBe(2);
  });

  it("runBackupJob 的 keep=0 表示不轮换（pruneSnapshots 本身 keep=0 = 保留 0 份）", async () => {
    const { runBackupJob } = await import("../api/lib/db-backup");
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const src = path.join(dir, "src.db");
    writeFileSync(src, Buffer.alloc(0));
    const db = new DatabaseSync(src);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    db.close();

    // 预置 2 份旧快照
    writeFileSync(path.join(dir, "tiangong-20261114-010000.db"), "x");
    writeFileSync(path.join(dir, "tiangong-20261114-020000.db"), "x");

    const report = await runBackupJob({
      dbPath: src,
      destDir: dir,
      keep: 0,
      now: new Date("2026-11-14T12:00:00Z"),
    });
    expect(report.ok).toBe(true);
    expect(report.pruned).toBeUndefined();
    // 2 份旧快照 + 本次新生成 = 3 份全保留
    expect(listSnapshots(dir)).toHaveLength(3);
  });
});

describe("快照 → 校验整链", () => {
  it("VACUUM INTO 产物通过 integrity_check，且能被 listSnapshots 识别", () => {
    const src = seedSourceDb("source.db");
    // 建表造数据的源库
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(src);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    db.prepare("INSERT INTO t (v) VALUES (?)").run("hello");
    db.close();

    const snap = createConsistentSnapshot(src, dir, new Date("2026-11-14T12:00:00Z"));
    expect(snap.name).toBe("tiangong-20261114-120000.db");

    const verification = verifySnapshot(snap.path);
    expect(verification.ok).toBe(true);
    expect(verification.tables).toBeGreaterThanOrEqual(1);

    expect(listSnapshots(dir).map((s) => s.name)).toContain(snap.name);
  });

  it("非 SQLite 文件快照校验失败（坏快照必须可识别）", () => {
    const garbage = path.join(dir, "tiangong-20261114-010000.db");
    writeFileSync(garbage, "not a database at all");
    const verification = verifySnapshot(garbage);
    expect(verification.ok).toBe(false);
  });
});
