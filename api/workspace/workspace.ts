import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { workspaces, projects, workspaceMemberships } from "@db/schema";
import { eq, inArray } from "drizzle-orm";
import { getWorkspaceById, getWorkspaceBySlug } from "./auth";
import type { AuthedUser } from "./auth";
import { requireCapability } from "./capability";
import { deleteSecretsByWorkspaceId } from "../secret-vault/item";
import { deleteConnectorsByWorkspaceId } from "../connector/registry";
import { deleteArtifactsByWorkspaceId } from "../artifact/registry";
import { writeAuditEvent, auditChangedFields } from "../lib/audit-log";

export async function listWorkspaces(user: AuthedUser) {
  const db = getDb();
  if (user.role === "admin") {
    return db.select().from(workspaces);
  }
  const memberships = await db
    .select({ workspaceId: workspaceMemberships.workspaceId })
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.userId, user.id));
  const ids = memberships.map((m) => m.workspaceId);
  if (ids.length === 0) return [];
  return db.select().from(workspaces).where(inArray(workspaces.id, ids));
}

export async function getWorkspace(workspaceId: number, user: AuthedUser) {
  await requireCapability(workspaceId, user, "workspace:read");
  return getWorkspaceById(workspaceId);
}

export async function createWorkspace(
  input: { name: string; slug: string; description?: string },
  user: AuthedUser
) {
  const db = getDb();
  const existing = await getWorkspaceBySlug(input.slug);
  if (existing) {
    throw new TRPCError({ code: "CONFLICT", message: "工作区 slug 已存在" });
  }
  await db.insert(workspaces).values({
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    ownerId: user.id,
  });
  const workspace = await getWorkspaceBySlug(input.slug);
  if (!workspace) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "创建工作区失败" });
  }
  await db.insert(workspaceMemberships).values({
    workspaceId: workspace.id,
    userId: user.id,
    role: "owner",
  });
  writeAuditEvent({
    event: "workspace:created",
    actorUserId: user.id,
    workspaceId: workspace.id,
    entityType: "workspace",
    entityId: workspace.id,
    metadata: {
      name: input.name,
    },
  });
  return { success: true, workspaceId: workspace.id };
}

export async function updateWorkspace(
  workspaceId: number,
  fields: { name?: string; description?: string },
  user: AuthedUser
) {
  await requireCapability(workspaceId, user, "workspace:update");
  const db = getDb();
  const updateFields: Record<string, unknown> = {};
  if (fields.name !== undefined) updateFields.name = fields.name;
  if (fields.description !== undefined) updateFields.description = fields.description;
  if (Object.keys(updateFields).length > 0) {
    await db.update(workspaces).set(updateFields).where(eq(workspaces.id, workspaceId));
  }
  writeAuditEvent({
    event: "workspace:updated",
    actorUserId: user.id,
    workspaceId,
    entityType: "workspace",
    entityId: workspaceId,
    metadata: {
      name: fields.name,
      changed: auditChangedFields(fields),
    },
  });
  return { success: true };
}

export async function deleteWorkspace(workspaceId: number, user: AuthedUser) {
  await requireCapability(workspaceId, user, "workspace:delete");
  const workspace = await getWorkspaceById(workspaceId);
  const db = getDb();
  writeAuditEvent({
    event: "workspace:deleted",
    actorUserId: user.id,
    workspaceId,
    entityType: "workspace",
    entityId: workspaceId,
    metadata: workspace ? { name: workspace.name } : undefined,
  });
  await deleteSecretsByWorkspaceId(workspaceId);
  await deleteConnectorsByWorkspaceId(workspaceId);
  await deleteArtifactsByWorkspaceId(workspaceId);
  await db.delete(projects).where(eq(projects.workspaceId, workspaceId));
  await db.delete(workspaceMemberships).where(eq(workspaceMemberships.workspaceId, workspaceId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  return { success: true };
}
