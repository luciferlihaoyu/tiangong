/**
 * Memory compensation sweeper: backfill completed tasks that failed to reach
 * the Xuanji memory store (e.g. during an outage).
 *
 * Scans the recent completion lookback window, skips tasks that already carry
 * a local xuanji_memory artifact (dedup), then calls syncTaskMemoryToXuanji
 * for at most MAX_SYNC tasks. Syncs run sequentially for deterministic
 * ordering (mock-DB test friendly).
 */
import { and, asc, eq, gt, or } from "drizzle-orm";
import { taskArtifacts, tasks } from "@db/schema";

import { sweeperConfig } from "./config";
import { syncTaskMemoryToXuanji, XUANJI_MEMORY_ARTIFACT_TYPE } from "../xuanji-sync";
import type { Db } from "./db";

const MAX_SCAN = 20;
const MAX_SYNC = 5;

export async function sweepMemoryCompensation(db: Db, now: Date): Promise<void> {
  const lookback = new Date(now.getTime() - sweeperConfig.memoryRetryLookbackMs);
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
      .where(and(eq(taskArtifacts.taskId, task.id), eq(taskArtifacts.type, XUANJI_MEMORY_ARTIFACT_TYPE)))
      .limit(1);
    if (existing.length > 0) continue;
    if (synced >= MAX_SYNC) break;

    synced += 1;
    await syncTaskMemoryToXuanji(db, task);
  }
}
