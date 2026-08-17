import { describe, expect, it } from "vitest";

import {
  decideLeaseReclaim,
  validOverlappingLeases,
  validateLeaseWrite,
  type TaskLeaseSnapshot,
} from "../../api/lib/task-leases";

const NOW = new Date("2026-08-13T12:00:00.000Z");

function lease(overrides: Partial<TaskLeaseSnapshot> = {}): TaskLeaseSnapshot {
  return {
    token: "lease-current",
    workerId: "worker-a",
    generation: 2,
    expiresAt: new Date(NOW.getTime() + 30_000),
    revokedAt: null,
    ...overrides,
  };
}

describe("task worker lease policy", () => {
  it("accepts current lease writes and rejects stale, expired, and revoked writers", () => {
    expect(validateLeaseWrite(lease(), { token: "lease-current", workerId: "worker-a", generation: 2, now: NOW })).toEqual({ allowed: true });
    expect(validateLeaseWrite(lease(), { token: "lease-stale", workerId: "worker-a", generation: 2, now: NOW })).toMatchObject({ allowed: false, reason: "stale_lease" });
    expect(validateLeaseWrite(lease({ expiresAt: new Date(NOW.getTime() - 1) }), { token: "lease-current", workerId: "worker-a", generation: 2, now: NOW })).toMatchObject({ allowed: false, reason: "expired_lease" });
    expect(validateLeaseWrite(lease({ revokedAt: NOW }), { token: "lease-current", workerId: "worker-a", generation: 2, now: NOW })).toMatchObject({ allowed: false, reason: "revoked_lease" });
  });

  it("requeues an expired retry-eligible lease and terminally fails exhausted work", () => {
    expect(decideLeaseReclaim({ expiresAt: new Date(NOW.getTime() - 1), retryCount: 1, maxRetries: 3, now: NOW })).toEqual({ action: "requeue", retryCount: 2 });
    expect(decideLeaseReclaim({ expiresAt: new Date(NOW.getTime() - 1), retryCount: 3, maxRetries: 3, now: NOW })).toEqual({ action: "fail" });
    expect(decideLeaseReclaim({ expiresAt: new Date(NOW.getTime() + 1), retryCount: 1, maxRetries: 3, now: NOW })).toEqual({ action: "retain" });
  });

  it("retains two valid leases during an intentional overlap window", () => {
    const overlap = validOverlappingLeases([
      lease({ token: "old", generation: 1, expiresAt: new Date(NOW.getTime() + 5_000) }),
      lease({ token: "new", generation: 2, expiresAt: new Date(NOW.getTime() + 60_000) }),
      lease({ token: "revoked", generation: 3, revokedAt: NOW }),
    ], NOW);
    expect(overlap.map((item) => item.token)).toEqual(["old", "new"]);
  });
});
