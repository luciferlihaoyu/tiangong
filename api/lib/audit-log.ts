/**
 * Phase 1 Task 4: General audit/event ledger helper.
 *
 * Fire-and-forget, type-safe event emission. Metadata is intentionally closed
 * to a small set of safe fields; no plaintext, ciphertext, credentials, or
 * request bodies may be written through this helper.
 */
import { getDb } from "../queries/connection";
import { auditEvents } from "@db/schema";

export const AUDIT_EVENT_NAMES = [
  "workspace:created",
  "workspace:updated",
  "workspace:deleted",
  "project:created",
  "project:updated",
  "project:deleted",
  "membership:added",
  "membership:role_updated",
  "membership:removed",
  "secret:created",
  "secret:updated",
  "secret:deleted",
  "connector:created",
  "connector:updated",
  "connector:deleted",
  "artifact:created",
  "artifact:updated",
  "artifact:deleted",
  // ── Server-side sweeper events ──
  "task:timeout",
  "task:retry_storm",
  "agent:heartbeat_timeout",
  "task:approval_stale",
  "connector:patrol_failed",
] as const;

export type AuditEventName = (typeof AUDIT_EVENT_NAMES)[number];

export type AuditEntityType =
  | "workspace"
  | "project"
  | "membership"
  | "secret"
  | "connector"
  | "artifact"
  | "task"
  | "agent";

/** Safe, explicitly-constructed metadata fields. No secrets, payloads, or free-form user text. */
export type SafeAuditMetadata = {
  name?: string;
  role?: string;
  fromRole?: string;
  toRole?: string;
  changed?: string[];
  connectorType?: string;
  status?: string;
  artifactType?: string;
  taskId?: string;
  agentId?: number;
  count?: number;
};

export interface WriteAuditEventParams {
  event: AuditEventName;
  actorUserId: number;
  workspaceId?: number | null;
  projectId?: number | null;
  targetUserId?: number | null;
  entityType: AuditEntityType;
  entityId?: number | null;
  metadata?: SafeAuditMetadata;
}

/**
 * Write an audit event to the append-only ledger (fire-and-forget).
 * Never blocks the caller; failures are silently ignored to avoid leaking
 * DB errors to the user surface.
 */
export function writeAuditEvent(params: WriteAuditEventParams): void {
  const db = getDb();
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
  db.insert(auditEvents)
    .values({
      event: params.event,
      actorUserId: params.actorUserId,
      workspaceId: params.workspaceId ?? null,
      projectId: params.projectId ?? null,
      targetUserId: params.targetUserId ?? null,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      metadata: metadataJson,
    })
    .catch(() => {
      // Audit failures are non-fatal; never block the primary operation.
    });
}

export function auditChangedFields(
  fields: Record<string, unknown>
): string[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}
