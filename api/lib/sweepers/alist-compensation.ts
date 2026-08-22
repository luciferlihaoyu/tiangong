/**
 * AList 上传补偿 sweeper：补传 AList 宕机期间完成、漏传的任务产物。
 *
 * 与 memory-compensation（璇玑记忆兜底）互为镜像：扫描最近完成 lookback 窗口内的
 * 任务，跳过已带 alist_sync 幂等标记（task_artifacts.type='alist_sync'）的，对最多
 * MAX_SYNC 个任务逐个调用 syncTaskArtifactsToAlist。同步顺序执行，保证确定性排序
 * （对 mock-DB 测试友好）；syncTaskArtifactsToAlist 自身非致命（内部 catch），单个
 * 失败不会中断本轮 sweep。
 */
import { and, asc, eq, gt, or } from "drizzle-orm";
import { taskArtifacts, tasks } from "@db/schema";

import { sweeperConfig } from "./config";
import { syncTaskArtifactsToAlist, ALIST_SYNC_ARTIFACT_TYPE } from "../alist-sync";
import type { Db } from "./db";

const MAX_SCAN = 20;
const MAX_SYNC = 5;

export async function sweepAlistCompensation(db: Db, now: Date): Promise<void> {
  const lookback = new Date(now.getTime() - sweeperConfig.alistRetryLookbackMs);
  const candidates = await db
    .select()
    .from(tasks)
    .where(and(or(eq(tasks.lifecycleStatus, "completed"), eq(tasks.status, "done")), gt(tasks.updatedAt, lookback)))
    .orderBy(asc(tasks.updatedAt))
    .limit(MAX_SCAN);

  let synced = 0;
  for (const task of candidates) {
    const existing = await db
      .select({ id: taskArtifacts.id })
      .from(taskArtifacts)
      .where(and(eq(taskArtifacts.taskId, task.id), eq(taskArtifacts.type, ALIST_SYNC_ARTIFACT_TYPE)))
      .limit(1);
    if (existing.length > 0) continue;
    if (synced >= MAX_SYNC) break;

    synced += 1;
    await syncTaskArtifactsToAlist(db, task);
  }
}
