import { describe, expect, it } from "vitest";

import { loadSweeperConfig } from "../../api/lib/sweepers/config";

describe("Sweeper config", () => {
  it("applies default values when no env vars are set", () => {
    // Given: empty environment
    // When
    const config = loadSweeperConfig({});
    // Then: safe defaults
    expect(config.enabled).toBe(true);
    expect(config.intervalMs).toBe(60_000);
    expect(config.heartbeatTimeoutMs).toBe(180_000);
    expect(config.approvalStaleMs).toBe(86_400_000);
    expect(config.memoryRetryLookbackMs).toBe(21_600_000);
    expect(config.newApiPatrolEveryTicks).toBe(10);
  });

  it("overrides defaults from environment variables", () => {
    // Given
    const env = {
      TIANGONG_SWEEPERS_ENABLED: "false",
      TIANGONG_SWEEP_INTERVAL_MS: "5000",
      TIANGONG_HEARTBEAT_TIMEOUT_MS: "60000",
      TIANGONG_APPROVAL_STALE_MS: "3600000",
      TIANGONG_MEMORY_RETRY_LOOKBACK_MS: "7200000",
      TIANGONG_NEWAPI_PATROL_EVERY_TICKS: "20",
    };
    // When
    const config = loadSweeperConfig(env);
    // Then
    expect(config.enabled).toBe(false);
    expect(config.intervalMs).toBe(5_000);
    expect(config.heartbeatTimeoutMs).toBe(60_000);
    expect(config.approvalStaleMs).toBe(3_600_000);
    expect(config.memoryRetryLookbackMs).toBe(7_200_000);
    expect(config.newApiPatrolEveryTicks).toBe(20);
  });

  it("coerces '0' as the boolean switch off", () => {
    // Given / When
    const config = loadSweeperConfig({ TIANGONG_SWEEPERS_ENABLED: "0" });
    // Then
    expect(config.enabled).toBe(false);
  });

  it("falls back to defaults for invalid integer values", () => {
    // Given / When
    const config = loadSweeperConfig({ TIANGONG_SWEEP_INTERVAL_MS: "not-a-number" });
    // Then
    expect(config.intervalMs).toBe(60_000);
  });
});
