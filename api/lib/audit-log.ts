/**
 * Phase 1 Task 4: General audit/event ledger helper.
 *
 * P14 hardening: every row appended through this module participates in an
 * integrity hash chain (block-style). The chain is built by a SINGLE-FLIGHT
 * in-process writer:
 *
 * - `writeAuditEvent(params): void` keeps its fire-and-forget signature and
 *   never blocks callers; internally the write is enqueued on a module-level
 *   promise chain that serializes ALL concurrent callers in this process.
 * - Each enqueued write reads the current chain tail (SELECT id, hash ORDER BY
 *   id DESC LIMIT 1 — served from the in-memory tail cache once warm), links
 *   the new row to it via `prevHash`, computes `hash = sha256(canonical row)`,
 *   INSERTs the row, and refreshes the tail cache.
 * - Why no DB transaction/lock: the promise-chain queue already serializes
 *   every writer in one process, so a tx/lock would add contention and
 *   deadlock surface without improving correctness within that scope.
 *   Cross-process deployments remain best-effort: the first write in each
 *   process re-reads the tail from the DB, so a second process links onto the
 *   chain at its first write. A simultaneous first write from two fresh
 *   processes is the only theoretical race — documented as accepted.
 *
 * Metadata is intentionally closed to a small set of safe fields; no
 * plaintext, ciphertext, credentials, or request bodies may be written through
 * this helper.
 */
import { createHash } from "node:crypto";
import { getDb } from "../queries/connection";
import { auditEvents, type AuditEvent, type InsertAuditEvent } from "@db/schema";
import { asc, desc } from "drizzle-orm";

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
  "task:dispatch_requeued",
  "task:blocked_recovered",
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

// ═══════════════════════════════════════════════════════════════
// Hash chain
// ═══════════════════════════════════════════════════════════════

/** The canonical fields covered by one chain link. */
export interface AuditHashFields {
  event: string;
  actorUserId: number;
  entityType: string;
  entityId: number | null;
  metadataJson: string | null;
  createdAt: Date;
}

/**
 * Canonical string is JSON.stringify of a fixed-position array of primitives
 * (nulls explicit) — deterministic, no whitespace or key-order ambiguity.
 */
export function computeAuditHash(prevHash: string | null, fields: AuditHashFields): string {
  const canonical = JSON.stringify([
    prevHash,
    fields.event,
    fields.actorUserId,
    fields.entityType,
    fields.entityId,
    fields.metadataJson,
    fields.createdAt.toISOString(),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Floor a Date to whole seconds. MySQL TIMESTAMP columns have no fractional
 * seconds and ROUND the fractional part on insert; hashing the millisecond
 * value and storing a rounded one would break every row's verification. By
 * flooring first, the hashed string and the stored value are identical.
 */
function floorToSecond(date: Date): Date {
  return new Date(Math.trunc(date.getTime() / 1000) * 1000);
}

// ═══════════════════════════════════════════════════════════════
// Injectable DB seam
// ═══════════════════════════════════════════════════════════════

export type AuditChainTail = Readonly<{ id: number | null; hash: string | null }>;

/**
 * The narrow DB contract the ledger depends on. Kept semantic on purpose so
 * tests can drive a plain mock; `adaptAuditDb` maps the real Drizzle instance
 * onto it.
 */
export interface AuditDb {
  selectTail(): Promise<readonly { id: number; hash: string | null }[]>;
  selectAllRows(): Promise<readonly AuditEvent[]>;
  insertRow(row: InsertAuditEvent): Promise<unknown>;
}

type DrizzleDb = ReturnType<typeof getDb>;

/** Cast-free mapping of the real Drizzle instance onto the ledger's narrow contract. */
export function adaptAuditDb(db: DrizzleDb): AuditDb {
  return {
    selectTail: () =>
      db
        .select({ id: auditEvents.id, hash: auditEvents.hash })
        .from(auditEvents)
        .orderBy(desc(auditEvents.id))
        .limit(1),
    selectAllRows: () => db.select().from(auditEvents).orderBy(asc(auditEvents.id)),
    insertRow: (row) => db.insert(auditEvents).values(row),
  };
}

// ═══════════════════════════════════════════════════════════════
// Single-flight writer
// ═══════════════════════════════════════════════════════════════

export interface AuditLogger {
  /** Fire-and-forget; enqueues the write on the serialized chain. */
  writeAuditEvent(params: WriteAuditEventParams): void;
  /** Resolves when the queue is drained (used by tests and shutdown). */
  flush(): Promise<void>;
  /** Tail of the in-memory chain cache; null before the first successful write. */
  getTailCache(): AuditChainTail | null;
}

/** Best-effort extraction of the auto-increment id from a MySQL insert result. */
function insertIdOf(result: unknown): number | null {
  const header = (Array.isArray(result) ? result[0] : result) as { insertId?: unknown } | null;
  return header && typeof header.insertId === "number" ? header.insertId : null;
}

export function createAuditLogger(dbFn: () => AuditDb): AuditLogger {
  let chain: Promise<void> = Promise.resolve();
  let tailCache: AuditChainTail = { id: null, hash: null };

  function enqueue(task: () => Promise<void>): void {
    chain = chain
      .catch(() => {
        // A failed write must never stall the queue for later callers.
      })
      .then(task)
      .catch((err: unknown) => {
        console.error(
          "[audit-log] write failed:",
          err instanceof Error ? err.message : String(err)
        );
      });
  }

  return {
    writeAuditEvent(params: WriteAuditEventParams): void {
      enqueue(async () => {
        const db = dbFn();
        const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
        const createdAt = floorToSecond(new Date());
        // Chain tail: served from the in-memory cache once warm (this process
        // holds the single-flight queue, so the cache cannot go stale); the
        // DB is read on cache miss — fresh process, or legacy rows that
        // predate the chain.
        const tail =
          tailCache.hash !== null
            ? tailCache
            : ((await db.selectTail())[0] ?? null);
        const prevHash = tail?.hash ?? null;
        const hash = computeAuditHash(prevHash, {
          event: params.event,
          actorUserId: params.actorUserId,
          entityType: params.entityType,
          entityId: params.entityId ?? null,
          metadataJson,
          createdAt,
        });
        const result = await db.insertRow({
          event: params.event,
          actorUserId: params.actorUserId,
          workspaceId: params.workspaceId ?? null,
          projectId: params.projectId ?? null,
          targetUserId: params.targetUserId ?? null,
          entityType: params.entityType,
          entityId: params.entityId ?? null,
          metadata: metadataJson,
          createdAt,
          prevHash,
          hash,
        });
        tailCache = { id: insertIdOf(result), hash };
      });
    },

    flush(): Promise<void> {
      return chain;
    },

    getTailCache(): AuditChainTail | null {
      return tailCache.hash === null ? null : tailCache;
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// Production singleton (lazy: never touches the DB at import time)
// ═══════════════════════════════════════════════════════════════

const singleton = createAuditLogger(() => adaptAuditDb(getDb()));

/**
 * Write an audit event to the append-only ledger (fire-and-forget).
 * Never blocks the caller; failures are logged and swallowed to avoid leaking
 * DB errors to the user surface.
 */
export function writeAuditEvent(params: WriteAuditEventParams): void {
  singleton.writeAuditEvent(params);
}

export function auditChangedFields(
  fields: Record<string, unknown>
): string[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}
