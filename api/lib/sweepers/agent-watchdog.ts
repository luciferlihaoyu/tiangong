/**
 * Agent watchdog sweeper: demote agents that look online but have stopped
 * heartbeating.
 *
 * The agents schema enum has no "offline" state, so the DB row is set to
 * "idle" while the audit metadata records the intended offline semantics.
 */
import { eq, inArray } from "drizzle-orm";
import { agents } from "@db/schema";

import { sweeperConfig } from "./config";
import { emitSweeperAudit } from "./notify";
import type { Db } from "./db";

export async function sweepAgentWatchdog(db: Db, now: Date): Promise<void> {
  const candidates = await db
    .select()
    .from(agents)
    .where(inArray(agents.status, ["online", "busy"]));

  const cutoffMs = now.getTime() - sweeperConfig.heartbeatTimeoutMs;

  for (const agent of candidates) {
    const lastHeartbeat = agent.lastHeartbeat;
    if (lastHeartbeat !== null && lastHeartbeat.getTime() > cutoffMs) continue;

    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agent.id));
    emitSweeperAudit({
      event: "agent:heartbeat_timeout",
      entityType: "agent",
      entityId: agent.id,
      metadata: { status: "offline" },
    });
  }
}
