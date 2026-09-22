import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CREATE_TABLES_SQL } from "../../api/lib/auto-migrate";

// setup.ts 把 connection mock 成只有 getDb，会让 sweeper 里的 resolveDbPath 变成
// undefined；这里保留真实实现（否则测不到"备份哪个库"这件事）。
vi.mock("../../api/queries/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/queries/connection")>();
  return { ...actual, getDb: vi.fn() };
});

/**
 * 定时备份 sweeper（Phase B §4）的行为测试。
 *
 * 重点验证**节流**与**未就绪不备**这两条最容易被写错的判断：
 *   - 备份有成本，不能每个 sweep tick（默认 60s）都跑
 *   - 未就绪时快照出来的是半迁移的库，而轮换按时间淘汰旧份 →
 *     让坏快照挤掉好备份是净损失，宁可不备
 */

const READY_STATE = { ready: true };

async function loadSweeper(opts: { intervalMs: string; artifactRoot: string; dbPath: string }) {
  process.env.TIANGONG_ARTIFACT_ROOT = opts.artifactRoot;
  process.env.TIANGONG_DB_BACKUP_INTERVAL_MS = opts.intervalMs;
  process.env.DATABASE_URL = opts.dbPath;
  vi.resetModules();

  const readiness = await import("../../api/lib/readiness");
  if (READY_STATE.ready) {
    readiness.readiness.recordMigration(true);
    readiness.readiness.recordSchemaDrift([]);
    readiness.readiness.recordExecutor(true);
    readiness.readiness.recordOutbox(true);
  }
  const sweeper = await import("../../api/lib/sweepers/db-backup");
  return { sweeper, readiness };
}

function makeSourceDb(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  try {
    for (const sql of CREATE_TABLES_SQL) raw.exec(sql);
    raw
      .prepare(
        `INSERT INTO tasks (task_id, name, description, priority, status, lifecycle_status)
         VALUES ('TG-SWEEP', '定时备份用任务', 'd', 0, 'queued', 'created')`,
      )
      .run();
  } finally {
    raw.close();
  }
}

describe("定时备份 sweeper", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    READY_STATE.ready = true;
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.resetModules();
  });

  it("首次 sweep 生成快照，并把结果暴露给管理端点", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-sweep-"));
    try {
      const dbPath = path.join(dir, "tiangong.db");
      const root = path.join(dir, "artifacts");
      makeSourceDb(dbPath);
      const { sweeper } = await loadSweeper({
        intervalMs: String(86_400_000),
        artifactRoot: root,
        dbPath,
      });

      await sweeper.sweepDbBackup(null, new Date("2026-09-18T03:00:00Z"));

      const state = sweeper.backupSweepState();
      expect(state.snapshots).toHaveLength(1);
      expect(state.lastReport?.ok).toBe(true);
      expect(state.lastRunAt).toBe("2026-09-18T03:00:00.000Z");
      expect(readdirSync(path.join(root, "backups"))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("距上次备份未超过间隔则跳过（备份不该每 tick 都跑）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-sweep-throttle-"));
    try {
      const dbPath = path.join(dir, "tiangong.db");
      const root = path.join(dir, "artifacts");
      makeSourceDb(dbPath);
      const { sweeper } = await loadSweeper({
        intervalMs: String(86_400_000),
        artifactRoot: root,
        dbPath,
      });

      await sweeper.sweepDbBackup(null, new Date("2026-09-18T03:00:00Z"));
      await sweeper.sweepDbBackup(null, new Date("2026-09-18T09:00:00Z")); // 6 小时后

      const state = sweeper.backupSweepState();
      expect(state.snapshots).toHaveLength(1);
      expect(state.skippedReason).toMatch(/未超过间隔/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("超过间隔后再备一份，并按保留份数轮换", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-sweep-next-"));
    try {
      const dbPath = path.join(dir, "tiangong.db");
      const root = path.join(dir, "artifacts");
      makeSourceDb(dbPath);
      const { sweeper } = await loadSweeper({
        intervalMs: String(3_600_000), // 1 小时
        artifactRoot: root,
        dbPath,
      });

      await sweeper.sweepDbBackup(null, new Date("2026-09-18T03:00:00Z"));
      await sweeper.sweepDbBackup(null, new Date("2026-09-18T05:00:00Z"));

      const state = sweeper.backupSweepState();
      expect(state.snapshots).toHaveLength(2);
      expect(state.skippedReason).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("系统未就绪时跳过备份（不让半迁移的快照挤掉好备份）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-sweep-notready-"));
    try {
      const dbPath = path.join(dir, "tiangong.db");
      const root = path.join(dir, "artifacts");
      makeSourceDb(dbPath);
      READY_STATE.ready = false;
      const { sweeper } = await loadSweeper({
        intervalMs: String(86_400_000),
        artifactRoot: root,
        dbPath,
      });

      await sweeper.sweepDbBackup(null, new Date("2026-09-18T03:00:00Z"));

      const state = sweeper.backupSweepState();
      expect(state.snapshots).toHaveLength(0);
      expect(state.skippedReason).toMatch(/未就绪/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
