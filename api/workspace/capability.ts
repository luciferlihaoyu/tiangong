import { TRPCError } from "@trpc/server";
import { requireMembership } from "./auth";
import type { AuthedUser, MembershipRole } from "./auth";

export const CAPABILITIES = [
  "workspace:read",
  "workspace:update",
  "workspace:delete",
  "project:read",
  "project:create",
  "project:update",
  "project:delete",
  "membership:read",
  "membership:manage",
  "secret:read",
  "secret:manage",
  "connector:read",
  "connector:manage",
  "artifact:read",
  "artifact:manage",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_MIN_ROLE: Record<Capability, MembershipRole> = {
  "workspace:read": "viewer",
  "workspace:update": "admin",
  "workspace:delete": "owner",
  "project:read": "viewer",
  "project:create": "member",
  "project:update": "admin",
  "project:delete": "admin",
  "membership:read": "viewer",
  "membership:manage": "admin",
  "secret:read": "viewer",
  "secret:manage": "admin",
  "connector:read": "viewer",
  "connector:manage": "admin",
  "artifact:read": "viewer",
  "artifact:manage": "admin",
};

export type CapabilityResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export async function checkCapability(
  workspaceId: number,
  user: AuthedUser,
  capability: Capability
): Promise<CapabilityResult> {
  const minRole = CAPABILITY_MIN_ROLE[capability];
  try {
    await requireMembership(workspaceId, user, minRole);
    return { allowed: true };
  } catch (error) {
    if (error instanceof TRPCError) {
      return { allowed: false, reason: error.message };
    }
    throw error;
  }
}

export async function requireCapability(
  workspaceId: number,
  user: AuthedUser,
  capability: Capability
): Promise<void> {
  const result = await checkCapability(workspaceId, user, capability);
  if (!result.allowed) {
    throw new TRPCError({ code: "FORBIDDEN", message: result.reason });
  }
}
