/**
 * New API connector patrol: periodic read-only liveness check.
 *
 * Runs at most every newApiPatrolEveryTicks ticks. Silently skips when the
 * connector is unconfigured; a thrown connector error is converted into a
 * connector:patrol_failed audit event (never propagated to the scheduler).
 */
import { createNewApiClient } from "../../connectors/newapi/service";

import { sweeperConfig } from "./config";
import { emitSweeperAudit } from "./notify";
import type { Db } from "./db";

export async function sweepNewApiPatrol(_db: Db, _now: Date, tick: number): Promise<void> {
  if (tick % sweeperConfig.newApiPatrolEveryTicks !== 0) return;

  const client = createNewApiClient();
  if (client === null) return;

  try {
    await client.listModelChannels();
    await client.getChannelHealth();
  } catch (error) {
    emitSweeperAudit({
      event: "connector:patrol_failed",
      entityType: "connector",
      metadata: { connectorType: "newapi", status: "error" },
    });
    console.warn(`[NewApiPatrol] Patrol failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
