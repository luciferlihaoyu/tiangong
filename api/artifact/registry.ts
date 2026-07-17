/**
 * Phase 1 Task 6: Artifact/object metadata registry service.
 *
 * Metadata-only abstraction. No S3/WebDAV/NAS clients, no upload/download,
 * no file streaming, no raw credential storage.
 */
import { TRPCError } from "@trpc/server";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { artifactRegistry } from "@db/schema";
import type { AuthedUser } from "../workspace/auth";
import { requireCapability } from "../workspace/capability";
import { verifyProjectInWorkspace } from "../secret-vault/access";
import { writeAuditEvent, auditChangedFields } from "../lib/audit-log";
import { validateSafeConfig, type SafeConfigValue } from "../connector/config";
import {
  metadataProjection,
  scopeFilter,
  type ArtifactType,
  type ArtifactStatus,
  type StorageBackrefType,
} from "./definitions";

export {
  ARTIFACT_TYPES,
  ARTIFACT_STATUSES,
  STORAGE_BACKREF_TYPES,
  ARTIFACT_DEFINITIONS,
  type ArtifactType,
  type ArtifactStatus,
  type StorageBackrefType,
} from "./definitions";

export async function listArtifacts(
  workspaceId: number,
  projectId: number | null | undefined,
  taskId: number | null | undefined,
  user: AuthedUser
) {
  await requireCapability(workspaceId, user, "artifact:read");
  if (projectId !== null && projectId !== undefined) {
    await verifyProjectInWorkspace(projectId, workspaceId);
  }
  const db = getDb();
  const conditions = [eq(artifactRegistry.workspaceId, workspaceId)];
  if (projectId !== null && projectId !== undefined) {
    conditions.push(eq(artifactRegistry.projectId, projectId));
  }
  if (taskId !== null && taskId !== undefined) {
    conditions.push(eq(artifactRegistry.taskId, taskId));
  }
  return db
    .select(metadataProjection)
    .from(artifactRegistry)
    .where(and(...conditions))
    .orderBy(desc(artifactRegistry.updatedAt));
}

export async function getArtifact(artifactId: number, user: AuthedUser) {
  const db = getDb();
  const artifact = await db
    .select()
    .from(artifactRegistry)
    .where(eq(artifactRegistry.id, artifactId))
    .then((rows) => rows[0] ?? null);
  if (!artifact) return null;
  await requireCapability(artifact.workspaceId, user, "artifact:read");
  if (artifact.projectId !== null) {
    await verifyProjectInWorkspace(artifact.projectId, artifact.workspaceId);
  }
  return artifact;
}

export async function createArtifact(
  input: {
    workspaceId: number;
    projectId?: number | null;
    taskId?: number | null;
    name: string;
    slug: string;
    artifactType: ArtifactType;
    mimeType?: string | null;
    sizeBytes?: number | null;
    checksumSha256?: string | null;
    storageBackrefType?: StorageBackrefType | null;
    storageBackrefId?: string | null;
    metadata?: Record<string, SafeConfigValue> | null;
    status?: ArtifactStatus;
  },
  user: AuthedUser
) {
  await requireCapability(input.workspaceId, user, "artifact:manage");
  if (input.projectId !== null && input.projectId !== undefined) {
    await verifyProjectInWorkspace(input.projectId, input.workspaceId);
  }
  const resolvedStatus: ArtifactStatus = input.status ?? "draft";
  const db = getDb();
  const existing = await db
    .select({ id: artifactRegistry.id })
    .from(artifactRegistry)
    .where(scopeFilter(input.workspaceId, input.projectId, input.slug))
    .then((rows) => rows[0] ?? null);
  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Artifact slug already exists in this scope",
    });
  }
  await db.insert(artifactRegistry).values({
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    name: input.name,
    slug: input.slug,
    artifactType: input.artifactType,
    status: resolvedStatus,
    mimeType: input.mimeType ?? null,
    sizeBytes: input.sizeBytes ?? null,
    checksumSha256: input.checksumSha256 ?? null,
    storageBackrefType: input.storageBackrefType ?? null,
    storageBackrefId: input.storageBackrefId ?? null,
    metadata: validateSafeConfig(input.metadata),
    createdBy: user.id,
    updatedBy: user.id,
  });
  const created = await db
    .select({ id: artifactRegistry.id })
    .from(artifactRegistry)
    .where(scopeFilter(input.workspaceId, input.projectId, input.slug))
    .then((rows) => rows[0] ?? null);
  const artifactId = created?.id;
  if (!artifactId) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "创建 Artifact 失败" });
  }
  writeAuditEvent({
    event: "artifact:created",
    actorUserId: user.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    entityType: "artifact",
    entityId: artifactId,
    metadata: {
      name: input.name,
      artifactType: input.artifactType,
      status: resolvedStatus,
    },
  });
  return { success: true, artifactId };
}

export async function updateArtifact(
  artifactId: number,
  fields: {
    name?: string;
    status?: ArtifactStatus;
    mimeType?: string | null;
    sizeBytes?: number | null;
    checksumSha256?: string | null;
    storageBackrefType?: StorageBackrefType | null;
    storageBackrefId?: string | null;
    metadata?: Record<string, SafeConfigValue> | null;
  },
  user: AuthedUser
) {
  const artifact = await getArtifact(artifactId, user);
  if (!artifact) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found" });
  }
  await requireCapability(artifact.workspaceId, user, "artifact:manage");
  const updateFields: Record<string, unknown> = { updatedBy: user.id };
  if (fields.name !== undefined) updateFields.name = fields.name;
  if (fields.status !== undefined) updateFields.status = fields.status;
  if (fields.mimeType !== undefined) updateFields.mimeType = fields.mimeType;
  if (fields.sizeBytes !== undefined) updateFields.sizeBytes = fields.sizeBytes;
  if (fields.checksumSha256 !== undefined) updateFields.checksumSha256 = fields.checksumSha256;
  if (fields.storageBackrefType !== undefined) updateFields.storageBackrefType = fields.storageBackrefType;
  if (fields.storageBackrefId !== undefined) updateFields.storageBackrefId = fields.storageBackrefId;
  if (fields.metadata !== undefined) {
    updateFields.metadata = validateSafeConfig(fields.metadata);
  }
  const changedFields = auditChangedFields({
    name: fields.name,
    status: fields.status,
    mimeType: fields.mimeType,
    sizeBytes: fields.sizeBytes,
    checksumSha256: fields.checksumSha256,
    storageBackrefType: fields.storageBackrefType,
    storageBackrefId: fields.storageBackrefId,
    metadata: fields.metadata,
  });
  const db = getDb();
  await db.update(artifactRegistry).set(updateFields).where(eq(artifactRegistry.id, artifactId));
  writeAuditEvent({
    event: "artifact:updated",
    actorUserId: user.id,
    workspaceId: artifact.workspaceId,
    projectId: artifact.projectId ?? null,
    entityType: "artifact",
    entityId: artifactId,
    metadata: {
      name: fields.name ?? artifact.name,
      artifactType: artifact.artifactType,
      status: fields.status ?? artifact.status,
      changed: changedFields,
    },
  });
  return { success: true };
}

export async function deleteArtifact(artifactId: number, user: AuthedUser) {
  const artifact = await getArtifact(artifactId, user);
  if (!artifact) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Artifact not found" });
  }
  await requireCapability(artifact.workspaceId, user, "artifact:manage");
  writeAuditEvent({
    event: "artifact:deleted",
    actorUserId: user.id,
    workspaceId: artifact.workspaceId,
    projectId: artifact.projectId ?? null,
    entityType: "artifact",
    entityId: artifactId,
    metadata: {
      name: artifact.name,
      artifactType: artifact.artifactType,
      status: artifact.status,
    },
  });
  const db = getDb();
  await db.delete(artifactRegistry).where(eq(artifactRegistry.id, artifactId));
  return { success: true };
}

export async function deleteArtifactsByProjectId(projectId: number) {
  const db = getDb();
  await db.delete(artifactRegistry).where(eq(artifactRegistry.projectId, projectId));
}

export async function deleteArtifactsByWorkspaceId(workspaceId: number) {
  const db = getDb();
  await db.delete(artifactRegistry).where(eq(artifactRegistry.workspaceId, workspaceId));
}
