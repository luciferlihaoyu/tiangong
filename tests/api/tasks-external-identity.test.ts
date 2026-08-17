import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { taskMessages, tasks } from "@db/schema";

const shared = vi.hoisted(() => ({ db: null as unknown as import("./helpers/fake-db").FakeDb }));

vi.mock("../../api/queries/connection", async () => {
  const mod = await import("./helpers/fake-db");
  mod.fakeDbRegistry.instance = mod.createFakeDb();
  shared.db = mod.fakeDbRegistry.instance;
  return { getDb: () => mod.fakeDbRegistry.instance };
});

import { beidouExternalRouter, type BeidouExternalCreateInput } from "../../api/beidou-external-router";
import { issueServiceKey, type IssuedKey } from "../../api/lib/beidou-service-keys";
import { canonicalRequestHash } from "../../api/lib/canonical-request-hash";
import { createCallerFactory, createContext } from "../../api/middleware";

const createCaller = createCallerFactory(beidouExternalRouter);
process.env.TIANGONG_SERVICE_KEY_PEPPER = "task21-external-identity-test-pepper";

const request: BeidouExternalCreateInput = {
  external_ref: "beidou:research:task-21",
  idempotency_key: "task-21-key",
  operation: "create",
  target: "organize research",
  params_snapshot: { folders: ["资料", "人物"], mode: "safe" },
  origin_system: "beidou",
};

async function callerFor(key: IssuedKey) {
  const ctx = await createContext({
    req: new Request("http://localhost/api/trpc", {
      headers: {
        authorization: `Bearer ${key.token}`,
        "x-tg-service-key-id": key.keyId,
      },
    }),
  });
  return createCaller(ctx);
}

async function fullAccessCaller(workspaceSlug = "beidou-ws") {
  return callerFor(await issueServiceKey({
    workspaceSlug,
    projectSlug: "research",
    scopes: ["research-task:create", "research-task:read", "research-task:cancel"],
  }));
}

describe("external task identity schema", () => {
  it("defines nullable external identity, revision, retention, and both unique origin constraints", () => {
    const config = getTableConfig(tasks);
    const columns = new Map(config.columns.map((column) => [column.name, column]));

    for (const name of [
      "origin_system",
      "external_ref",
      "idempotency_key",
      "canonical_request_hash",
      "canonical_request_hash_version",
      "state_revision",
      "task_retain_until",
      "idempotency_retain_until",
    ]) {
      expect(columns.has(name), `missing tasks.${name}`).toBe(true);
    }
    expect(columns.get("origin_system")?.notNull).toBe(false);
    expect(columns.get("external_ref")?.notNull).toBe(false);
    expect(columns.get("idempotency_key")?.notNull).toBe(false);

    const uniqueColumns = config.indexes
      .filter((index) => index.config.unique)
      .map((index) => index.config.columns.map((column) => "name" in column ? column.name : "").join(","));
    expect(uniqueColumns).toContain("origin_system,external_ref");
    expect(uniqueColumns).toContain("origin_system,idempotency_key");
  });

  it("adds external identity columns and indexes to fresh and existing-table migrations", () => {
    const migration = readFileSync(new URL("../../api/lib/auto-migrate.ts", import.meta.url), "utf8");
    for (const name of [
      "origin_system",
      "external_ref",
      "idempotency_key",
      "canonical_request_hash",
      "canonical_request_hash_version",
      "state_revision",
      "task_retain_until",
      "idempotency_retain_until",
      "uq_tasks_origin_external_ref",
      "uq_tasks_origin_idempotency_key",
    ]) {
      expect(migration).toContain(name);
    }
  });
});

describe("idempotent external task creation and revision", () => {
  beforeEach(() => shared.db.reset());
  afterEach(() => vi.clearAllMocks());

  it("creates exactly one TG task for parallel identical requests without duplicate dispatch", async () => {
    const caller = await fullAccessCaller();

    const results = await Promise.all(Array.from({ length: 12 }, () => caller.create(request)));

    expect(new Set(results.map((result) => result.task.taskId)).size).toBe(1);
    expect(shared.db.rowsOfTable(tasks)).toHaveLength(1);
    expect(shared.db.rowsOfTable(taskMessages)).toHaveLength(0);
    expect(results.filter((result) => result.duplicate === false)).toHaveLength(1);
  });

  it("records the canonical hash version and retention beyond task retention", async () => {
    const caller = await fullAccessCaller();
    const created = await caller.create(request);
    const row = shared.db.rowsOfTable(tasks)[0];

    expect(row.originSystem).toBe("beidou");
    expect(row.externalRef).toBe(request.external_ref);
    expect(row.idempotencyKey).toBe(request.idempotency_key);
    expect(row.canonicalRequestHashVersion).toBe("rfc8785-jcs-v1");
    expect(row.canonicalRequestHash).toBe(created.canonicalRequestHash);
    expect(row.canonicalRequestHash).toBe(canonicalRequestHash({
      originSystem: "beidou",
      external_ref: request.external_ref,
      idempotency_key: request.idempotency_key,
      operation: request.operation,
      target: request.target,
      params_snapshot: request.params_snapshot,
    }));
    expect(row.stateRevision).toBe(1);
    expect(row.taskRetainUntil).toBeInstanceOf(Date);
    expect(row.idempotencyRetainUntil).toBeInstanceOf(Date);
    expect(Number(row.idempotencyRetainUntil)).toBeGreaterThanOrEqual(Number(row.taskRetainUntil));
  });

  it("returns the same TG id for same key and hash, and conflicts for either reused identity with changed body", async () => {
    const caller = await fullAccessCaller();
    const first = await caller.create(request);
    const replay = await caller.create(request);

    expect(replay.task.taskId).toBe(first.task.taskId);
    await expect(caller.create({ ...request, target: "changed" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.create({ ...request, external_ref: "another-ref", target: "changed" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(caller.create({ ...request, idempotency_key: "another-key", target: "changed" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(shared.db.rowsOfTable(tasks)).toHaveLength(1);
  });

  it("scopes get-by-reference and returns canonical revisioned facts", async () => {
    const owner = await fullAccessCaller("beidou-ws");
    const other = await fullAccessCaller("other-ws");
    const created = await owner.create(request);

    const found = await owner.getByReference(request);
    expect(found).toMatchObject({
      taskId: created.task.taskId,
      duplicate: true,
      originSystem: "beidou",
      stateRevision: 1,
    });
    await expect(other.getByReference(request)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("increments state revision monotonically and rejects a stale revision write", async () => {
    const caller = await fullAccessCaller();
    await caller.create(request);

    const cancelled = await caller.cancel({ external_ref: request.external_ref, expected_state_revision: 1 });
    expect(cancelled.task.stateRevision).toBe(2);
    await expect(
      caller.cancel({ external_ref: request.external_ref, expected_state_revision: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(shared.db.rowsOfTable(tasks)[0].stateRevision).toBe(2);
  });

  it("keeps historical tasks valid with null external identity", async () => {
    await shared.db.insert(tasks).values({ taskId: "TG-HISTORY", name: "historical" });
    const row = shared.db.rowsOfTable(tasks)[0];

    expect(row.originSystem ?? null).toBeNull();
    expect(row.externalRef ?? null).toBeNull();
    expect(row.idempotencyKey ?? null).toBeNull();
  });
});
