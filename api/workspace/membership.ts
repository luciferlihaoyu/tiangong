import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { workspaceMemberships, users } from "@db/schema";
import { eq, and } from "drizzle-orm";
import type { AuthedUser, MembershipRole } from "./auth";
import { requireCapability } from "./capability";
import { writeAuditEvent } from "../lib/audit-log";

export async function listMemberships(workspaceId: number, user: AuthedUser) {
  await requireCapability(workspaceId, user, "membership:read");
  const db = getDb();
  return db
    .select({
      id: workspaceMemberships.id,
      workspaceId: workspaceMemberships.workspaceId,
      userId: workspaceMemberships.userId,
      role: workspaceMemberships.role,
      createdAt: workspaceMemberships.createdAt,
      updatedAt: workspaceMemberships.updatedAt,
      username: users.username,
      name: users.name,
    })
    .from(workspaceMemberships)
    .leftJoin(users, eq(workspaceMemberships.userId, users.id))
    .where(eq(workspaceMemberships.workspaceId, workspaceId));
}

export async function addMembership(
  input: { workspaceId: number; userId: number; role: MembershipRole },
  byUser: AuthedUser
) {
  await requireCapability(input.workspaceId, byUser, "membership:manage");
  const db = getDb();
  const targetUser = await db
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .then((rows) => rows[0]);
  if (!targetUser) {
    throw new TRPCError({ code: "NOT_FOUND", message: "用户不存在" });
  }
  const existing = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId)
      )
    )
    .then((rows) => rows[0]);
  if (existing) {
    throw new TRPCError({ code: "CONFLICT", message: "用户已经是该工作区成员" });
  }
  await db.insert(workspaceMemberships).values({
    workspaceId: input.workspaceId,
    userId: input.userId,
    role: input.role,
  });
  const created = await db
    .select({ id: workspaceMemberships.id })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId)
      )
    )
    .then((rows) => rows[0] ?? null);
  writeAuditEvent({
    event: "membership:added",
    actorUserId: byUser.id,
    workspaceId: input.workspaceId,
    targetUserId: input.userId,
    entityType: "membership",
    entityId: created?.id ?? null,
    metadata: { role: input.role },
  });
  return { success: true };
}

export async function updateMembershipRole(
  input: { workspaceId: number; userId: number; role: MembershipRole },
  byUser: AuthedUser
) {
  await requireCapability(input.workspaceId, byUser, "membership:manage");
  const db = getDb();
  const membership = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId)
      )
    )
    .then((rows) => rows[0]);
  if (!membership) {
    throw new TRPCError({ code: "NOT_FOUND", message: "成员不存在" });
  }
  if (membership.role === "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "不能修改所有者角色" });
  }
  await db
    .update(workspaceMemberships)
    .set({ role: input.role })
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        eq(workspaceMemberships.userId, input.userId)
      )
    );
  writeAuditEvent({
    event: "membership:role_updated",
    actorUserId: byUser.id,
    workspaceId: input.workspaceId,
    targetUserId: input.userId,
    entityType: "membership",
    entityId: membership.id,
    metadata: {
      fromRole: membership.role,
      toRole: input.role,
    },
  });
  return { success: true };
}

export async function removeMembership(
  workspaceId: number,
  userId: number,
  byUser: AuthedUser
) {
  await requireCapability(workspaceId, byUser, "membership:manage");
  const db = getDb();
  const membership = await db
    .select()
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId)
      )
    )
    .then((rows) => rows[0]);
  if (!membership) {
    throw new TRPCError({ code: "NOT_FOUND", message: "成员不存在" });
  }
  if (membership.role === "owner") {
    throw new TRPCError({ code: "FORBIDDEN", message: "不能移除所有者" });
  }
  writeAuditEvent({
    event: "membership:removed",
    actorUserId: byUser.id,
    workspaceId,
    targetUserId: userId,
    entityType: "membership",
    entityId: membership.id,
    metadata: { role: membership.role },
  });
  await db
    .delete(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, workspaceId),
        eq(workspaceMemberships.userId, userId)
      )
    );
  return { success: true };
}
