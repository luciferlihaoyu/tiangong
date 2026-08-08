/**
 * Approval nag sweeper: remind humans about approval-gated tasks that have
 * been blocked for longer than the stale window.
 *
 * Filtering is done in-code on the parsed TaskMetadata (routing.approvalRequired
 * && approval.decision === "pending"). Nagging is throttled via
 * approval.lastNagAt: a task is nagged at most once per stale window. The
 * throttle marker is written back through mergeTaskMetadata so the zod schema
 * round-trips it (zod strips unknown keys otherwise).
 */
import { and, eq, lt } from "drizzle-orm";
import { tasks } from "@db/schema";

import { mergeTaskMetadata, parseTaskMetadata } from "../task-metadata";
import { sweeperConfig } from "./config";
import { emitSweeperAudit, notifyAgentMailbox } from "./notify";
import type { Db } from "./db";

export async function sweepApprovalNag(db: Db, now: Date): Promise<void> {
  const staleMs = sweeperConfig.approvalStaleMs;
  const cutoff = new Date(now.getTime() - staleMs);
  const staleBlocked = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, "pending"), eq(tasks.boardStatus, "blocked"), lt(tasks.blockedAt, cutoff)));

  for (const task of staleBlocked) {
    const metadata = parseTaskMetadata(task.input);
    const approval = metadata?.approval;
    if (!metadata?.routing.approvalRequired || approval?.decision !== "pending") continue;

    // Throttle: only nag when the previous nag is absent or older than the stale window.
    if (approval.lastNagAt !== undefined) {
      const lastNagAt = Date.parse(approval.lastNagAt);
      if (Number.isFinite(lastNagAt) && lastNagAt >= now.getTime() - staleMs) continue;
    }

    emitSweeperAudit({
      event: "task:approval_stale",
      entityType: "task",
      entityId: task.id,
      metadata: { taskId: task.taskId },
    });

    if (task.agentId !== null) {
      await notifyAgentMailbox({
        toAgentId: task.agentId,
        taskId: task.id,
        subject: `任务 ${task.taskId} 等待审批超时`,
        body: `任务「${task.name}」已阻塞等待人工审批超过 ${staleMs}ms，请及时处理。`,
      });
    }

    const mergedInput = mergeTaskMetadata(task.input, { approval: { ...approval, lastNagAt: now.toISOString() } });
    await db.update(tasks).set({ input: mergedInput }).where(eq(tasks.id, task.id));
  }
}
