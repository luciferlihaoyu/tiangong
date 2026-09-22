/**
 * 数据库一致备份 sweeper（Phase B §4）。
 *
 * 为什么是 sweeper 而不是每个 tick 都备份：备份有成本（VACUUM INTO 要读全库），
 * 而 sweep tick 默认 60s。这里自节流——只有最新快照超过 dbBackupIntervalMs
 * （默认 1 天）才真做一次，所以"多久备一次"由配置决定，不被 sweep 频率绑架。
 *
 * 为什么未就绪时跳过：迁移失败/schema 漂移时快照出来的是"半迁移的库"，
 * 而轮换按时间淘汰旧份——让坏快照挤掉好备份是净损失。宁可不备，也不备坏。
 *
 * 代价说明（诚实记录）：scheduler 是**串行** await 每个 sweeper 的，所以本 sweeper
 * 会占用本轮 tick。当前库只有几 MB，VACUUM INTO 是毫秒级，可接受；若将来库长到
 * GB 级，应改为后台任务 + 状态表，而不是让它卡住整轮巡检。
 */
import path from "node:path";

import { env } from "../env";
import { resolveDbPath } from "../../queries/connection";
import { alistUpload, resolveAlistConfig } from "../../connectors/alist";
import { listSnapshots, runBackupJob, type BackupJobReport, type SnapshotInfo } from "../db-backup";
import { readiness } from "../readiness";
import { sweeperConfig } from "./config";

const UPLOAD_DIR = "/tiangong/db-backups";

export interface BackupSweepState {
  lastRunAt: string | null;
  lastReport: BackupJobReport | null;
  skippedReason: string | null;
}

const state: BackupSweepState = { lastRunAt: null, lastReport: null, skippedReason: null };

/** 进程内最近一次备份结果（供管理端点展示，让"备份到底行不行"一眼可见）。 */
export function backupSweepState(): BackupSweepState & { snapshots: SnapshotInfo[] } {
  return { ...state, snapshots: listSnapshots(backupDir()) };
}

export function backupDir(): string {
  return path.join(env.artifactRoot ?? "/app/data/tiangong-artifacts", "backups");
}

/** 最新一份快照的生成时间（用于节流判断）。 */
function newestSnapshotAt(): Date | null {
  const all = listSnapshots(backupDir());
  if (all.length === 0) return null;
  return all[all.length - 1].createdAt;
}

export async function sweepDbBackup(_db: unknown, now: Date): Promise<void> {
  state.skippedReason = null;

  if (sweeperConfig.dbBackupIntervalMs <= 0) {
    state.skippedReason = "自动备份已关闭（TIANGONG_DB_BACKUP_INTERVAL_MS=0）";
    return;
  }

  const newest = newestSnapshotAt();
  if (newest && now.getTime() - newest.getTime() < sweeperConfig.dbBackupIntervalMs) {
    state.skippedReason = "距上次备份未超过间隔，本轮跳过";
    return;
  }

  // 未就绪时跳过：见文件头说明（不让坏快照挤掉好备份）
  if (!readiness.isReady()) {
    state.skippedReason = `系统未就绪，跳过备份：${readiness.snapshot().reasons.join("；")}`;
    return;
  }

  const alist = await resolveAlistConfig().catch(() => null);
  const report = await runBackupJob({
    dbPath: resolveDbPath(env.databaseUrl ?? ""),
    destDir: backupDir(),
    keep: sweeperConfig.dbBackupKeep,
    now,
    upload: alist
      ? (name, bytes) => alistUpload(alist, `${UPLOAD_DIR}/${name}`, bytes)
      : undefined,
  });

  state.lastRunAt = now.toISOString();
  state.lastReport = report;

  if (report.ok) {
    const bits = [report.detail];
    if (report.pruned?.removed.length) bits.push(`轮换删除 ${report.pruned.removed.join(", ")}`);
    console.log(`[DbBackup] ${bits.join("；")}`);
  } else {
    console.error(`[DbBackup] 备份失败：${report.detail}`);
  }
}
