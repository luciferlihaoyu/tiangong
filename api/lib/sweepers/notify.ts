/**
 * Shared alert/notification helpers for the server-side sweepers.
 *
 * Sweepers never talk to users directly; they only emit audit events and
 * mailbox notifications, both as the system actor (actorUserId 0, fromAgentId null).
 */
import {
  writeAuditEvent,
  type AuditEntityType,
  type AuditEventName,
  type SafeAuditMetadata,
} from "../audit-log";
import { sendMailboxNotification } from "../taskboard-notify";

export type SweeperAuditParams = Readonly<{
  event: AuditEventName;
  entityType: AuditEntityType;
  entityId?: number | null;
  metadata?: SafeAuditMetadata;
}>;

/** Fire-and-forget audit event emitted as the system actor. */
export function emitSweeperAudit(params: SweeperAuditParams): void {
  writeAuditEvent({
    event: params.event,
    actorUserId: 0,
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    metadata: params.metadata,
  });
}

export type SweeperMailboxParams = Readonly<{
  toAgentId: number;
  taskId: number;
  subject: string;
  body: string;
}>;

/** Push a review_request mailbox message from the system to an agent. */
export async function notifyAgentMailbox(params: SweeperMailboxParams): Promise<void> {
  await sendMailboxNotification({
    fromAgentId: null,
    toAgentId: params.toAgentId,
    taskId: params.taskId,
    type: "review_request",
    subject: params.subject,
    body: params.body,
  });
}
