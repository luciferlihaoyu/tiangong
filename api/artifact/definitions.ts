/**
 * Phase 1 Task 6: Artifact type/status/storage definitions and query helpers.
 *
 * Definitions and projection helpers only; no storage clients or runtime logic.
 */
import { and, eq, isNull } from "drizzle-orm";
import { artifactRegistry } from "@db/schema";

export const ARTIFACT_TYPES = ["file", "image", "document", "log", "data"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_STATUSES = ["draft", "active", "archived", "deleted"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const STORAGE_BACKREF_TYPES = ["connector", "inline", "external"] as const;
export type StorageBackrefType = (typeof STORAGE_BACKREF_TYPES)[number];

export const ARTIFACT_DEFINITIONS: Record<
  ArtifactType,
  { label: string; description: string; placeholder: true }
> = {
  file: {
    label: "File",
    description: "Placeholder definition for generic file artifacts. No upload/download implemented.",
    placeholder: true,
  },
  image: {
    label: "Image",
    description: "Placeholder definition for image artifacts. No upload/download implemented.",
    placeholder: true,
  },
  document: {
    label: "Document",
    description: "Placeholder definition for document artifacts. No upload/download implemented.",
    placeholder: true,
  },
  log: {
    label: "Log",
    description: "Placeholder definition for log artifacts. No streaming implemented.",
    placeholder: true,
  },
  data: {
    label: "Data",
    description: "Placeholder definition for structured data artifacts. No object storage implemented.",
    placeholder: true,
  },
};

export const metadataProjection = {
  id: artifactRegistry.id,
  workspaceId: artifactRegistry.workspaceId,
  projectId: artifactRegistry.projectId,
  taskId: artifactRegistry.taskId,
  name: artifactRegistry.name,
  slug: artifactRegistry.slug,
  artifactType: artifactRegistry.artifactType,
  status: artifactRegistry.status,
  mimeType: artifactRegistry.mimeType,
  sizeBytes: artifactRegistry.sizeBytes,
  checksumSha256: artifactRegistry.checksumSha256,
  storageBackrefType: artifactRegistry.storageBackrefType,
  storageBackrefId: artifactRegistry.storageBackrefId,
  createdAt: artifactRegistry.createdAt,
  updatedAt: artifactRegistry.updatedAt,
};

export function scopeFilter(
  workspaceId: number,
  projectId: number | null | undefined,
  slug: string
) {
  const projectCondition =
    projectId === null || projectId === undefined
      ? isNull(artifactRegistry.projectId)
      : eq(artifactRegistry.projectId, projectId);
  return and(
    eq(artifactRegistry.workspaceId, workspaceId),
    projectCondition,
    eq(artifactRegistry.slug, slug)
  );
}
