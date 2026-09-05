/**
 * Sweeper scheduler configuration, parsed from env with safe defaults.
 *
 * Env vars:
 *   TIANGONG_SWEEPERS_ENABLED            default true
 *   TIANGONG_SWEEP_INTERVAL_MS           default 60000
 *   TIANGONG_HEARTBEAT_TIMEOUT_MS        default 180000
 *   TIANGONG_APPROVAL_STALE_MS           default 86400000 (1 day)
 *   TIANGONG_MEMORY_RETRY_LOOKBACK_MS    default 21600000 (6 hours)
 *   TIANGONG_ALIST_RETRY_LOOKBACK_MS     default 21600000 (6 hours)
 *   TIANGONG_NEWAPI_PATROL_EVERY_TICKS   default 10
 *   TIANGONG_DISPATCH_CLAIM_STALE_MS     default 90000 (90s)
 *   TIANGONG_BLOCKED_RECOVER_STALE_MS    default 86400000 (1 day)
 */
import { z } from "zod";

const booleanFromEnv = z
  .preprocess(
    (value) => {
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") return true;
        if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off" || normalized === "") {
          return false;
        }
      }
      return undefined;
    },
    z.boolean()
  )
  .default(true)
  .catch(true);

const integerFromEnv = (min: number, max: number, fallback: number) =>
  z
    .preprocess(
      (value) => {
        if (typeof value === "number" && Number.isFinite(value)) return value;
        if (typeof value === "string" && value.trim().length > 0) {
          const parsed = Number(value.trim());
          if (Number.isFinite(parsed)) return parsed;
        }
        return undefined;
      },
      z.number().int().min(min).max(max)
    )
    .default(fallback)
    .catch(fallback);

export const sweeperConfigSchema = z.object({
  enabled: booleanFromEnv,
  intervalMs: integerFromEnv(1_000, 3_600_000, 60_000),
  heartbeatTimeoutMs: integerFromEnv(1_000, 86_400_000, 180_000),
  approvalStaleMs: integerFromEnv(60_000, 31_536_000_000, 86_400_000),
  memoryRetryLookbackMs: integerFromEnv(60_000, 31_536_000_000, 21_600_000),
  alistRetryLookbackMs: integerFromEnv(60_000, 31_536_000_000, 21_600_000),
  newApiPatrolEveryTicks: integerFromEnv(1, 100_000, 10),
  // dispatched 任务超过该时长仍 status=running（agent 未 ack）时，自动回 queued
  // 让 claimNextTask / TaskRunner 可认领（自动认领兜底）。
  dispatchClaimStaleMs: integerFromEnv(10_000, 3_600_000, 90_000),
  // 非「审批停放」的 blocked 任务超过该时长自动恢复到阻塞前状态。
  blockedRecoverStaleMs: integerFromEnv(300_000, 31_536_000_000, 86_400_000),
});

export type SweeperConfig = Readonly<z.infer<typeof sweeperConfigSchema>>;

export type SweeperEnv = Readonly<Record<string, string | undefined>>;

export function loadSweeperConfig(env: SweeperEnv = process.env): SweeperConfig {
  return sweeperConfigSchema.parse({
    enabled: env.TIANGONG_SWEEPERS_ENABLED,
    intervalMs: env.TIANGONG_SWEEP_INTERVAL_MS,
    heartbeatTimeoutMs: env.TIANGONG_HEARTBEAT_TIMEOUT_MS,
    approvalStaleMs: env.TIANGONG_APPROVAL_STALE_MS,
    memoryRetryLookbackMs: env.TIANGONG_MEMORY_RETRY_LOOKBACK_MS,
    alistRetryLookbackMs: env.TIANGONG_ALIST_RETRY_LOOKBACK_MS,
    newApiPatrolEveryTicks: env.TIANGONG_NEWAPI_PATROL_EVERY_TICKS,
    dispatchClaimStaleMs: env.TIANGONG_DISPATCH_CLAIM_STALE_MS,
    blockedRecoverStaleMs: env.TIANGONG_BLOCKED_RECOVER_STALE_MS,
  });
}

/** Process-wide singleton, read once at module load (no timers started here). */
export const sweeperConfig: SweeperConfig = loadSweeperConfig();
