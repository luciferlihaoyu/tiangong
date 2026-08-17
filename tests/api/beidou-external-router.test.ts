/**
 * Todo 20 (Beidou plan): scoped Beidou service-principal router.
 *
 * Covers: least-privilege scope allowlist per operation; workspace/project
 * binding; cross-service denial (agent MCP keys / human sessions cannot use
 * the external router); canonical request-hash idempotency (same external_ref
 * + same canonical hash → same TG id; changed payload → 409); get-by-reference;
 * scoped cancel; scoped artifact-stream; no weak unbound task mutations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tasks, tiangongServiceKeys } from "@db/schema";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";

const shared = vi.hoisted(() => ({ db: null as unknown as import("./helpers/fake-db").FakeDb }));

vi.mock("../../api/queries/connection", async () => {
  const mod = await import("./helpers/fake-db");
  mod.fakeDbRegistry.instance = mod.createFakeDb();
  shared.db = mod.fakeDbRegistry.instance;
  return { getDb: () => mod.fakeDbRegistry.instance };
});

import {
  beidouExternalRouter,
  type BeidouExternalCreateInput,
} from "../../api/beidou-external-router";
import { createCallerFactory, createContext } from "../../api/middleware";
import { issueServiceKey, type IssuedKey } from "../../api/lib/beidou-service-keys";
import { canonicalRequestHash } from "../../api/lib/canonical-request-hash";

const createCaller = createCallerFactory(beidouExternalRouter);
process.env.TIANGONG_SERVICE_KEY_PEPPER = "task20-router-test-pepper";

async function callerFor(issued: IssuedKey) {
  const ctx = await createContext({
    req: new Request("http://localhost/api/trpc", {
      headers: {
        authorization: `Bearer ${issued.token}`,
        "x-tg-service-key-id": issued.keyId,
      },
    }),
  });
  return createCaller(ctx);
}

const baseCreate: BeidouExternalCreateInput = {
  external_ref: "beidou:research:job-001",
  idempotency_key: "idem-001",
  operation: "create",
  target: "research task one",
  params_snapshot: { query: "New API MCP 接入", limit: 8, filters: { project: "private-agent-terminal" } },
  origin_system: "beidou",
};

describe("beidou external router scoping", () => {
  beforeEach(() => {
    shared.db.reset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exposes only the least-privilege external operations (no weak unbound mutations)", () => {
    const procedures = Object.keys(beidouExternalRouter).filter(
      (k) => k !== "_def" && k !== "createCaller",
    );
    expect(procedures.sort()).toEqual(
      ["artifactStream", "cancel", "create", "get", "getByReference"].sort(),
    );
    const record = JSON.stringify(procedures);
    for (const banned of ["updateProgress", "approve", "reject", "delete", "submitForReview", "dispatch", "promote"]) {
      expect(record).not.toContain(banned);
    }
  });

  it("creates an external task bound to the key's workspace/project with correct headers", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read", "research-task:cancel", "research-task:artifact-stream"],
    });
    const caller = await callerFor(issued);
    const res = await caller.create(baseCreate);
    expect(res.success).toBe(true);
    expect(res.task.taskId).toMatch(/^TG-/);
    expect(res.task.id).toBeGreaterThan(0);
    expect(res.canonicalRequestHash).toHaveLength(64);
    expect(res.originSystem).toBe("beidou");
    expect(JSON.stringify(res)).not.toContain(issued.token);

    const row = shared.db.rowsOfTable(tasks)[0];
    const input = JSON.parse(String(row.input));
    expect(input.external).toMatchObject({
      originSystem: "beidou",
      externalRef: baseCreate.external_ref,
      idempotencyKey: baseCreate.idempotency_key,
      operation: "create",
      target: baseCreate.target,
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
    });
    expect(input.external.canonicalRequestHash).toBe(
      canonicalRequestHash({
        originSystem: "beidou",
        external_ref: baseCreate.external_ref,
        idempotency_key: baseCreate.idempotency_key,
        operation: baseCreate.operation,
        target: baseCreate.target,
        params_snapshot: baseCreate.params_snapshot,
      }),
    );
    expect(input.metadata.origin.system).toBe("beidou");
  });

  it("rejects calls without a valid service principal (agent keys / human sessions / anonymous)", async () => {
    // Anonymous
    const anonCtx = await createContext({ req: new Request("http://localhost/api/trpc") });
    const anonCaller = createCaller(anonCtx);
    await expect(anonCaller.create(baseCreate)).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // Human JWT session (verifyToken mocked to null in setup → still unauthorized)
    const humanCtx = await createContext({
      req: new Request("http://localhost/api/trpc", {
        headers: { authorization: "Bearer human.session.jwt" },
      }),
    });
    const humanCaller = createCaller(humanCtx);
    await expect(humanCaller.create(baseCreate)).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // Agent MCP key style header
    const agentCtx = await createContext({
      req: new Request("http://localhost/api/trpc", {
        headers: { "x-api-key": "tg-agent-key" },
      }),
    });
    const agentCaller = createCaller(agentCtx);
    await expect(agentCaller.create(baseCreate)).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    // Wrong token with a real key id
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    const badCtx = await createContext({
      req: new Request("http://localhost/api/trpc", {
        headers: {
          authorization: `Bearer WRONGTOKEN${"x".repeat(34)}`,
          "x-tg-service-key-id": issued.keyId,
        },
      }),
    });
    const badCaller = createCaller(badCtx);
    await expect(badCaller.create(baseCreate)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("enforces the least-privilege scope allowlist per operation", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:read"], // no create scope
    });
    const caller = await callerFor(issued);
    await expect(caller.create(baseCreate)).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("research-task:create"),
    });
    // cancel without cancel scope
    await expect(caller.cancel({ external_ref: baseCreate.external_ref })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // artifact-stream without artifact-stream scope
    await expect(caller.artifactStream({ external_ref: baseCreate.external_ref })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("binds callers to their allowed workspace/project", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read", "research-task:cancel"],
    });
    const caller = await callerFor(issued);
    await expect(
      caller.create({ ...baseCreate, workspace_slug: "other-ws" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.create({ ...baseCreate, project_slug: "other-project" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // A second principal bound to another workspace cannot read the first one's task.
    const other = await issueServiceKey({
      workspaceSlug: "other-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read"],
    });
    await caller.create(baseCreate);
    const otherCaller = await callerFor(other);
    await expect(otherCaller.get({ external_ref: baseCreate.external_ref })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(otherCaller.cancel({ external_ref: baseCreate.external_ref })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rejects a wrong originSystem claim (403)", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    const caller = await callerFor(issued);
    await expect(
      caller.create({ ...baseCreate, origin_system: "xuanji" as never }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("beidou") });
  });

  it("returns the same TG id for duplicate creates with the same canonical hash and 409 for changed payloads", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read"],
    });
    const caller = await callerFor(issued);
    const first = await caller.create(baseCreate);
    const dup = await caller.create(baseCreate);
    expect(dup.task.taskId).toBe(first.task.taskId);
    expect(dup.duplicate).toBe(true);
    expect(shared.db.rowsOfTable(tasks)).toHaveLength(1);

    // Same key, changed params_snapshot → different canonical hash → 409.
    await expect(
      caller.create({ ...baseCreate, params_snapshot: { query: "changed" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(shared.db.rowsOfTable(tasks)).toHaveLength(1);
  });

  it("get and getByReference return the task facts without credentials", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:read"],
    });
    const caller = await callerFor(issued);
    const created = await caller.create(baseCreate);

    const got = await caller.get({ external_ref: baseCreate.external_ref });
    expect(got.taskId).toBe(created.task.taskId);
    expect(got.status).toBe("pending");
    expect(got.external.externalRef).toBe(baseCreate.external_ref);
    expect(got.external.canonicalRequestHash).toBe(created.canonicalRequestHash);
    expect(JSON.stringify(got)).not.toContain(issued.token);
    expect(JSON.stringify(got)).not.toContain(issued.keyId);

    const byRef = await caller.getByReference(baseCreate);
    expect(byRef.taskId).toBe(created.task.taskId);
    expect(byRef.duplicate).toBe(true);

    // get by TG id
    const byId = await caller.get({ task_id: created.task.taskId });
    expect(byId.taskId).toBe(created.task.taskId);

    // Unknown ref → NOT_FOUND
    await expect(caller.getByReference({ ...baseCreate, external_ref: "beidou:research:nope" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("cancel is scoped, terminal-state-safe and idempotent", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:cancel", "research-task:read"],
    });
    const caller = await callerFor(issued);
    const created = await caller.create(baseCreate);

    const cancelled = await caller.cancel({ external_ref: baseCreate.external_ref });
    expect(cancelled.task.status).toBe("failed");
    expect(cancelled.task.lifecycleStatus).toBe("cancelled");
    expect(cancelled.task.id).toBe(created.task.id);

    // Idempotent on terminal state.
    const again = await caller.cancel({ external_ref: baseCreate.external_ref });
    expect(again.task.lifecycleStatus).toBe("cancelled");

    // Read shows the terminal state.
    const got = await caller.get({ external_ref: baseCreate.external_ref });
    expect(got.lifecycleStatus).toBe("cancelled");
  });

  it("requests cancellation from a running executor before terminal acknowledgement", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:cancel", "research-task:read"],
    });
    const caller = await callerFor(issued);
    await caller.create({ ...baseCreate, external_ref: "beidou:research:running", idempotency_key: "idem-running" });
    const row = shared.db.rowsOfTable(tasks)[0];
    await shared.db.update(tasks).set({ status: "running", lifecycleStatus: "working" }).where(eq(tasks.id, Number(row.id)));

    const cancellation = await caller.cancel({ external_ref: "beidou:research:running" });

    expect(cancellation.task).toMatchObject({ status: "running", lifecycleStatus: "cancel_requested", cancellationAcknowledged: false });
    const persisted = shared.db.rowsOfTable(tasks)[0];
    expect(persisted.cancelRequestedAt).toBeInstanceOf(Date);
    expect(persisted.cancelAcknowledgedAt).toBeNull();
  });

  it("artifact-stream returns the sealed manifest and immutable descriptors", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create", "research-task:artifact-stream", "research-task:read"],
    });
    const caller = await callerFor(issued);
    const created = await caller.create(baseCreate);
    void created;
    const taskId = shared.db.rowsOfTable(tasks)[0].id;

    const { sealedArtifactDescriptors, sealedArtifactManifests } = await import("@db/schema");
    const artifactUuid = "0bfb89de-ea3e-4549-a306-57a93efb05af";
    const manifestIdentity = "b".repeat(64);
    await shared.db.insert(sealedArtifactDescriptors).values({
      artifactUuid,
      taskId: taskId as number,
      taskPublicId: created.task.taskId,
      externalRef: baseCreate.external_ref,
      taskRevision: 2,
      creatorAgentId: null,
      ownerPrincipal: issued.keyId,
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      providerInstanceId: "tiangong-instance-1",
      sha256: "a".repeat(64),
      generationId: 1,
      size: 7,
      mime: "text/markdown",
      storedPath: "/not-opened-for-listing",
      sealedAt: new Date(),
      retainUntil: new Date("2099-01-01T00:00:00Z"),
    });
    await shared.db.insert(sealedArtifactManifests).values({
      taskId: taskId as number,
      taskPublicId: created.task.taskId,
      externalRef: baseCreate.external_ref,
      taskRevision: 2,
      providerInstanceId: "tiangong-instance-1",
      manifestIdentity,
      canonicalManifest: JSON.stringify({ schema_version: "tiangong-artifact-manifest.v1", artifacts: [] }),
      sealedAt: new Date(),
    });

    const stream = await caller.artifactStream({ external_ref: baseCreate.external_ref });
    expect(stream.artifacts).toHaveLength(1);
    expect(stream.artifacts[0]).toMatchObject({ artifactUuid, mime: "text/markdown", generationId: 1 });
    expect(stream.manifestIdentity).toBe(manifestIdentity);
    expect(JSON.stringify(stream)).not.toContain(issued.token);

    // Unknown external_ref → NOT_FOUND (same semantics as get).
    await expect(
      caller.artifactStream({ external_ref: "beidou:research:never-existed" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("revoked keys are denied by the router (key_id lookup)", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    const { revokeServiceKey } = await import("../../api/lib/beidou-service-keys");
    await revokeServiceKey(issued.keyId, "qa");
    const caller = await callerFor(issued);
    await expect(caller.create(baseCreate)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("stores verifier bytes only — no plaintext token in the key table or task rows", async () => {
    const issued = await issueServiceKey({
      workspaceSlug: "beidou-ws",
      projectSlug: "research",
      scopes: ["research-task:create"],
    });
    const caller = await callerFor(issued);
    await caller.create(baseCreate);
    for (const table of [tiangongServiceKeys, tasks]) {
      const dump = JSON.stringify(shared.db.rowsOfTable(table));
      expect(dump).not.toContain(issued.token);
    }
    const verifier = String(shared.db.rowsOfTable(tiangongServiceKeys)[0].verifier);
    expect(verifier).toHaveLength(64);
    expect(verifier).toBe(
      createHmac("sha256", process.env.TIANGONG_SERVICE_KEY_PEPPER!).update(issued.token).digest("hex"),
    );
  });
});
