/**
 * Dispatch claim sweeper: dispatched 任务卡死自动认领兜底。
 *
 * 背景：a2a.dispatch 把任务置为 status=running + lifecycleStatus=dispatched，
 * 但 claimNextTask / TaskRunner 都只扫 status=queued——若目标 agent 一直不调
 * a2a.ack，任务将永远停在 dispatched 无人认领。
 *
 * 本 sweeper 把「lifecycleStatus=dispatched 且 status=running 且 dispatchedAt
 * 已超过 stale 阈值」的任务回置为 status=queued（lifecycleStatus 保持
 * dispatched）。此后：
 *   - 外部 agent 每次 updateHeartbeat → claimNextTask 即可拉走（status=queued
 *     且 agentId 匹配）；
 *   - 内部 TaskRunner tick 也会接管（externalClaimSources 保护使它不抢外部
 *     agent 的任务）；
 *   - claim 序列里的执行审批闸门会再评估一次，parked 任务不会被误执行。
 *
 * 可通过 TIANGONG_DISPATCH_CLAIM_STALE_MS 调整阈值（默认 90s）。
 */
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { tasks, taskMessages } from "@db/schema";

import { emitSweeperAudit } from "./notify";
import { sweeperConfig } from "./config";
import type { Db } from "./db";

export async function sweepDispatchClaim(db: Db, now: Date): Promise<void> {
  const staleMs = sweeperConfig.dispatchClaimStaleMs;
  const cutoff = new Date(now.getTime() - staleMs);
  const stuck = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.lifecycleStatus, "dispatched"),
        eq(tasks.status, "running"),
        isNotNull(tasks.dispatchedAt),
        lt(tasks.dispatchedAt, cutoff)
      )
    )
    .limit(50);

  for (const task of stuck) {
    await db
      .update(tasks)
      .set({ status: "queued", updatedAt: now })
      .where(eq(tasks.id, task.id));

    try {
      await db.insert(taskMessages).values({
        taskId: task.id,
        eventType: "system",
        content: `Dispatch 未被认领超过 ${staleMs}ms，自动回队列等待认领`,
        metadata: JSON.stringify({
          action: "dispatch_claim_sweep",
          previousStatus: "running",
          restoredStatus: "queued",
          agentId: task.agentId,
        }),
      });
    } catch {
      // 事件记录失败不影响回队列主流程
    }

    emitSweeperAudit({
      event: "task:dispatch_requeued",
      entityType: "task",
      entityId: task.id,
      metadata: { taskId: task.taskId, agentId: task.agentId ?? undefined },
    });
  }

  if (stuck.length > 0) {
    console.log(`[sweepDispatchClaim] requeued ${stuck.length} stuck dispatched task(s)`);
  }
}
