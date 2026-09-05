/**
 * SweeperScheduler: periodic execution of all server-side maintenance sweepers.
 *
 * Mirrors the TaskRunner timer pattern: start()/stop(), a tick re-entrancy
 * guard, and a tick counter. Every sweeper runs in its own try/catch so a
 * single throwing sweeper never blocks the others. start() is a no-op when
 * sweepers are disabled via config. No timers are started at module load.
 */
import { getDb } from "../../queries/connection";

import { sweepAgentWatchdog } from "./agent-watchdog";
import { sweepApprovalNag } from "./approval-nag";
import { sweepBlockedRecovery } from "./blocked-recovery";
import { sweepAlistCompensation } from "./alist-compensation";
import { sweeperConfig } from "./config";
import { sweepMemoryCompensation } from "./memory-compensation";
import { sweepNewApiPatrol } from "./newapi-patrol";
import { sweepTaskTimeouts } from "./task-lifecycle";
import { sweepDispatchClaim } from "./task-dispatch-claim";
import { sweepTaskRetry } from "./task-retry";

type SweepFn = (db: ReturnType<typeof getDb>, now: Date, tick: number) => Promise<void>;

class SweeperScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private tickCount = 0;

  get status() {
    return {
      enabled: sweeperConfig.enabled,
      intervalMs: sweeperConfig.intervalMs,
      running: this.timer !== null,
      tickCount: this.tickCount,
    };
  }

  start(): void {
    if (!sweeperConfig.enabled) {
      console.log("[SweeperScheduler] Disabled by config, not starting.");
      return;
    }
    if (this.timer) return;

    console.log(`[SweeperScheduler] Starting (interval=${sweeperConfig.intervalMs}ms)`);
    this.timer = setInterval(() => this.tick(), sweeperConfig.intervalMs);
    setImmediate(() => this.tick());
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[SweeperScheduler] Stopped.");
    }
  }

  /** Run one sweep pass. Each sweeper is isolated; a throwing one is logged and skipped. */
  async tick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    this.tickCount += 1;
    try {
      const db = getDb();
      const now = new Date();
      const tick = this.tickCount;

      const sweepers: readonly SweepFn[] = [
        sweepTaskTimeouts,
        sweepDispatchClaim,
        sweepTaskRetry,
        sweepAgentWatchdog,
        sweepApprovalNag,
        sweepBlockedRecovery,
        sweepMemoryCompensation,
        sweepAlistCompensation,
        sweepNewApiPatrol,
      ];

      for (const sweep of sweepers) {
        try {
          await sweep(db, now, tick);
        } catch (error) {
          console.error(`[SweeperScheduler] Sweeper error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      console.error(`[SweeperScheduler] Tick error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.tickRunning = false;
    }
  }
}

export const sweeperScheduler = new SweeperScheduler();
