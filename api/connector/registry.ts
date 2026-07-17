import { TRPCError } from "@trpc/server";
import { eq, and, isNull, desc } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { connectorRegistry } from "@db/schema";
import type { AuthedUser } from "../workspace/auth";
import { requireCapability } from "../workspace/capability";
import { verifyProjectInWorkspace } from "../secret-vault/access";
import { writeAuditEvent, auditChangedFields } from "../lib/audit-log";
import { validateSafeConfig, validateSafeEndpoint, type SafeConfigValue } from "./config";

export const CONNECTOR_TYPES = ["opencode", "xuanji", "s3"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export const CONNECTOR_STATUSES = ["draft", "active", "disabled"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const CONNECTOR_DEFINITIONS: Record<
  ConnectorType,
  { label: string; description: string; placeholder: true }
> = {
  opencode: {
    label: "OpenCode",
    description: "Placeholder definition for OpenCode adapter. No runtime bridge implemented.",
    placeholder: true,
  },
  xuanji: {
    label: "Xuanji",
    description: "Placeholder definition for Xuanji adapter. No runtime bridge implemented.",
    placeholder: true,
  },
  s3: {
    label: "S3-compatible",
    description: "Placeholder definition for S3-compatible object storage adapter. No runtime client implemented.",
    placeholder: true,
  },
};

const metadataProjection = {
  id: connectorRegistry.id,
  workspaceId: connectorRegistry.workspaceId,
  projectId: connectorRegistry.projectId,
  name: connectorRegistry.name,
  slug: connectorRegistry.slug,
  connectorType: connectorRegistry.connectorType,
  status: connectorRegistry.status,
  createdAt: connectorRegistry.createdAt,
  updatedAt: connectorRegistry.updatedAt,
};

function scopeFilter(
  workspaceId: number,
  projectId: number | null | undefined,
  slug: string
) {
  const projectCondition =
    projectId === null || projectId === undefined
      ? isNull(connectorRegistry.projectId)
      : eq(connectorRegistry.projectId, projectId);
  return and(
    eq(connectorRegistry.workspaceId, workspaceId),
    projectCondition,
    eq(connectorRegistry.slug, slug)
  );
}

export async function listConnectors(
  workspaceId: number,
  projectId: number | null | undefined,
  user: AuthedUser
) {
  await requireCapability(workspaceId, user, "connector:read");
  if (projectId !== null && projectId !== undefined) {
    await verifyProjectInWorkspace(projectId, workspaceId);
  }
  const db = getDb();
  const conditions = [eq(connectorRegistry.workspaceId, workspaceId)];
  if (projectId !== null && projectId !== undefined) {
    conditions.push(eq(connectorRegistry.projectId, projectId));
  }
  return db
    .select(metadataProjection)
    .from(connectorRegistry)
    .where(and(...conditions))
    .orderBy(desc(connectorRegistry.updatedAt));
}

export async function getConnector(connectorId: number, user: AuthedUser) {
  const db = getDb();
  const connector = await db
    .select()
    .from(connectorRegistry)
    .where(eq(connectorRegistry.id, connectorId))
    .then((rows) => rows[0] ?? null);
  if (!connector) return null;
  await requireCapability(connector.workspaceId, user, "connector:read");
  if (connector.projectId !== null) {
    await verifyProjectInWorkspace(connector.projectId, connector.workspaceId);
  }
  return connector;
}

export async function createConnector(
  input: {
    workspaceId: number;
    projectId?: number | null;
    name: string;
    slug: string;
    connectorType: ConnectorType;
    endpoint?: string | null;
    config?: Record<string, SafeConfigValue> | null;
    status?: ConnectorStatus;
    secretRefId?: number | null;
  },
  user: AuthedUser
) {
  await requireCapability(input.workspaceId, user, "connector:manage");
  if (input.projectId !== null && input.projectId !== undefined) {
    await verifyProjectInWorkspace(input.projectId, input.workspaceId);
  }
  const resolvedStatus: ConnectorStatus = input.status ?? "draft";
  const db = getDb();
  const existing = await db
    .select({ id: connectorRegistry.id })
    .from(connectorRegistry)
    .where(scopeFilter(input.workspaceId, input.projectId, input.slug))
    .then((rows) => rows[0] ?? null);
  if (existing) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Connector slug already exists in this scope",
    });
  }
  await db.insert(connectorRegistry).values({
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    name: input.name,
    slug: input.slug,
    connectorType: input.connectorType,
    status: resolvedStatus,
    endpoint: validateSafeEndpoint(input.endpoint),
    config: validateSafeConfig(input.config),
    secretRefId: input.secretRefId ?? null,
    createdBy: user.id,
    updatedBy: user.id,
  });
  const created = await db
    .select({ id: connectorRegistry.id })
    .from(connectorRegistry)
    .where(scopeFilter(input.workspaceId, input.projectId, input.slug))
    .then((rows) => rows[0] ?? null);
  const connectorId = created?.id;
  if (!connectorId) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "创建连接器失败" });
  }
  writeAuditEvent({
    event: "connector:created",
    actorUserId: user.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId ?? null,
    entityType: "connector",
    entityId: connectorId,
    metadata: {
      name: input.name,
      connectorType: input.connectorType,
      status: resolvedStatus,
    },
  });
  return { success: true, connectorId };
}

export async function updateConnector(
  connectorId: number,
  fields: {
    name?: string;
    endpoint?: string | null;
    config?: Record<string, SafeConfigValue> | null;
    status?: ConnectorStatus;
    secretRefId?: number | null;
  },
  user: AuthedUser
) {
  const connector = await getConnector(connectorId, user);
  if (!connector) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Connector not found" });
  }
  await requireCapability(connector.workspaceId, user, "connector:manage");
  const updateFields: Record<string, unknown> = { updatedBy: user.id };
  if (fields.name !== undefined) updateFields.name = fields.name;
  if (fields.endpoint !== undefined) updateFields.endpoint = validateSafeEndpoint(fields.endpoint);
  if (fields.config !== undefined) {
    updateFields.config = validateSafeConfig(fields.config);
  }
  if (fields.status !== undefined) {
    updateFields.status = fields.status;
  }
  if (fields.secretRefId !== undefined) {
    updateFields.secretRefId = fields.secretRefId;
  }
  const changedFields = auditChangedFields({
    name: fields.name,
    endpoint: fields.endpoint,
    config: fields.config,
    status: fields.status,
    secretRefId: fields.secretRefId,
  });
  const db = getDb();
  await db.update(connectorRegistry).set(updateFields).where(eq(connectorRegistry.id, connectorId));
  writeAuditEvent({
    event: "connector:updated",
    actorUserId: user.id,
    workspaceId: connector.workspaceId,
    projectId: connector.projectId ?? null,
    entityType: "connector",
    entityId: connectorId,
    metadata: {
      name: fields.name ?? connector.name,
      connectorType: connector.connectorType,
      status: fields.status ?? connector.status,
      changed: changedFields,
    },
  });
  return { success: true };
}

export async function deleteConnector(
  connectorId: number,
  user: AuthedUser
) {
  const connector = await getConnector(connectorId, user);
  if (!connector) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Connector not found" });
  }
  await requireCapability(connector.workspaceId, user, "connector:manage");
  writeAuditEvent({
    event: "connector:deleted",
    actorUserId: user.id,
    workspaceId: connector.workspaceId,
    projectId: connector.projectId ?? null,
    entityType: "connector",
    entityId: connectorId,
    metadata: {
      name: connector.name,
      connectorType: connector.connectorType,
      status: connector.status,
    },
  });
  const db = getDb();
  await db.delete(connectorRegistry).where(eq(connectorRegistry.id, connectorId));
  return { success: true };
}

export async function deleteConnectorsByProjectId(projectId: number) {
  const db = getDb();
  await db.delete(connectorRegistry).where(eq(connectorRegistry.projectId, projectId));
}

export async function deleteConnectorsByWorkspaceId(workspaceId: number) {
  const db = getDb();
  await db.delete(connectorRegistry).where(eq(connectorRegistry.workspaceId, workspaceId));
}
