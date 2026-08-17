export type TaskLeaseSnapshot = Readonly<{
  token: string;
  workerId: string;
  generation: number;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

type LeaseWrite = Readonly<{
  token: string;
  workerId: string;
  generation: number;
  now: Date;
}>;

export type LeaseWriteDecision =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: "stale_lease" | "expired_lease" | "revoked_lease" }>;

export function validateLeaseWrite(lease: TaskLeaseSnapshot, write: LeaseWrite): LeaseWriteDecision {
  if (lease.revokedAt !== null) return { allowed: false, reason: "revoked_lease" };
  if (lease.expiresAt.getTime() <= write.now.getTime()) return { allowed: false, reason: "expired_lease" };
  if (lease.token !== write.token || lease.workerId !== write.workerId || lease.generation !== write.generation) {
    return { allowed: false, reason: "stale_lease" };
  }
  return { allowed: true };
}

type ReclaimInput = Readonly<{
  expiresAt: Date;
  retryCount: number;
  maxRetries: number;
  now: Date;
}>;

export type ReclaimDecision =
  | Readonly<{ action: "retain" }>
  | Readonly<{ action: "requeue"; retryCount: number }>
  | Readonly<{ action: "fail" }>;

export function decideLeaseReclaim(input: ReclaimInput): ReclaimDecision {
  if (input.expiresAt.getTime() > input.now.getTime()) return { action: "retain" };
  if (input.retryCount < input.maxRetries) return { action: "requeue", retryCount: input.retryCount + 1 };
  return { action: "fail" };
}

export function validOverlappingLeases(leases: readonly TaskLeaseSnapshot[], now: Date): readonly TaskLeaseSnapshot[] {
  return leases.filter((lease) => lease.revokedAt === null && lease.expiresAt.getTime() > now.getTime());
}
