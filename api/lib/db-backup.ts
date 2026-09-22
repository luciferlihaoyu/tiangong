/**
 * 一致备份与恢复（Phase B §4）。
 *
 * 为什么不用 cp：SQLite 的 .db 文件在有人正在写事务时被逐个 cp，可能拷到
 * "撕裂"的中间状态（页写到一半），得到的副本既打不开也可能悄悄丢数据；
 * 若开了 WAL 还另有 -wal/-shm 需要一起处理。VACUUM INTO 则是 SQLite 官方的
 * 一致快照手段：它在**单个读事务**里重建一份紧凑副本，看不到未提交的写入，
 * 因此不存在撕裂问题（当前生产 journal_mode=delete，不是 WAL）。
 *
 * 为什么必须校验：备份最常见的失效不是"没备份"，而是"备份其实不可用却没人知道"。
 * 所以每份快照都要能通过 integrity_check，且损坏必须能被识别出来；
 * 恢复前强制校验，宁可恢复失败也不把坏快照铺回生产路径。
 *
 * 为什么必须演练恢复：只有真恢复到新路径、再用生产 adapter + drizzle 查得出数据，
 * 才算证明"这份备份能用"。此前仓库里的 scripts/backup.sh 抓的是接口 JSON 投影，
 * 抓了却不会恢复，等于没有备份。
 */

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";

export interface SnapshotInfo {
  path: string;
  name: string;
  bytes: number;
  createdAt: Date;
}

export interface SnapshotVerification {
  ok: boolean;
  detail: string;
  tables: number;
}

export interface PruneResult {
  removed: string[];
  kept: string[];
}

const SNAPSHOT_PREFIX = "tiangong-";
const SNAPSHOT_SUFFIX = ".db";

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 2026-09-18T12:34:56Z → 20260918-123456（文件名即时间序，便于轮换） */
function stampOf(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

/**
 * 生成一致快照。目标名由时间戳决定；同名冲突时 SQLite 明确报错而不是覆盖。
 * 这是刻意保留的行为：名字撞了必须响，不能静默盖掉既有备份。
 */
export function createConsistentSnapshot(
  dbPath: string,
  destDir: string,
  now: Date = new Date(),
): SnapshotInfo {
  if (!existsSync(dbPath)) throw new Error(`源库不存在，无法备份：${dbPath}`);
  mkdirSync(destDir, { recursive: true });

  const name = `${SNAPSHOT_PREFIX}${stampOf(now)}${SNAPSHOT_SUFFIX}`;
  const dest = path.join(destDir, name);

  const source = new DatabaseSync(dbPath);
  try {
    source.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } catch (e) {
    throw new Error(`生成快照失败（${name}）：${describeError(e)}`);
  } finally {
    source.close();
  }

  return { path: dest, name, bytes: statSync(dest).size, createdAt: now };
}

/** 校验快照可用性：能打开 + integrity_check 通过。返回结果而不抛，方便巡检汇总。 */
export function verifySnapshot(snapshotPath: string): SnapshotVerification {
  if (!existsSync(snapshotPath)) {
    return { ok: false, detail: `快照不存在：${snapshotPath}`, tables: 0 };
  }

  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(snapshotPath);
  } catch (e) {
    return { ok: false, detail: `打不开快照：${describeError(e)}`, tables: 0 };
  }

  try {
    const integrity = raw.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
    const value = integrity?.integrity_check ?? "unknown";
    if (value !== "ok") {
      return { ok: false, detail: `integrity_check=${value}（快照已损坏，不可用于恢复）`, tables: 0 };
    }
    const tables = (
      raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get() as { n: number }
    ).n;
    return { ok: true, detail: `integrity_check=ok，${tables} 张表`, tables };
  } catch (e) {
    return { ok: false, detail: `校验失败：${describeError(e)}`, tables: 0 };
  } finally {
    raw.close();
  }
}

/**
 * 恢复演练/实际恢复：把快照复制到目标路径。
 * 先校验再恢复；目标已存在则拒绝，避免误覆盖正在使用的库。
 */
export function restoreSnapshot(snapshotPath: string, targetPath: string): { ok: true; bytes: number } {
  if (!existsSync(snapshotPath)) throw new Error(`快照不存在：${snapshotPath}`);
  if (existsSync(targetPath)) throw new Error(`恢复目标已存在，拒绝覆盖：${targetPath}`);

  const check = verifySnapshot(snapshotPath);
  if (!check.ok) throw new Error(`快照未通过校验，拒绝恢复：${check.detail}`);

  mkdirSync(path.dirname(targetPath), { recursive: true });
  copyFileSync(snapshotPath, targetPath);
  return { ok: true, bytes: statSync(targetPath).size };
}

/** 从快照文件名解析生成时间（tiangong-YYYYMMDD-HHMMSS.db）。失败则退回文件 mtime。 */
function createdAtOf(name: string, fallbackMs: number): Date {
  const match = /^tiangong-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/.exec(name);
  if (!match) return new Date(fallbackMs);
  const [, y, mo, d, h, mi, s] = match;
  const parsed = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(parsed) ? new Date(parsed) : new Date(fallbackMs);
}

/** 列出目录内的快照（按时间序，旧→新）。无关文件一律不算快照。 */
export function listSnapshots(dir: string): SnapshotInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(SNAPSHOT_PREFIX) && name.endsWith(SNAPSHOT_SUFFIX))
    .map((name) => {
      const full = path.join(dir, name);
      const stat = statSync(full);
      // createdAt 以文件名里的时间戳为准：它才是"这份备份是什么时候做的"的持久记录，
      // 而 mtime 会在文件被复制/恢复后改变（轮换与节流都依赖这个时间）。
      return { path: full, name, bytes: stat.size, createdAt: createdAtOf(name, stat.mtimeMs) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** 轮换：只保留最新 keep 份，其余删除。不动目录内任何非快照文件。 */
export function pruneSnapshots(dir: string, keep: number): PruneResult {
  if (!Number.isInteger(keep) || keep < 0) throw new Error(`keep 必须是非负整数，收到：${keep}`);
  const all = listSnapshots(dir);
  const cut = Math.max(0, all.length - keep);
  const removed: string[] = [];
  for (const snapshot of all.slice(0, cut)) {
    rmSync(snapshot.path, { force: true });
    removed.push(snapshot.name);
  }
  return { removed, kept: all.slice(cut).map((s) => s.name) };
}

export interface BackupJobOptions {
  dbPath: string;
  destDir: string;
  /** 保留份数（轮换）。默认 7；传 0 表示不轮换。 */
  keep?: number;
  now?: Date;
  /** 离机上传（注入以便测试与解耦），返回远端路径。 */
  upload?: (name: string, bytes: Buffer) => Promise<string>;
}

export interface BackupJobReport {
  ok: boolean;
  detail: string;
  snapshot?: SnapshotInfo;
  verification?: SnapshotVerification;
  uploadedTo?: string;
  uploadError?: string;
  pruned?: PruneResult;
}

const DEFAULT_KEEP = 7;

/**
 * 一条龙备份：快照 → 校验 → 离机上传 → 轮换。
 *
 * 分层取舍：
 *   - ok 只表示"本地一致快照已生成且通过校验"——这是数据不丢的底线。
 *   - 离机上传失败记 uploadError 而不翻转 ok：同卷快照挡不住卷丢失，
 *     但也不该因为对象存储抖动就把一次成功的本地备份报成失败（降级而非误报）。
 *   - 校验不通过的快照既不外传也不参与轮换（留档取证）。
 *   - 源库缺失等异常不抛，返回可读失败报告：巡检任务不该把调度器炸掉。
 */
export async function runBackupJob(options: BackupJobOptions): Promise<BackupJobReport> {
  const { dbPath, destDir, keep = DEFAULT_KEEP, now = new Date(), upload } = options;

  let snapshot: SnapshotInfo;
  try {
    snapshot = createConsistentSnapshot(dbPath, destDir, now);
  } catch (e) {
    return { ok: false, detail: describeError(e) };
  }

  const verification = verifySnapshot(snapshot.path);
  if (!verification.ok) {
    return {
      ok: false,
      detail: `快照未通过校验：${verification.detail}`,
      snapshot,
      verification,
    };
  }

  let uploadedTo: string | undefined;
  let uploadError: string | undefined;
  if (upload) {
    try {
      uploadedTo = await upload(snapshot.name, readFileSync(snapshot.path));
    } catch (e) {
      uploadError = describeError(e);
    }
  }

  const pruned = keep > 0 ? pruneSnapshots(destDir, keep) : undefined;

  const detail = uploadedTo
    ? `快照已生成并通过校验，已离机上传：${uploadedTo}`
    : uploadError
      ? `快照已生成并通过校验（离机上传失败，降级：${uploadError}）`
      : "快照已生成并通过校验";

  return { ok: true, detail, snapshot, verification, uploadedTo, uploadError, pruned };
}
