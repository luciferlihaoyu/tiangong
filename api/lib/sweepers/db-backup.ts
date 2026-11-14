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
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

import { env } from "../env";
import { resolveDbPath } from "../../queries/connection";
import { alistUpload, resolveAlistConfig } from "../../connectors/alist";
import { listSnapshots, runBackupJob, type BackupJobReport, type SnapshotInfo } from "../db-backup";
import { readiness } from "../readiness";
import { sweeperConfig } from "./config";

/**
 * 离机落点：必须挂在 AList 上**已存在且可写**的存储下。
 * 事故（2026-11-12 起，11-14 修复）：原值 "/tiangong/db-backups" 是 AList 根下
 * 不存在的路径（storage not found），建目录恒被 permission denied 拒——
 * 异地副本自该日起从未建成，只有本机卷留底。/tos/backup 是现役可用存储
 * （cron 链的 tiangong-db-backup.sh 就落 /tos/backup/tiangong/）。
 */
const UPLOAD_DIR = "/tos/backup/tiangong-live";

/**
 * 离机加密：与 cron 备份链（方案整合/备份工程/tiangong-db-backup.sh）同钥同算法——
 * AES-256-GCM，密文格式 iv(12) || authTag(16) || ciphertext，key = SHA-256(钥值)；
 * 明文是 gzip 后的库文件（cron 链是 tar.gz(db.gz+META)，本链单文件更简，
 * 解密同一条 openssl/node 流程，解出后 gunzip 即得 .db）。
 *
 * 为什么必须加密：库里有用户表、API key 等敏感数据，项目备份体系
 * （AGENTS.md 备份体系①⑤⑦）全部密文落云——明文 .db 上 AList 是 unacceptable。
 * 钥未配置时**诚实跳过**离机上传（本地链照常），绝不降级成明文上传。
 */
function encryptForUpload(db: Buffer, keyRaw: string): Buffer {
  const key = createHash("sha256").update(keyRaw, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(db)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** tiangong-20261114-131710.db → tiangong-live-20261114-131710.db.gz.enc */
function uploadNameOf(snapshotName: string): string {
  const stamp = snapshotName.replace(/^tiangong-/, "").replace(/\.db$/, "");
  return `tiangong-live-${stamp}.db.gz.enc`;
}

/**
 * 离机上传器工厂（2026-11-14 收敛）：sweeper 与 ops.backupRun **必须**走这里。
 * 此前 ops-router 的手动备份自己硬编码了一份「/tiangong/db-backups + 明文」的
 * 上传逻辑——路径错误之外，更要命的是明文：手动点一次"立即备份"就会把
 * 含凭据的生产库原样推上对象存储。单一实现，杜绝这类漂移。
 * 返回 undefined = 不上传（AList 未配置 / 未设加密钥），本地快照链照常。
 */
export async function createBackupUploader(): Promise<((name: string, bytes: Buffer) => Promise<string>) | undefined> {
  const alist = await resolveAlistConfig().catch(() => null);
  if (!alist) return undefined;
  const backupKey = env.backupKey;
  if (!backupKey) {
    console.warn(
      "[DbBackup] 已配置 AList 但未设置 TIANGONG_BACKUP_KEY —— 仅本机快照，离机上传跳过（防明文上云）"
    );
    return undefined;
  }
  return (name, bytes) =>
    alistUpload(alist, `${UPLOAD_DIR}/${uploadNameOf(name)}`, encryptForUpload(bytes, backupKey));
}

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

  const report = await runBackupJob({
    dbPath: resolveDbPath(env.databaseUrl ?? ""),
    destDir: backupDir(),
    keep: sweeperConfig.dbBackupKeep,
    now,
    upload: await createBackupUploader(),
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
