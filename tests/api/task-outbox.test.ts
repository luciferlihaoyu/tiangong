import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { taskOutboxEvents, tasks } from "@db/schema";

const shared = vi.hoisted(() => ({ db: null as unknown as import("./helpers/fake-db").FakeDb }));

vi.mock("../../api/queries/connection", async () => {
  const mod = await import("./helpers/fake-db");
  mod.fakeDbRegistry.instance = mod.createFakeDb();
  shared.db = mod.fakeDbRegistry.instance;
  return { getDb: () => mod.fakeDbRegistry.instance };
});

import { beidouExternalRouter } from "../../api/beidou-external-router";
import { issueServiceKey } from "../../api/lib/beidou-service-keys";
import {
  buildTaskEventBody,
  callbackHeaders,
  dispatchDueOutboxEvents,
  dispatchOutboxEvent,
  nextRetryAt,
  type CallbackBinding,
} from "../../api/lib/task-outbox";
import { createCallerFactory, createContext } from "../../api/middleware";
import { verifyRawBodySignature } from "../../api/lib/raw-body-signature";

const createCaller = createCallerFactory(beidouExternalRouter);
const binding: CallbackBinding = {
  originSystem: "beidou",
  workspaceSlug: "beidou-ws",
  projectSlug: "research",
  destination: "https://beidou.test/api/tiangong/events",
  keys: [{ keyId: "tgcb_old", secret: "old-callback-secret", retainUntil: new Date("2099-08-14T00:00:00Z") }],
};

const request = {
  external_ref: "beidou:task:22",
  idempotency_key: "todo-22-idempotency",
  operation: "create",
  target: "organize research",
  params_snapshot: { safe: true },
  origin_system: "beidou",
} as const;

async function caller() {
  const key = await issueServiceKey({
    workspaceSlug: binding.workspaceSlug,
    projectSlug: binding.projectSlug,
    scopes: ["research-task:create", "research-task:read", "research-task:cancel"],
  });
  const ctx = await createContext({ req: new Request("http://localhost/api/trpc", { headers: {
    authorization: `Bearer ${key.token}`,
    "x-tg-service-key-id": key.keyId,
  } }) });
  return createCaller(ctx);
}

describe("transactional task outbox schema and hook", () => {
  beforeEach(() => {
    shared.db.reset();
    process.env.TIANGONG_CALLBACK_BINDINGS = JSON.stringify([binding]);
    process.env.TIANGONG_SERVICE_KEY_PEPPER = "task-22-test-pepper";
  });

  it("defines the durable delivery and monotonic identity fields", () => {
    const columns = new Set(getTableConfig(taskOutboxEvents).columns.map((column) => column.name));
    for (const name of ["event_id", "task_id", "task_public_id", "external_ref", "state_revision", "status", "lifecycle_status", "board_status", "review_result", "trace_id", "payload_digest", "key_id", "attempts", "next_attempt_at", "dead_letter_at"]) {
      expect(columns.has(name), `missing task_outbox_events.${name}`).toBe(true);
    }
  });

  it("creates one event per revision and emits none for a duplicate transition", async () => {
    const api = await caller();
    await api.create(request);
    await api.cancel({ external_ref: request.external_ref, expected_state_revision: 1 });
    await api.cancel({ external_ref: request.external_ref, expected_state_revision: 2 });

    expect(shared.db.rowsOfTable(tasks)[0].stateRevision).toBe(2);
    expect(shared.db.rowsOfTable(taskOutboxEvents).map((row) => row.stateRevision)).toEqual([1, 2]);
  });

  it("rolls back the state change when the same-transaction outbox insert fails", async () => {
    const api = await caller();
    await api.create(request);
    shared.db.failNextInsert(taskOutboxEvents);

    await expect(api.cancel({ external_ref: request.external_ref, expected_state_revision: 1 })).rejects.toThrow();
    expect(shared.db.rowsOfTable(tasks)[0].stateRevision).toBe(1);
    expect(shared.db.rowsOfTable(taskOutboxEvents)).toHaveLength(1);
  });
});

describe("signed delivery and retry policy", () => {
  beforeEach(() => shared.db.reset());
  const event = {
    eventId: "018f47d2-8f7a-7cc1-8ca9-001122334455",
    taskId: 41,
    taskPublicId: "TG-TODO22",
    externalRef: "beidou:task:22",
    originSystem: "beidou",
    workspaceSlug: "beidou-ws",
    projectSlug: "research",
    eventType: "state",
    status: "failed",
    lifecycleStatus: "cancelled",
    boardStatus: "triage",
    reviewResult: null,
    stateRevision: 2,
    traceId: "trace-task-22",
    keyId: "tgcb_old",
    attempts: 0,
    nextAttemptAt: new Date("2026-08-13T00:00:00Z"),
    firstAttemptAt: null,
    deliveredAt: null,
    deadLetterAt: null,
    lastErrorCode: null,
  } as const;

  it("serializes a raw state tuple canonically and signs all seven frozen headers", () => {
    const body = buildTaskEventBody(event);
    const headers = callbackHeaders(event, body, binding.keys[0], 1_765_000_000, "AAAAAAAAAAAAAAAAAAAAAA");

    expect(body).toBe('{"event_id":"018f47d2-8f7a-7cc1-8ca9-001122334455","event_type":"state","external_ref":"beidou:task:22","raw_state":{"board_status":"triage","lifecycle_status":"cancelled","review_result":null,"status":"failed"},"state_revision":2,"task_id":"TG-TODO22","trace_id":"trace-task-22"}');
    expect(Object.keys(headers).filter((name) => name.startsWith("X-TG-"))).toEqual([
      "X-TG-Event-ID", "X-TG-Task-ID", "X-TG-External-Ref", "X-TG-Timestamp", "X-TG-Nonce", "X-TG-Key-ID", "X-TG-Signature",
    ]);
    expect(headers["X-TG-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyRawBodySignature({ headers: new Headers(headers), rawBody: body, now: 1_765_000_000_000, resolveSecret: (id) => id === "tgcb_old" ? binding.keys[0].secret : null })).toEqual({ valid: true });
  });

  it("doubles retries within 24 hours and dead-letters after five attempts", () => {
    const start = new Date("2026-08-13T00:00:00Z");
    expect([1, 2, 3, 4].map((attempt) => (nextRetryAt(start, attempt).getTime() - start.getTime()) / 1000)).toEqual([60, 120, 240, 480]);
    expect(nextRetryAt(start, 5)).toBeNull();
    expect(nextRetryAt(start, 1, new Date("2026-08-14T00:00:01Z"))).toBeNull();
  });

  it("refuses redirects and logs neither body nor secret while retaining the old key", async () => {
    const logs: string[] = [];
    const body = buildTaskEventBody(event);
    const result = await dispatchOutboxEvent(event, binding, {
      now: new Date("2026-08-13T00:00:00Z"),
      send: async (request) => {
        expect(request.redirect).toBe("manual");
        expect(request.url).toBe(binding.destination);
        expect(request.headers["X-TG-Key-ID"]).toBe("tgcb_old");
        return { status: 302 };
      },
      log: (line) => logs.push(line),
    });

    expect(result.kind).toBe("retry");
    expect(logs.join(" ")).not.toContain(body);
    expect(logs.join(" ")).not.toContain(binding.keys[0].secret);
    expect(createHash("sha256").update(body).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects non-HTTPS and task-controlled destinations before transport", async () => {
    const send = vi.fn();
    await expect(dispatchOutboxEvent(event, { ...binding, destination: "http://beidou.test/callback" }, { now: new Date(), send, log: vi.fn() })).rejects.toMatchObject({ name: "CallbackConfigurationError" });
    expect(send).not.toHaveBeenCalled();
  });

  it("resumes after interruption and visibly dead-letters a dead endpoint", async () => {
    process.env.TIANGONG_CALLBACK_BINDINGS = JSON.stringify([binding]);
    const firstAttempt = new Date("2026-08-13T00:00:00Z");
    await shared.db.insert(taskOutboxEvents).values({
      ...event,
      payloadDigest: createHash("sha256").update(buildTaskEventBody(event)).digest("hex"),
      attempts: 4,
      firstAttemptAt: firstAttempt,
      nextAttemptAt: new Date("2026-08-13T00:08:00Z"),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("dispatcher interrupted")).mockResolvedValueOnce(new Response(null, { status: 503 })));

    await dispatchDueOutboxEvents(new Date("2026-08-13T00:08:00Z"));
    const dead = shared.db.rowsOfTable(taskOutboxEvents)[0];

    expect(dead.attempts).toBe(5);
    expect(dead.deadLetterAt).toEqual(new Date("2026-08-13T00:08:00Z"));
    expect(dead.lastErrorCode).toBe("delivery_failed");
    expect(await dispatchDueOutboxEvents(new Date("2026-08-13T00:09:00Z"))).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("uses the event-pinned old key after rotation during its overlap", async () => {
    const rotated: CallbackBinding = {
      ...binding,
      keys: [
        { keyId: "tgcb_old", secret: "old-callback-secret", retainUntil: new Date("2026-08-14T00:00:00Z") },
        { keyId: "tgcb_new", secret: "new-callback-secret", retainUntil: new Date("2026-08-15T00:00:00Z") },
      ],
    };
    let received: Record<string, string> = {};

    const result = await dispatchOutboxEvent(event, rotated, {
      now: new Date("2026-08-13T12:00:00Z"),
      send: async (request) => {
        received = request.headers;
        return { status: 204 };
      },
      log: vi.fn(),
    });

    expect(result).toEqual({ kind: "delivered" });
    expect(received["X-TG-Key-ID"]).toBe("tgcb_old");
    expect(verifyRawBodySignature({ headers: new Headers(received), rawBody: buildTaskEventBody(event), now: Number(received["X-TG-Timestamp"]) * 1000, resolveSecret: (keyId) => keyId === "tgcb_old" ? "old-callback-secret" : null })).toEqual({ valid: true });
  });
});
