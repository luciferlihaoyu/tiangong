import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "../queries/connection";
import { workspaces, projects, workspaceMemberships } from "@db/schema";
import { eq, and } from "drizzle-orm";

export const membershipRoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;

export const ROLE_RANK: Record<MembershipRole, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  viewer: 1,
};

function rank(role: MembershipRole): number {
  return ROLE_RANK[role];
}

export type AuthedUser = { id: number; role: string };

export async function requireMembership(
  workspaceId: number,
  user: AuthedUser,
  requiredRole: MembershipRole = "viewer"
): Promise<void> {
  if (user.role === "admin") return;
  const db = getDb();
  const membership = await db
    .select({ role: workspaceMemberships.role })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, user.id)
      )
    )
    .then((rows) => rows[0]);
  if (!membership || rank(membership.role) < rank(requiredRole)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "没有权限访问该工作区" });
  }
}

export async function getWorkspaceById(workspaceId: number) {
  const db = getDb();
  return db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .then((rows) => rows[0] ?? null);
}

export async function getWorkspaceBySlug(slug: string) {
  const db = getDb();
  return db
    .select()
    .from(workspaces)
    .where(eq(workspaces.slug, slug))
    .then((rows) => rows[0] ?? null);
}

export async function getProjectById(projectId: number) {
  const db = getDb();
  return db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .then((rows) => rows[0] ?? null);
}
