import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { projects } from "@db/schema";
import { eq, and } from "drizzle-orm";
import { getProjectById } from "./auth";
import type { AuthedUser } from "./auth";
import { requireCapability } from "./capability";
import { deleteSecretsByProjectId } from "../secret-vault/item";
import { deleteConnectorsByProjectId } from "../connector/registry";
import { deleteArtifactsByProjectId } from "../artifact/registry";
import { writeAuditEvent, auditChangedFields } from "../lib/audit-log";

export async function listProjects(workspaceId: number, user: AuthedUser) {
  await requireCapability(workspaceId, user, "project:read");
  const db = getDb();
  return db.select().from(projects).where(eq(projects.workspaceId, workspaceId));
}

export async function getProject(projectId: number, user: AuthedUser) {
  const project = await getProjectById(projectId);
  if (!project) return null;
  await requireCapability(project.workspaceId, user, "project:read");
  return project;
}

export async function createProject(
  input: { workspaceId: number; name: string; slug: string; description?: string },
  user: AuthedUser
) {
  await requireCapability(input.workspaceId, user, "project:create");
  const db = getDb();
  const existing = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, input.workspaceId),
        eq(projects.slug, input.slug)
      )
    )
    .then((rows) => rows[0]);
  if (existing) {
    throw new TRPCError({ code: "CONFLICT", message: "项目 slug 在该工作区已存在" });
  }
  await db.insert(projects).values({
    workspaceId: input.workspaceId,
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    createdBy: user.id,
  });
  const created = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.workspaceId, input.workspaceId), eq(projects.slug, input.slug)))
    .then((rows) => rows[0] ?? null);
  writeAuditEvent({
    event: "project:created",
    actorUserId: user.id,
    workspaceId: input.workspaceId,
    projectId: created?.id ?? null,
    entityType: "project",
    entityId: created?.id ?? null,
    metadata: {
      name: input.name,
    },
  });
  return { success: true };
}

export async function updateProject(
  projectId: number,
  fields: { name?: string; description?: string },
  user: AuthedUser
) {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在" });
  }
  await requireCapability(project.workspaceId, user, "project:update");
  const db = getDb();
  const updateFields: Record<string, unknown> = {};
  if (fields.name !== undefined) updateFields.name = fields.name;
  if (fields.description !== undefined) updateFields.description = fields.description;
  if (Object.keys(updateFields).length > 0) {
    await db.update(projects).set(updateFields).where(eq(projects.id, projectId));
  }
  writeAuditEvent({
    event: "project:updated",
    actorUserId: user.id,
    workspaceId: project.workspaceId,
    projectId,
    entityType: "project",
    entityId: projectId,
    metadata: {
      name: fields.name,
      changed: auditChangedFields(fields),
    },
  });
  return { success: true };
}

export async function deleteProject(projectId: number, user: AuthedUser) {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new TRPCError({ code: "NOT_FOUND", message: "项目不存在" });
  }
  await requireCapability(project.workspaceId, user, "project:delete");
  const db = getDb();
  writeAuditEvent({
    event: "project:deleted",
    actorUserId: user.id,
    workspaceId: project.workspaceId,
    projectId,
    entityType: "project",
    entityId: projectId,
    metadata: { name: project.name },
  });
  await deleteSecretsByProjectId(projectId);
  await deleteConnectorsByProjectId(projectId);
  await deleteArtifactsByProjectId(projectId);
  await db.delete(projects).where(eq(projects.id, projectId));
  return { success: true };
}
