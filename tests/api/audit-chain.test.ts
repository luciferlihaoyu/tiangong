import { describe, expect, it, beforeEach } from "vitest";
import type { AuditEvent, InsertAuditEvent } from "../../db/schema";
import {
  computeAuditHash,
  createAuditLogger,
} from "../../api/lib/audit-log";
import type { AuditDb } from "../../api/lib/audit-log";
import type { WriteAuditEventParams } from "../../api/lib/audit-log";
import { auditStats, verifyAuditIntegrity } from "../../api/lib/audit-integrity";

// ─── Mock AuditDb: queued tail reads + captured inserts ───
type TailRow = { id: number; hash: string | null };

function makeMockDb() {
  const state = {
    tailQueue: [] as ReadonlyArray<ReadonlyArray<TailRow>>,
    allRows: [] as AuditEvent[],
    inserts: [] as InsertAuditEvent[],
    tailReads: 0,
    insertFailures: 0,
  };
  const db: AuditDb = {
    selectTail: async () => {
      state.tailReads += 1;
      const next = state.tailQueue[0] ?? [];
      state.tailQueue = state.tailQueue.slice(1);
      return next;
    },
    selectAllRows: async () => state.allRows,
    insertRow: async (row) => {
      if (state.insertFailures > 0) {
        state.insertFailures -= 1;
        throw new Error("insert failed");
      }
      state.inserts.push({ ...row });
      return { insertId: state.inserts.length };
    },
  };
  return { db, state };
}

const TS = new Date("2026-08-10T10:00:00.000Z");

function params(overrides: Partial<WriteAuditEventParams> = {}): WriteAuditEventParams {
  return {
    event: "workspace:created",
    actorUserId: 1,
    workspaceId: 7,
    entityType: "workspace",
    entityId: 7,
    metadata: { name: "w" },
    ...overrides,
  };
}

function auditRow(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 1,
    event: "workspace:created",
    actorUserId: 1,
    workspaceId: null,
    projectId: null,
    targetUserId: null,
    entityType: "workspace",
    entityId: null,
    metadata: null,
    createdAt: TS,
    prevHash: null,
    hash: null,
    ...overrides,
  };
}

describe("audit hash chain — single-flight writer", () => {
  it("writes a chain-root row (prevHash null) with a recomputable hash", async () => {
    // Given: empty ledger (no tail)
    const { db, state } = makeMockDb();
    state.tailQueue = [[]];
    const logger = createAuditLogger(() => db);

    // When: one fire-and-forget write, then queue drain
    logger.writeAuditEvent(params());
    await logger.flush();

    // Then: exactly one chained insert; hash recomputes from stored fields
    expect(state.inserts).toHaveLength(1);
    const row = state.inserts[0];
    expect(row.prevHash).toBeNull();
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.entityId).toBe(7);
    expect(row.metadata).toBe('{"name":"w"}');
    expect(row.hash).toBe(
      computeAuditHash(row.prevHash, {
        event: row.event ?? "",
        actorUserId: row.actorUserId ?? 0,
        entityType: row.entityType ?? "",
        entityId: row.entityId ?? null,
        metadataJson: row.metadata ?? null,
        createdAt: row.createdAt ?? TS,
      })
    );
    // createdAt is floored to whole seconds so the hashed string survives
    // MySQL TIMESTAMP storage without rounding drift.
    expect(row.createdAt?.getMilliseconds()).toBe(0);
    // Tail cache refreshed.
    expect(logger.getTailCache()?.hash).toBe(row.hash);
  });

  it("links the first write onto a legacy tail row read from the DB", async () => {
    // Given: ledger whose latest row predates the chain (hash NULL) — the
    // writer must re-read the tail on a cold cache and start a fresh chain.
    const legacyHash = "f".repeat(64);
    const { db, state } = makeMockDb();
    state.tailQueue = [[{ id: 42, hash: legacyHash }]];
    const logger = createAuditLogger(() => db);

    // When
    logger.writeAuditEvent(params());
    await logger.flush();

    // Then: new row links onto the legacy tail (prevHash = tail hash)
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].prevHash).toBe(legacyHash);
  });

  it("serializes concurrent writes into a contiguous chain", async () => {
    // Given: cold cache; the tail is read exactly once (second write is
    // served from the in-memory cache because the queue is serialized).
    const { db, state } = makeMockDb();
    state.tailQueue = [[]];
    const logger = createAuditLogger(() => db);

    // When: two fire-and-forget writes issued back-to-back
    logger.writeAuditEvent(params({ event: "project:created", entityType: "project", entityId: 9 }));
    logger.writeAuditEvent(params({ event: "membership:added", entityType: "membership", entityId: 3 }));
    await logger.flush();

    // Then: second row's prevHash equals first row's hash; hashes recompute
    expect(state.inserts).toHaveLength(2);
    const [first, second] = state.inserts;
    expect(second.prevHash).toBe(first.hash);
    expect(state.tailReads).toBe(1);
    expect(second.hash).toBe(
      computeAuditHash(first.hash, {
        event: second.event ?? "",
        actorUserId: second.actorUserId ?? 0,
        entityType: second.entityType ?? "",
        entityId: second.entityId ?? null,
        metadataJson: second.metadata ?? null,
        createdAt: second.createdAt ?? TS,
      })
    );
  });

  it("survives a failed insert without stalling the queue", async () => {
    // Given: first write fails at INSERT (cache stays cold); second write
    // must re-read the tail and still chain correctly.
    const legacyHash = "a".repeat(64);
    const { db, state } = makeMockDb();
    state.insertFailures = 1;
    state.tailQueue = [[], [{ id: 9, hash: legacyHash }]];
    const logger = createAuditLogger(() => db);

    // When
    logger.writeAuditEvent(params());
    logger.writeAuditEvent(params({ event: "project:created", entityType: "project", entityId: 9 }));
    await logger.flush();

    // Then: only the second write landed, linked onto the legacy tail
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].prevHash).toBe(legacyHash);
    expect(logger.getTailCache()?.hash).toBe(state.inserts[0].hash);
  });
});

describe("audit hash chain — verifyAuditIntegrity", () => {
  it("verifies an intact chain", async () => {
    // Given: two chained rows with correct hashes
    const ts2 = new Date("2026-08-10T10:00:01.000Z");
    const h1 = computeAuditHash(null, { event: "workspace:created", actorUserId: 1, entityType: "workspace", entityId: 7, metadataJson: null, createdAt: TS });
    const h2 = computeAuditHash(h1, { event: "project:created", actorUserId: 1, entityType: "project", entityId: 9, metadataJson: null, createdAt: ts2 });
    const { db, state } = makeMockDb();
    state.allRows = [
      auditRow({ id: 1, entityId: 7, createdAt: TS, hash: h1 }),
      auditRow({ id: 2, event: "project:created", entityType: "project", entityId: 9, createdAt: ts2, prevHash: h1, hash: h2 }),
    ];

    // When
    const report = await verifyAuditIntegrity(db);

    // Then
    expect(report).toEqual({
      total: 2,
      verified: 2,
      broken: [],
      chainStartId: 1,
      legacyRows: 0,
    });
  });

  it("flags a tampered row at exactly that row", async () => {
    // Given: 3-row chain, row 2's metadata flipped after the fact
    const ts2 = new Date("2026-08-10T10:00:01.000Z");
    const ts3 = new Date("2026-08-10T10:00:02.000Z");
    const h1 = computeAuditHash(null, { event: "workspace:created", actorUserId: 1, entityType: "workspace", entityId: 7, metadataJson: '{"name":"w"}', createdAt: TS });
    const h2 = computeAuditHash(h1, { event: "project:created", actorUserId: 1, entityType: "project", entityId: 9, metadataJson: '{"name":"p"}', createdAt: ts2 });
    const h3 = computeAuditHash(h2, { event: "membership:added", actorUserId: 1, entityType: "membership", entityId: 3, metadataJson: null, createdAt: ts3 });
    const { db, state } = makeMockDb();
    state.allRows = [
      auditRow({ id: 1, entityId: 7, metadata: '{"name":"w"}', createdAt: TS, hash: h1 }),
      auditRow({
        id: 2,
        event: "project:created",
        entityType: "project",
        entityId: 9,
        metadata: '{"name":"TAMPERED"}',
        createdAt: ts2,
        prevHash: h1,
        hash: h2,
      }),
      auditRow({ id: 3, event: "membership:added", entityType: "membership", entityId: 3, createdAt: ts3, prevHash: h2, hash: h3 }),
    ];

    // When
    const report = await verifyAuditIntegrity(db);

    // Then: row 2 is broken with expected = recomputation over tampered data
    expect(report.broken).toHaveLength(1);
    expect(report.broken[0]).toEqual({
      id: 2,
      expected: computeAuditHash(h1, { event: "project:created", actorUserId: 1, entityType: "project", entityId: 9, metadataJson: '{"name":"TAMPERED"}', createdAt: ts2 }),
      actual: h2,
    });
    expect(report.verified).toBe(2);
    expect(report.total).toBe(3);
    expect(report.chainStartId).toBe(1);
    expect(report.legacyRows).toBe(0);
  });

  it("skips legacy rows and reports them as a count", async () => {
    // Given: two pre-chain rows (hash NULL) then a fresh chain of two
    const ts3 = new Date("2026-08-10T10:00:03.000Z");
    const ts4 = new Date("2026-08-10T10:00:04.000Z");
    const h3 = computeAuditHash(null, { event: "workspace:deleted", actorUserId: 1, entityType: "workspace", entityId: 5, metadataJson: null, createdAt: ts3 });
    const h4 = computeAuditHash(h3, { event: "connector:created", actorUserId: 1, entityType: "connector", entityId: 2, metadataJson: null, createdAt: ts4 });
    const { db, state } = makeMockDb();
    state.allRows = [
      auditRow({ id: 1 }),
      auditRow({ id: 2 }),
      auditRow({ id: 3, event: "workspace:deleted", entityId: 5, createdAt: ts3, hash: h3 }),
      auditRow({ id: 4, event: "connector:created", entityType: "connector", entityId: 2, createdAt: ts4, prevHash: h3, hash: h4 }),
    ];

    // When
    const report = await verifyAuditIntegrity(db);

    // Then: chain starts at the first chained row; legacy rows counted, not verified
    expect(report.legacyRows).toBe(2);
    expect(report.total).toBe(2);
    expect(report.verified).toBe(2);
    expect(report.broken).toEqual([]);
    expect(report.chainStartId).toBe(3);
  });
});

describe("audit hash chain — auditStats", () => {
  it("reports totals, chain coverage and the last hash", async () => {
    // Given: 1 legacy + 2 chained rows
    const h1 = computeAuditHash(null, { event: "workspace:created", actorUserId: 1, entityType: "workspace", entityId: 7, metadataJson: null, createdAt: TS });
    const h2 = computeAuditHash(h1, { event: "project:created", actorUserId: 1, entityType: "project", entityId: 9, metadataJson: null, createdAt: TS });
    const { db, state } = makeMockDb();
    state.allRows = [
      auditRow({ id: 1 }),
      auditRow({ id: 2, hash: h1 }),
      auditRow({ id: 3, event: "project:created", entityType: "project", entityId: 9, prevHash: h1, hash: h2 }),
    ];

    // When
    const stats = await auditStats(db);

    // Then
    expect(stats).toEqual({ totalRows: 3, chainedRows: 2, legacyRows: 1, lastHash: h2 });
  });
});
