import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { createCallerFactory } from "../../api/middleware";
import { eventsRouter } from "../../api/events-router";

type Row = Readonly<Record<string, unknown>>;
type SourceKey = "audit" | "task" | "usage";

// ─── Mock db: queued per-source rows, captured where conditions ───
const streamMocks = vi.hoisted(() => {
  const queues: Record<SourceKey, Row[]> = { audit: [], task: [], usage: [] };
  const whereConds: SQL[] = [];
  let fromCalls = 0;

  const sourceOf = (table: unknown): SourceKey => {
    // Drizzle tables carry their SQL name under the drizzle:Name symbol.
    const name =
      typeof table === "object" && table !== null
        ? String((table as Record<PropertyKey, unknown>)[Symbol.for("drizzle:Name")])
        : "";
    if (name === "audit_events") return "audit";
    if (name === "task_messages") return "task";
    return "usage";
  };

  const chained = (key: SourceKey) => ({
    where: (cond?: SQL) => {
      if (cond) whereConds.push(cond);
      return chained(key);
    },
    orderBy: () => chained(key),
    limit: () => Promise.resolve(queues[key].splice(0, 100)),
  });

  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        fromCalls += 1;
        return chained(sourceOf(table));
      }),
    })),
  };

  return {
    db,
    queue: (key: SourceKey, rows: Row[]) => {
      queues[key] = rows;
    },
    whereConditions: () => whereConds,
    fromCalls: () => fromCalls,
    reset: () => {
      queues.audit = [];
      queues.task = [];
      queues.usage = [];
      whereConds.length = 0;
      fromCalls = 0;
    },
  };
});

vi.mock("../../api/queries/connection", () => ({ getDb: () => streamMocks.db }));

const adminCtx = {
  req: new Request("http://localhost"),
  user: { id: 1, role: "admin" },
  apiKeyAgentId: -1,
};

function callerFor(overrides: Readonly<Record<string, unknown>> = {}) {
  return createCallerFactory(eventsRouter)({ ...adminCtx, ...overrides });
}

function render(cond: SQL): string {
  return new MySqlDialect().sqlToQuery(cond).sql;
}

// ─── Fixtures (shapes mirroring the three source tables) ───
const T0 = new Date("2026-08-10T10:00:00.000Z");
const T1 = new Date("2026-08-10T11:00:00.000Z");
const T2 = new Date("2026-08-10T12:00:00.000Z");
const T3 = new Date("2026-08-10T13:00:00.000Z");
const T4 = new Date("2026-08-10T14:00:00.000Z");

function auditRow(overrides: Partial<Row> = {}): Row {
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
    prevHash: null,
    hash: null,
    createdAt: T0,
    ...overrides,
  };
}

function taskRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    taskId: 5,
    threadId: null,
    fromAgentId: 2,
    toAgentId: 3,
    eventType: "dispatch",
    content: null,
    metadata: null,
    createdAt: T0,
    ...overrides,
  };
}

function usageRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    model: "gpt-4o",
    provider: "openai",
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    costCents: 12,
    taskId: 5,
    agentId: null,
    sessionKey: null,
    source: "manual",
    traceId: null,
    startedAt: null,
    highCostModel: "false",
    createdAt: T0,
    ...overrides,
  };
}

describe("events.unifiedList", () => {
  beforeEach(() => {
    streamMocks.reset();
  });

  it("merges all three sources into one time-descending feed", async () => {
    // Given: one row per source at distinct times
    streamMocks.queue("audit", [auditRow({ id: 1, createdAt: T0 })]);
    streamMocks.queue("task", [taskRow({ id: 2, createdAt: T2 })]);
    streamMocks.queue("usage", [usageRow({ id: 3, createdAt: T1 })]);

    // When
    const result = await callerFor().unifiedList({ limit: 10 });

    // Then: sorted newest first with normalized shapes
    expect(result.items.map((i) => i.id)).toEqual(["task:2", "usage:3", "audit:1"]);
    expect(result.items[0]).toMatchObject({
      kind: "task",
      summary: "dispatch",
      entityId: 5,
      metadata: { contentPreview: null, fromAgentId: 2, toAgentId: 3 },
    });
    expect(result.items[1]).toMatchObject({
      kind: "usage",
      summary: "gpt-4o 150t $0.1200",
      metadata: { provider: "openai", model: "gpt-4o", totalTokens: 150, costCents: 12 },
    });
    expect(result.items[2]).toMatchObject({
      kind: "audit",
      summary: "workspace:created",
      entityType: "workspace",
      actor: { userId: 1 },
    });
    expect(result.nextCursor).toBeNull();
  });

  it("tie-breaks equal timestamps by kind rank then id desc", async () => {
    // Given: all rows share one timestamp
    streamMocks.queue("audit", [auditRow({ id: 5, createdAt: T1 }), auditRow({ id: 10, createdAt: T1 })]);
    streamMocks.queue("task", [taskRow({ id: 1, createdAt: T1 })]);
    streamMocks.queue("usage", [usageRow({ id: 1, createdAt: T1 })]);

    // When
    const result = await callerFor().unifiedList({ limit: 10 });

    // Then: audit (rank 0) before task (rank 1) before usage (rank 2);
    // within a kind, higher id first
    expect(result.items.map((i) => i.id)).toEqual(["audit:10", "audit:5", "task:1", "usage:1"]);
  });

  it("previews task content at most 120 chars", async () => {
    // Given: a long message body
    streamMocks.queue("audit", []);
    streamMocks.queue("task", [taskRow({ id: 1, content: "x".repeat(500), createdAt: T1 })]);
    streamMocks.queue("usage", []);

    // When
    const result = await callerFor().unifiedList({ limit: 10 });

    // Then
    const item = result.items.find((i) => i.kind === "task");
    if (!item || item.kind !== "task") throw new Error("expected a task item");
    expect(item.metadata.contentPreview).toHaveLength(120);
    expect(item.metadata.contentPreview).toBe("x".repeat(120));
  });

  it("filters by kind and only queries that source", async () => {
    // Given
    streamMocks.queue("task", [taskRow({ id: 7, createdAt: T2 })]);

    // When
    const result = await callerFor().unifiedList({ limit: 10, kind: "task" });

    // Then: exactly one source queried, only task items returned
    expect(streamMocks.fromCalls()).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ kind: "task", id: "task:7" });
  });

  it("applies the time window server-side", async () => {
    // Given
    streamMocks.queue("audit", []);
    streamMocks.queue("task", []);
    streamMocks.queue("usage", []);

    // When
    await callerFor().unifiedList({
      limit: 10,
      from: "2026-08-10T09:00:00.000Z",
      to: "2026-08-10T18:00:00.000Z",
    });

    // Then: every source query carried created_at >= ? AND created_at <= ?
    const conds = streamMocks.whereConditions();
    expect(conds).toHaveLength(3);
    for (const cond of conds) {
      const sql = render(cond);
      expect(sql).toContain("`created_at` >= ?");
      expect(sql).toContain("`created_at` <= ?");
    }
  });

  it("filters by entityId against the right column per source", async () => {
    // Given
    streamMocks.queue("audit", []);
    streamMocks.queue("task", []);
    streamMocks.queue("usage", []);

    // When
    await callerFor().unifiedList({ limit: 10, entityId: 42 });

    // Then: audit filters on entity_id; task and usage on task_id
    const [auditSql, taskSql, usageSql] = streamMocks.whereConditions().map(render);
    expect(auditSql).toContain("`entity_id` = ?");
    expect(auditSql).not.toContain("task_id");
    expect(taskSql).toContain("`task_id` = ?");
    expect(usageSql).toContain("`task_id` = ?");
  });

  it("builds the keyset cursor condition per source rank", async () => {
    // Given: cursor at (ts=T2, rank=1 task, id=5)
    const cursor = Buffer.from(
      JSON.stringify({ ts: T2.toISOString(), rank: 1, id: 5 })
    ).toString("base64url");
    streamMocks.queue("audit", []);
    streamMocks.queue("task", []);
    streamMocks.queue("usage", []);

    // When
    await callerFor().unifiedList({ limit: 10, cursor });

    // Then:
    //  audit (rank 0 < 1)  → created_at < ts
    //  task  (rank 1 = 1)  → created_at < ts OR (created_at = ts AND id < 5)
    //  usage (rank 2 > 1)  → created_at <= ts
    const [auditSql, taskSql, usageSql] = streamMocks.whereConditions().map(render);
    expect(auditSql).toContain("`created_at` < ?");
    expect(auditSql).not.toContain(" or ");
    expect(taskSql).toContain("`created_at` < ?");
    expect(taskSql).toContain("`created_at` = ?");
    expect(taskSql).toContain("`id` < ?");
    expect(taskSql).toContain(" or ");
    expect(usageSql).toContain("`created_at` <= ?");
  });

  it("paginates with a cursor without repeating first-page rows", async () => {
    // Given: 5 rows across sources; page size 2
    streamMocks.queue("audit", [auditRow({ id: 3, createdAt: T3 })]);
    streamMocks.queue("task", [taskRow({ id: 2, createdAt: T1 })]);
    streamMocks.queue("usage", [usageRow({ id: 1, createdAt: T4 })]);

    // When: page 1
    const page1 = await callerFor().unifiedList({ limit: 2 });

    // Then: newest two rows; cursor present
    expect(page1.items.map((i) => i.id)).toEqual(["usage:1", "audit:3"]);
    const cursor = page1.nextCursor;
    if (cursor === null) throw new Error("expected a nextCursor on a full page");

    // When: page 2 — the mock emulates the DB-side cursor filter by returning
    // only the rows that remain after (T3, audit rank 0, id 3)
    streamMocks.queue("audit", []);
    streamMocks.queue("task", [taskRow({ id: 2, createdAt: T1 })]);
    streamMocks.queue("usage", []);
    const page2 = await callerFor().unifiedList({ limit: 2, cursor });

    // Then: strictly new rows, ordered, and the stream is exhausted
    expect(page2.items.map((i) => i.id)).toEqual(["task:2"]);
    expect(page2.items.every((i) => !page1.items.some((p) => p.id === i.id))).toBe(true);
    expect(page2.nextCursor).toBeNull();
  });

  it("rejects non-admin callers", async () => {
    // Given: a plain workspace user
    const caller = callerFor({ user: { id: 2, role: "user" } });

    // When / Then
    await expect(caller.unifiedList({ limit: 10 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects out-of-range limit and malformed cursors", async () => {
    const caller = callerFor();
    await expect(caller.unifiedList({ limit: 101 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    // base64url of "{}" — decodes fine but fails the cursor schema
    await expect(caller.unifiedList({ limit: 10, cursor: Buffer.from("{}").toString("base64url") })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
