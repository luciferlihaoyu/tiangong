import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CREATE_TABLES_SQL } from "../../api/lib/auto-migrate";
import {
  createConsistentSnapshot,
  listSnapshots,
  pruneSnapshots,
  restoreSnapshot,
  runBackupJob,
  verifySnapshot,
} from "../../api/lib/db-backup";

/**
 * 一致备份与恢复演练（Phase B §4）。
 *
 * 原状况：仓库里唯一的"备份"是 scripts/backup.sh——它抓的是 tRPC 读接口的
 * JSON 投影（还 limit=1000），不是数据库；抓了 tasks/usage 却没有对应恢复逻辑
 * （restore 只恢复 agents+pricing）；base URL 还是过期的；无条件打印"备份完成"。
 * 也就是说：**从来没有过一个可恢复的备份，也从没做过恢复演练**。
 *
 * 这里验证的是真契约，用真实 node:sqlite 驱动：
 *   - 用 VACUUM INTO 生成**时间点一致**的快照（未提交的写入不得进快照）
 *   - 快照必须能通过完整性校验，且损坏能被识别出来（校验不是摆设）
 *   - **恢复演练**：恢复到新路径后要用生产 adapter + drizzle 真查出数据，
 *     而不是"文件存在"就算成功
 *   - 轮换只删自己的快照，不误删同目录的无关文件
 */

const SNIPPET = `INSERT INTO tasks (task_id, name, description, priority, status, lifecycle_status)
   VALUES (?, ?, 'd', 0, 'queued', 'created')`;

function makeSourceDb(dbPath: string, taskIds: readonly string[] = ["TG-BK1"]): void {
  const raw = new DatabaseSync(dbPath);
  try {
    for (const sql of CREATE_TABLES_SQL) raw.exec(sql);
    for (const id of taskIds) raw.prepare(SNIPPET).run(id, `任务 ${id}`);
  } finally {
    raw.close();
  }
}

function countTasks(dbPath: string): number {
  const raw = new DatabaseSync(dbPath);
  try {
    return (raw.prepare("SELECT COUNT(*) AS n FROM tasks").get() as { n: number }).n;
  } finally {
    raw.close();
  }
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-backup-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("一致备份：快照", () => {
  it("快照内容与源库一致，且自身完整性校验通过", () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath, ["TG-BK1", "TG-BK2"]);
      const snapDir = path.join(dir, "backups");

      const snap = createConsistentSnapshot(dbPath, snapDir);

      expect(existsSync(snap.path)).toBe(true);
      expect(snap.bytes).toBeGreaterThan(0);
      expect(countTasks(snap.path)).toBe(2);
      const check = verifySnapshot(snap.path);
      expect(check.ok).toBe(true);
      expect(check.tables).toBeGreaterThan(40); // 生产 schema 全量
    });
  });

  it("快照是时间点一致的：未提交的写入进不了快照，提交后才进", () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath, ["TG-BK1"]);
      const snapDir = path.join(dir, "backups");

      // 另一个连接开着**未提交**的写事务（真实并发形态）
      const writer = new DatabaseSync(dbPath);
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare(SNIPPET).run("TG-UNCOMMITTED", "未提交的任务");

      const snapDuringTxn = createConsistentSnapshot(dbPath, snapDir, new Date("2026-09-18T10:00:00Z"));
      // 关键断言：快照看不到未提交的数据 —— 否则"一致备份"是假的
      expect(countTasks(snapDuringTxn.path)).toBe(1);

      writer.exec("COMMIT");
      writer.close();

      const snapAfterCommit = createConsistentSnapshot(dbPath, snapDir, new Date("2026-09-18T11:00:00Z"));
      expect(countTasks(snapAfterCommit.path)).toBe(2);
    });
  });

  it("目标已存在时明确失败，不静默覆盖既有备份", () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath);
      const snapDir = path.join(dir, "backups");
      const at = new Date("2026-09-18T00:00:00Z");

      const first = createConsistentSnapshot(dbPath, snapDir, at);
      // 同一时间点再来一次：必须报错，而不是把已有的那份覆盖掉
      expect(() => createConsistentSnapshot(dbPath, snapDir, at)).toThrow(/already exists|已存在/i);

      const stillThere = verifySnapshot(first.path);
      expect(stillThere.ok).toBe(true);
    });
  });
});

describe("一致备份：校验与恢复演练", () => {
  it("损坏的快照会被校验识别出来（校验不是摆设）", () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath, ["TG-BK1", "TG-BK2"]);
      const snap = createConsistentSnapshot(dbPath, path.join(dir, "backups"));
      expect(verifySnapshot(snap.path).ok).toBe(true);

      // 破坏页内容（模拟磁盘损坏/截断写入）
      const bytes = readFileSync(snap.path);
      bytes.fill(0xff, 100, 4096);
      writeFileSync(snap.path, bytes);

      const check = verifySnapshot(snap.path);
      expect(check.ok).toBe(false);
      expect(check.detail.length).toBeGreaterThan(0);
    });
  });

  it("恢复演练：恢复到新路径后能用生产 adapter + drizzle 真查出数据", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-restore-"));
    try {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath, ["TG-BK1", "TG-BK2"]);
      const snap = createConsistentSnapshot(dbPath, path.join(dir, "backups"));
      const targetPath = path.join(dir, "restored.db");

      const restored = restoreSnapshot(snap.path, targetPath);
      expect(restored.ok).toBe(true);
      expect(countTasks(targetPath)).toBe(2);

      // 不只是"文件存在"：用生产同款 adapter + drizzle 走一遍真实查询
      const { drizzle } = await import("drizzle-orm/better-sqlite3");
      const { nodeSqliteAdapter } = await import("../../api/lib/node-sqlite-adapter");
      const schema = await import("@db/schema");
      const raw = new DatabaseSync(targetPath);
      try {
        const db = drizzle(nodeSqliteAdapter(raw), { schema });
        const rows = db.select().from(schema.tasks).all() as Array<{ taskId: string }>;
        expect(rows.map((r) => r.taskId).sort()).toEqual(["TG-BK1", "TG-BK2"]);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("恢复时目标已存在必须拒绝，避免误覆盖正在使用的库", () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath);
      const snap = createConsistentSnapshot(dbPath, path.join(dir, "backups"));
      const targetPath = path.join(dir, "restored.db");
      restoreSnapshot(snap.path, targetPath);

      expect(() => restoreSnapshot(snap.path, targetPath)).toThrow(/already exists|已存在/i);
    });
  });
});

describe("一致备份：轮换", () => {
  it("只保留最新 N 个，且不误删同目录的无关文件", () => {
    withTempDir((dir) => {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath);
      const snapDir = path.join(dir, "backups");

      createConsistentSnapshot(dbPath, snapDir, new Date("2026-09-16T00:00:00Z"));
      createConsistentSnapshot(dbPath, snapDir, new Date("2026-09-17T00:00:00Z"));
      const newest = createConsistentSnapshot(dbPath, snapDir, new Date("2026-09-18T00:00:00Z"));
      writeFileSync(path.join(snapDir, "notes.txt"), "hand written, not a snapshot");

      const before = listSnapshots(snapDir);
      expect(before).toHaveLength(3);

      const result = pruneSnapshots(snapDir, 2);

      expect(result.removed).toHaveLength(1);
      expect(result.removed[0]).toMatch(/20260916/);
      const names = readdirSync(snapDir).sort();
      expect(names).toContain("notes.txt"); // 无关文件不动
      expect(names).toContain(path.basename(newest.path));
      expect(listSnapshots(snapDir)).toHaveLength(2);
    });
  });
});

describe("一致备份：一条龙备份任务", () => {
  it("快照 → 校验 → 离机上传 → 轮换，报告可读", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-job-"));
    try {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath, ["TG-BK1", "TG-BK2"]);
      const snapDir = path.join(dir, "backups");
      const uploaded: Array<{ name: string; bytes: number }> = [];

      const report = await runBackupJob({
        dbPath,
        destDir: snapDir,
        keep: 3,
        now: new Date("2026-09-18T03:00:00Z"),
        upload: async (name, bytes) => {
          uploaded.push({ name, bytes: bytes.length });
          return `/tiangong/backup/${name}`;
        },
      });

      expect(report.ok).toBe(true);
      expect(report.verification?.ok).toBe(true);
      expect(report.uploadedTo).toBe("/tiangong/backup/tiangong-20260918-030000.db");
      expect(report.uploadError).toBeUndefined();
      expect(uploaded).toHaveLength(1);
      expect(uploaded[0].bytes).toBeGreaterThan(0);
      expect(existsSync(report.snapshot!.path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("离机上传失败不丢本地快照：本地可用，上传失败只作降级上报", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-job-up-"));
    try {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath, ["TG-BK1"]);
      const snapDir = path.join(dir, "backups");

      const report = await runBackupJob({
        dbPath,
        destDir: snapDir,
        upload: async () => {
          throw new Error("AList 上传失败: HTTP 502");
        },
      });

      // 本地一致快照仍然成立（这才是"数据不丢"的底线）
      expect(report.ok).toBe(true);
      expect(report.uploadError).toMatch(/502/);
      expect(existsSync(report.snapshot!.path)).toBe(true);
      expect(countTasks(report.snapshot!.path)).toBe(1);
      // 且这份快照确实能用（校验过）
      expect(verifySnapshot(report.snapshot!.path).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("源库不存在时不抛异常，而是给出可读失败报告（巡检不该炸）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-job-miss-"));
    try {
      const report = await runBackupJob({
        dbPath: path.join(dir, "nope.db"),
        destDir: path.join(dir, "backups"),
      });
      expect(report.ok).toBe(false);
      expect(report.detail).toMatch(/源库不存在|不存在/);
      expect(report.snapshot).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("轮换在一条龙里生效：超过保留份数后只留最新 N 份", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tg-job-prune-"));
    try {
      const dbPath = path.join(dir, "tiangong.db");
      makeSourceDb(dbPath);
      const snapDir = path.join(dir, "backups");

      for (const day of ["16", "17", "18"]) {
        await runBackupJob({
          dbPath,
          destDir: snapDir,
          keep: 2,
          now: new Date(`2026-09-${day}T00:00:00Z`),
        });
      }

      const remaining = listSnapshots(snapDir).map((s) => s.name);
      expect(remaining).toHaveLength(2);
      expect(remaining[0]).toMatch(/20260917/);
      expect(remaining[1]).toMatch(/20260918/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
