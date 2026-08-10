/**
 * P14 hardening: audit chain integrity verification and health stats.
 *
 * Rows written before the hash-chain feature shipped have hash/prev_hash NULL
 * (auto-migrate adds the columns; the writer only starts chaining afterwards).
 * They are counted as `legacyRows` and skipped — the chain deliberately starts
 * fresh at the first post-migration row (its prevHash is NULL). This is a
 * documented boundary: legacy rows are outside the chain, everything after
 * the migration point is covered.
 */
import { computeAuditHash } from "./audit-log";
import type { AuditDb } from "./audit-log";

export interface AuditIntegrityBrokenRow {
  id: number;
  expected: string;
  actual: string;
}

export interface AuditIntegrityReport {
  /** Rows carrying a hash (participate in the chain). */
  total: number;
  /** Rows whose recomputed hash matches the stored one. */
  verified: number;
  /** Rows whose stored hash does not match the canonical recomputation. */
  broken: AuditIntegrityBrokenRow[];
  /** Id of the first chained row (the chain root); null when nothing is chained. */
  chainStartId: number | null;
  /** Rows with hash NULL (pre-chain). Skipped, deliberately outside the chain. */
  legacyRows: number;
}

export interface AuditStats {
  totalRows: number;
  chainedRows: number;
  legacyRows: number;
  lastHash: string | null;
}

/**
 * Walk the ledger in ascending id order and verify every chained row:
 * recompute sha256 over the stored fields + the row's stored prevHash and
 * compare to the stored hash. Tampering with any covered field, with prevHash,
 * or with the hash itself surfaces at that row (or, for a prevHash flip, the
 * next row).
 */
export async function verifyAuditIntegrity(db: AuditDb): Promise<AuditIntegrityReport> {
  const rows = await db.selectAllRows();
  const broken: AuditIntegrityBrokenRow[] = [];
  let verified = 0;
  let legacyRows = 0;
  let chainStartId: number | null = null;

  for (const row of rows) {
    if (row.hash === null) {
      legacyRows += 1;
      continue;
    }
    if (chainStartId === null) chainStartId = row.id;
    const expected = computeAuditHash(row.prevHash, {
      event: row.event,
      actorUserId: row.actorUserId,
      entityType: row.entityType,
      entityId: row.entityId ?? null,
      metadataJson: row.metadata,
      createdAt: row.createdAt,
    });
    if (expected === row.hash) {
      verified += 1;
    } else {
      broken.push({ id: row.id, expected, actual: row.hash });
    }
  }

  return { total: verified + broken.length, verified, broken, chainStartId, legacyRows };
}

/** Cheap health-check summary over the ledger. */
export async function auditStats(db: AuditDb): Promise<AuditStats> {
  const rows = await db.selectAllRows();
  let chainedRows = 0;
  let lastHash: string | null = null;
  for (const row of rows) {
    if (row.hash !== null) {
      chainedRows += 1;
      lastHash = row.hash;
    }
  }
  return {
    totalRows: rows.length,
    chainedRows,
    legacyRows: rows.length - chainedRows,
    lastHash,
  };
}
