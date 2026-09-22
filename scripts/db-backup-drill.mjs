#!/usr/bin/env node
/**
 * 数据库一致备份的**恢复演练**脚本（Phase B §4）。
 *
 * 用途：定期复核"备份到底能不能用"。备份最常见的失效不是"没备份"，
 * 而是备份其实不可用却没人知道——所以除了自动快照，还需要这个演练。
 *
 * 安全性质（重要）：
 *   - 对生产库**只读**：只做 VACUUM INTO / PRAGMA / SELECT，不写库、不改库。
 *   - 所有副本只落在 os.tmpdir()，结束时删除（无论成败）。
 *   - 不碰生产的数据目录，也不覆盖任何既有文件。
 *
 * 用法（容器内）：
 *   node scripts/db-backup-drill.mjs
 *   node scripts/db-backup-drill.mjs /app/data/tiangong-artifacts/tiangong.db
 *
 * 退出码：0 = 演练通过；1 = 不一致或出错（便于 CI/巡检判定）。
 * 注：真实恢复（把快照铺回生产路径）不在本脚本范围——那需要停写窗口。
 */

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const TABLES = ["tasks", "agents", "task_artifacts", "task_outbox_events", "notifications"];

const root = process.env.TIANGONG_ARTIFACT_ROOT || "/app/data/tiangong-artifacts";
const dbPath = process.argv[2] || path.join(root, "tiangong.db");
const snapPath = path.join(tmpdir(), "tiangong-drill-snapshot.db");
const restoredPath = path.join(tmpdir(), "tiangong-drill-restored.db");

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(2);

function countsOf(db) {
  const out = {};
  for (const table of TABLES) {
    try {
      out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n;
    } catch {
      out[table] = "n/a";
    }
  }
  return out;
}

function cleanup() {
  for (const p of [snapPath, restoredPath]) {
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      /* 尽力而为 */
    }
  }
}

function fail(message) {
  console.error(`演练结论: 失败 — ${message}`);
  cleanup();
  process.exit(1);
}

if (!existsSync(dbPath)) fail(`源库不存在：${dbPath}`);
cleanup(); // 清掉上次可能的残留

try {
  console.log(`源库: ${dbPath} (${mb(dbPath)} MB)`);

  // 对生产库只读：VACUUM INTO / PRAGMA / SELECT
  const live = new DatabaseSync(dbPath);
  console.log("journal_mode:", JSON.stringify(live.prepare("PRAGMA journal_mode").get()));
  const liveCounts = countsOf(live);
  console.log("源库行数:", JSON.stringify(liveCounts));

  // ① 一致快照（生产库正在被应用写入的情况下做）
  live.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
  console.log(`① 快照已生成: ${mb(snapPath)} MB`);

  // ② 校验
  const snap = new DatabaseSync(snapPath);
  const integrity = snap.prepare("PRAGMA integrity_check").get()?.integrity_check;
  const tableCount = snap.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get()?.n;
  console.log(`② 快照 integrity_check=${integrity}，表数=${tableCount}`);
  const snapCounts = countsOf(snap);
  snap.close();

  // ③ 恢复演练：恢复到新路径，再用真实驱动查询（不是"文件存在"就算）
  copyFileSync(snapPath, restoredPath);
  const restored = new DatabaseSync(restoredPath);
  const restoredCounts = countsOf(restored);
  const sample = restored.prepare("SELECT task_id, status FROM tasks ORDER BY id DESC LIMIT 3").all();
  restored.close();
  live.close();

  console.log("③ 恢复后行数:", JSON.stringify(restoredCounts));
  console.log("   恢复后抽样:", JSON.stringify(sample));

  const consistent =
    integrity === "ok" &&
    JSON.stringify(liveCounts) === JSON.stringify(snapCounts) &&
    JSON.stringify(snapCounts) === JSON.stringify(restoredCounts);
  if (!consistent) fail("源库/快照/恢复三者不一致，或 integrity_check 未通过");

  console.log("演练结论: 通过（源库 = 快照 = 恢复）");
  cleanup();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
