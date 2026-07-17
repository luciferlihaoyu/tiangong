import { TRPCError } from "@trpc/server";
import { eq, and } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { secretVaultItems, type InsertSecretVaultItem } from "@db/schema";
import type { AuthedUser } from "../workspace/auth";
import { requireCapability } from "../workspace/capability";
import { encryptSecret, type EncryptedEnvelope } from "./crypto";
import { requireItemAccess, requireProjectWriteAccess, verifyProjectInWorkspace } from "./access";
import { writeAuditEvent, auditChangedFields } from "../lib/audit-log";

export type SecretRef = {
  id: number;
  workspaceId: number;
  projectId: number;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const metadataProjection = {
  id: secretVaultItems.id,
  workspaceId: secretVaultItems.workspaceId,
  projectId: secretVaultItems.projectId,
  name: secretVaultItems.name,
  description: secretVaultItems.description,
  createdAt: secretVaultItems.createdAt,
  updatedAt: secretVaultItems.updatedAt,
};

export async function listSecrets(
  workspaceId: number,
  projectId: number,
  user: AuthedUser
): Promise<SecretRef[]> {
  await requireCapability(workspaceId, user, "secret:read");
  await verifyProjectInWorkspace(projectId, workspaceId);
  const db = getDb();
  return db
    .select(metadataProjection)
    .from(secretVaultItems)
    .where(
      and(
        eq(secretVaultItems.workspaceId, workspaceId),
        eq(secretVaultItems.projectId, projectId)
      )
    )
    .orderBy(secretVaultItems.name);
}

export async function getSecret(
  itemId: number,
  user: AuthedUser
): Promise<SecretRef | null> {
  await requireItemAccess(itemId, user, "viewer");
  const db = getDb();
  return db
    .select(metadataProjection)
    .from(secretVaultItems)
    .where(eq(secretVaultItems.id, itemId))
    .then((rows) => rows[0] ?? null);
}

export async function createSecret(
  input: {
    workspaceId: number;
    projectId: number;
    name: string;
    description?: string;
    plaintext: string;
  },
  user: AuthedUser
): Promise<{ success: true }> {
  await requireProjectWriteAccess(input.workspaceId, input.projectId, user);
  const envelope = encryptSecret(
    input.plaintext,
    input.workspaceId,
    input.projectId,
    input.name
  );
  const db = getDb();
  await db.insert(secretVaultItems).values({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    name: input.name,
    description: input.description ?? null,
    createdBy: user.id,
    updatedBy: user.id,
    ...envelope,
  });
  const created = await db
    .select({ id: secretVaultItems.id })
    .from(secretVaultItems)
    .where(
      and(
        eq(secretVaultItems.workspaceId, input.workspaceId),
        eq(secretVaultItems.projectId, input.projectId),
        eq(secretVaultItems.name, input.name)
      )
    )
    .then((rows) => rows[0] ?? null);
  writeAuditEvent({
    event: "secret:created",
    actorUserId: user.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    entityType: "secret",
    entityId: created?.id ?? null,
    metadata: {
      name: input.name,
    },
  });
  return { success: true };
}

export async function updateSecret(
  itemId: number,
  input: {
    name?: string;
    description?: string;
    plaintext?: string;
  },
  user: AuthedUser
): Promise<{ success: true }> {
  const existing = await requireItemAccess(itemId, user, "admin");
  const newName = input.name ?? existing.name;
  if (
    input.name !== undefined &&
    input.name !== existing.name &&
    input.plaintext === undefined
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cannot rename secret without providing plaintext for re-encryption",
    });
  }
  let envelope: EncryptedEnvelope | undefined;
  if (input.plaintext !== undefined) {
    envelope = encryptSecret(
      input.plaintext,
      existing.workspaceId,
      existing.projectId,
      newName
    );
  }
  const updateFields: Partial<InsertSecretVaultItem> & { updatedBy: number } = {
    updatedBy: user.id,
  };
  if (input.name !== undefined) updateFields.name = input.name;
  if (input.description !== undefined) {
    updateFields.description = input.description;
  }
  if (envelope) {
    updateFields.algorithm = envelope.algorithm;
    updateFields.keyId = envelope.keyId;
    updateFields.envelopeVersion = envelope.envelopeVersion;
    updateFields.nonce = envelope.nonce;
    updateFields.authTag = envelope.authTag;
    updateFields.ciphertext = envelope.ciphertext;
  }
  const db = getDb();
  await db.update(secretVaultItems).set(updateFields).where(eq(secretVaultItems.id, itemId));
  const changedFields = auditChangedFields({
    name: input.name,
    description: input.description,
  });
  if (input.plaintext !== undefined) {
    changedFields.push("value");
  }
  writeAuditEvent({
    event: "secret:updated",
    actorUserId: user.id,
    workspaceId: existing.workspaceId,
    projectId: existing.projectId,
    entityType: "secret",
    entityId: itemId,
    metadata: {
      name: input.name,
      changed: changedFields,
    },
  });
  return { success: true };
}

export async function deleteSecret(
  itemId: number,
  user: AuthedUser
): Promise<{ success: true }> {
  const item = await requireItemAccess(itemId, user, "admin");
  writeAuditEvent({
    event: "secret:deleted",
    actorUserId: user.id,
    workspaceId: item.workspaceId,
    projectId: item.projectId,
    entityType: "secret",
    entityId: itemId,
    metadata: { name: item.name },
  });
  const db = getDb();
  await db.delete(secretVaultItems).where(eq(secretVaultItems.id, itemId));
  return { success: true };
}

export async function deleteSecretsByProjectId(projectId: number): Promise<void> {
  const db = getDb();
  await db.delete(secretVaultItems).where(eq(secretVaultItems.projectId, projectId));
}

export async function deleteSecretsByWorkspaceId(workspaceId: number): Promise<void> {
  const db = getDb();
  await db.delete(secretVaultItems).where(eq(secretVaultItems.workspaceId, workspaceId));
}
