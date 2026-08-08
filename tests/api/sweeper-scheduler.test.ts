import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock connection + all sweeper modules to observe scheduler behavior ───
const dbMocks = vi.hoisted(() => ({
  db: { marker: "mock-db" } as Readonly<Record<string, unknown>>,
}));

vi.mock("../../api/queries/connection", () => ({ getDb: () => dbMocks.db }));

const sweeperMocks = vi.hoisted(() => ({
  taskTimeouts: vi.fn(async () => {}),
  agentWatchdog: vi.fn(async () => {}),
  approvalNag: vi.fn(async () => {}),
  memoryCompensation: vi.fn(async () => {}),
  newApiPatrol: vi.fn(async () => {}),
}));

// Sweepers disabled: start() must no-op without creating a timer.
vi.mock("../../api/lib/sweepers/config", () => ({
  sweeperConfig: {
    enabled: false,
    intervalMs: 60_000,
    heartbeatTimeoutMs: 180_000,
    approvalStaleMs: 86_400_000,
    memoryRetryLookbackMs: 21_600_000,
    newApiPatrolEveryTicks: 10,
  },
}));

vi.mock("../../api/lib/sweepers/task-lifecycle", () => ({ sweepTaskTimeouts: sweeperMocks.taskTimeouts }));
vi.mock("../../api/lib/sweepers/agent-watchdog", () => ({ sweepAgentWatchdog: sweeperMocks.agentWatchdog }));
vi.mock("../../api/lib/sweepers/approval-nag", () => ({ sweepApprovalNag: sweeperMocks.approvalNag }));
vi.mock("../../api/lib/sweepers/memory-compensation", () => ({ sweepMemoryCompensation: sweeperMocks.memoryCompensation }));
vi.mock("../../api/lib/sweepers/newapi-patrol", () => ({ sweepNewApiPatrol: sweeperMocks.newApiPatrol }));

import { sweeperScheduler } from "../../api/lib/sweepers/scheduler";

describe("SweeperScheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("start() is a no-op when sweepers are disabled by config", () => {
    // Given: config.enabled = false
    // When
    sweeperScheduler.start();
    // Then: no timer is running; stop() after a disabled start is harmless
    expect(sweeperScheduler.status.running).toBe(false);
    sweeperScheduler.stop();
  });

  it("runs every sweeper on a tick and isolates a throwing sweeper", async () => {
    // Given: the first sweeper throws
    sweeperMocks.taskTimeouts.mockRejectedValueOnce(new Error("sweeper boom"));
    const tickBefore = sweeperScheduler.status.tickCount;

    // When
    await sweeperScheduler.tick();

    // Then: all five sweepers were attempted and the rejection did not escape
    expect(sweeperMocks.taskTimeouts).toHaveBeenCalledTimes(1);
    expect(sweeperMocks.agentWatchdog).toHaveBeenCalledTimes(1);
    expect(sweeperMocks.approvalNag).toHaveBeenCalledTimes(1);
    expect(sweeperMocks.memoryCompensation).toHaveBeenCalledTimes(1);
    expect(sweeperMocks.newApiPatrol).toHaveBeenCalledTimes(1);
    expect(sweeperScheduler.status.tickCount).toBe(tickBefore + 1);
  });

  it("guards against re-entrant ticks", async () => {
    // Given: a sweeper that stays pending until released
    let release: (() => void) | null = null;
    sweeperMocks.taskTimeouts.mockImplementation(
      () => new Promise<void>((resolve) => { release = resolve; })
    );
    const tickBefore = sweeperScheduler.status.tickCount;

    // When: two overlapping ticks
    const first = sweeperScheduler.tick();
    const second = sweeperScheduler.tick();

    // Then: the second tick returns immediately without touching the sweepers
    await second;
    expect(sweeperMocks.taskTimeouts).toHaveBeenCalledTimes(1);

    // And the first tick completes with a single tick counted
    release?.();
    await first;
    expect(sweeperScheduler.status.tickCount).toBe(tickBefore + 1);
  });
});
