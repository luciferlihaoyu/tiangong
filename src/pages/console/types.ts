/**
 * Phase 1 Task 7: Console metadata types.
 *
 * Pure type definitions for the metadata console. Dates are serialized as ISO
 * strings over the tRPC HTTP boundary. These types mirror the backend routers
 * without importing runtime modules from the API tree.
 */

export const MEMBERSHIP_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const CONNECTOR_TYPES = ["opencode", "xuanji", "s3"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export const CONNECTOR_STATUSES = ["draft", "active", "disabled"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const ARTIFACT_TYPES = ["file", "image", "document", "log", "data"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_STATUSES = ["draft", "active", "archived", "deleted"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const STORAGE_BACKREF_TYPES = ["connector", "inline", "external"] as const;
export type StorageBackrefType = (typeof STORAGE_BACKREF_TYPES)[number];

export type Workspace = {
  readonly id: number;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly ownerId: number;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
};

export type Project = {
  readonly id: number;
  readonly workspaceId: number;
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  readonly createdBy: number | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
};

export type Membership = {
  readonly id: number;
  readonly workspaceId: number;
  readonly userId: number;
  readonly role: MembershipRole;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
  readonly username: string | null;
  readonly name: string | null;
};

export type SecretRef = {
  readonly id: number;
  readonly workspaceId: number;
  readonly projectId: number;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
};

export type Connector = {
  readonly id: number;
  readonly workspaceId: number;
  readonly projectId: number | null;
  readonly name: string;
  readonly slug: string;
  readonly connectorType: ConnectorType;
  readonly status: ConnectorStatus;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
};

export type Artifact = {
  readonly id: number;
  readonly workspaceId: number;
  readonly projectId: number | null;
  readonly taskId: number | null;
  readonly name: string;
  readonly slug: string;
  readonly artifactType: ArtifactType;
  readonly status: ArtifactStatus;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly checksumSha256: string | null;
  readonly storageBackrefType: StorageBackrefType | null;
  readonly storageBackrefId: string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
};

export type AuditEvent = {
  readonly id: number;
  readonly event: string;
  readonly actorUserId: number | null;
  readonly workspaceId: number | null;
  readonly projectId: number | null;
  readonly targetUserId: number | null;
  readonly entityType: string | null;
  readonly entityId: number | null;
  readonly metadata: string | null;
  readonly createdAt: Date | string;
};
