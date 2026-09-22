import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, isNull, lte } from "drizzle-orm";
import { taskOutboxEvents, type TaskOutboxEvent } from "@db/schema";
import { getDb } from "../queries/connection";
import { signRawBody } from "./raw-body-signature";
import { isReady } from "./readiness";

const MAX_ATTEMPTS = 5;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;
const INITIAL_RETRY_MS = 60 * 1000;

const CallbackKeySchema = z.object({
  keyId: z.string().min(1).max(64),
  secret: z.string().min(16),
  retainUntil: z.coerce.date(),
});
const CallbackBindingSchema = z.object({
  originSystem: z.literal("beidou"),
  workspaceSlug: z.string().min(1).max(100),
  projectSlug: z.string().min(1).max(100),
  destination: z.string().url().refine((value) => new URL(value).protocol === "https:", "callback destination must use HTTPS"),
  keys: z.array(CallbackKeySchema).min(1),
});

export type CallbackBinding = z.infer<typeof CallbackBindingSchema>;
export type CallbackKey = z.infer<typeof CallbackKeySchema>;
type Database = ReturnType<typeof getDb>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type OutboxEventView = Pick<TaskOutboxEvent,
  "eventId" | "taskId" | "taskPublicId" | "externalRef" | "originSystem" |
  "workspaceSlug" | "projectSlug" | "eventType" | "status" |
  "lifecycleStatus" | "boardStatus" | "reviewResult" | "stateRevision" |
  "traceId" | "keyId" | "attempts" | "nextAttemptAt" | "firstAttemptAt" |
  "deliveredAt" | "deadLetterAt" | "lastErrorCode" | "manifestIdentity"
>;

export class CallbackConfigurationError extends Error {
  readonly name = "CallbackConfigurationError";
}

export function callbackBindings(): readonly CallbackBinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(process.env.TIANGONG_CALLBACK_BINDINGS ?? "[]");
  } catch (error) {
    throw new CallbackConfigurationError("TIANGONG_CALLBACK_BINDINGS is not valid JSON", { cause: error });
  }
  const result = z.array(CallbackBindingSchema).safeParse(parsed);
  if (!result.success) throw new CallbackConfigurationError("TIANGONG_CALLBACK_BINDINGS is invalid");
  return result.data;
}

export function bindingFor(scope: { readonly originSystem: string; readonly workspaceSlug: string; readonly projectSlug: string }): CallbackBinding {
  const binding = callbackBindings().find((candidate) =>
    candidate.originSystem === scope.originSystem &&
    candidate.workspaceSlug === scope.workspaceSlug &&
    candidate.projectSlug === scope.projectSlug
  );
  if (!binding) throw new CallbackConfigurationError("no callback binding for service principal");
  return binding;
}

export function buildTaskEventBody(event: OutboxEventView): string {
  return JSON.stringify({
    event_id: event.eventId,
    event_type: event.eventType,
    external_ref: event.externalRef,
    raw_state: {
      board_status: event.boardStatus,
      lifecycle_status: event.lifecycleStatus,
      review_result: event.reviewResult,
      status: event.status,
    },
    state_revision: event.stateRevision,
    task_id: event.taskPublicId,
    trace_id: event.traceId,
    manifest_identity: event.manifestIdentity,
  });
}

export function callbackHeaders(event: OutboxEventView, body: string, key: CallbackKey, timestamp?: number, nonce?: string): Record<string, string> {
  const signed = signRawBody({ keyId: key.keyId, secret: key.secret, body, timestamp, nonce });
  return {
    "Content-Length": signed.headers["content-length"],
    "Content-Type": signed.headers["content-type"],
    "X-TG-Event-ID": event.eventId,
    "X-TG-Task-ID": event.taskPublicId,
    "X-TG-External-Ref": event.externalRef,
    "X-TG-Timestamp": signed.headers["x-tg-timestamp"],
    "X-TG-Nonce": signed.headers["x-tg-nonce"],
    "X-TG-Key-ID": signed.headers["x-tg-key-id"],
    "X-TG-Signature": signed.headers["x-tg-signature"],
  };
}

export function nextRetryAt(firstAttemptAt: Date, completedAttempts: number, now: Date = firstAttemptAt): Date | null {
  if (completedAttempts >= MAX_ATTEMPTS || now.getTime() - firstAttemptAt.getTime() > RETRY_WINDOW_MS) return null;
  return new Date(now.getTime() + INITIAL_RETRY_MS * 2 ** (completedAttempts - 1));
}

type SendRequest = { readonly url: string; readonly headers: Record<string, string>; readonly body: string; readonly redirect: "manual" };
type DeliveryDeps = {
  readonly now: Date;
  readonly manifestIdentity?: string | null;
  readonly send: (request: SendRequest) => Promise<{ readonly status: number }>;
  readonly log: (line: string) => void;
};
export type DeliveryResult =
  | { readonly kind: "delivered" }
  | { readonly kind: "retry"; readonly nextAttemptAt: Date }
  | { readonly kind: "dead_letter" };

export async function dispatchOutboxEvent(event: OutboxEventView, unparsedBinding: CallbackBinding, deps: DeliveryDeps): Promise<DeliveryResult> {
  const parsedBinding = CallbackBindingSchema.safeParse(unparsedBinding);
  if (!parsedBinding.success) throw new CallbackConfigurationError("callback binding is invalid");
  const binding = parsedBinding.data;
  const key = binding.keys.find((candidate) => candidate.keyId === event.keyId && candidate.retainUntil.getTime() >= deps.now.getTime());
  if (!key) throw new CallbackConfigurationError("callback signing key unavailable inside retry window");
  const body = buildTaskEventBody(event);
  let status: number;
  try {
    status = (await deps.send({ url: binding.destination, headers: callbackHeaders(event, body, key), body, redirect: "manual" })).status;
  } catch {
    status = 0;
  }
  if (status >= 200 && status < 300) return { kind: "delivered" };
  const completedAttempts = event.attempts + 1;
  const first = event.firstAttemptAt ?? deps.now;
  const retryAt = nextRetryAt(first, completedAttempts, deps.now);
  deps.log(`task_outbox.delivery_failed event_id=${event.eventId} task_id=${event.taskPublicId} attempt=${completedAttempts} status=${status}`);
  return retryAt ? { kind: "retry", nextAttemptAt: retryAt } : { kind: "dead_letter" };
}

export async function sendCallback(request: SendRequest): Promise<{ readonly status: number }> {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status };
}

export function payloadDigest(event: OutboxEventView): string {
  return createHash("sha256").update(buildTaskEventBody(event), "utf8").digest("hex");
}

type EnqueueInput = {
  readonly taskId: number;
  readonly taskPublicId: string;
  readonly externalRef: string;
  readonly originSystem: "beidou";
  readonly workspaceSlug: string;
  readonly projectSlug: string;
  readonly eventType: "state" | "approval" | "terminal";
  readonly status: string;
  readonly lifecycleStatus: string | null;
  readonly boardStatus: string | null;
  readonly reviewResult: string | null;
  readonly stateRevision: number;
  readonly traceId: string;
  readonly now: Date;
  readonly manifestIdentity?: string | null;
};

export async function enqueueTaskOutboxEvent(db: Database | Transaction, input: EnqueueInput): Promise<string> {
  const binding = bindingFor(input);
  const key = [...binding.keys].reverse().find((candidate) => candidate.retainUntil.getTime() >= input.now.getTime() + RETRY_WINDOW_MS);
  if (!key) throw new CallbackConfigurationError("active callback key is not retained through retry window");
  const eventId = randomUUID();
  const view: OutboxEventView = {
    ...input,
    eventId,
    keyId: key.keyId,
    attempts: 0,
    nextAttemptAt: input.now,
    firstAttemptAt: null,
    deliveredAt: null,
    deadLetterAt: null,
    lastErrorCode: null,
    manifestIdentity: input.manifestIdentity ?? null,
  };
  await db.insert(taskOutboxEvents).values({ ...view, payloadDigest: payloadDigest(view) });
  return eventId;
}

/**
 * 选出待投递的事件：未投递、未死信、已到投递时间。
 *
 * WHERE 必须下推到 SQL——历史上这里先 `SELECT … LIMIT 100` 再在 JS 侧 filter，
 * 一旦表头堆满已投递/死信行，待投递事件会被挤到 LIMIT 之外**永久饿死**
 * （真 SQL 回归见 tests/api/task-outbox-starvation.test.ts）。
 * idx_task_outbox_due(next_attempt_at, delivered_at, dead_letter_at) 覆盖本查询。
 * @testable
 */
export async function selectDue(db: Database, now: Date): Promise<OutboxEventView[]> {
  return db
    .select()
    .from(taskOutboxEvents)
    .where(
      and(
        isNull(taskOutboxEvents.deliveredAt),
        isNull(taskOutboxEvents.deadLetterAt),
        lte(taskOutboxEvents.nextAttemptAt, now),
      ),
    )
    .limit(100);
}

export async function dispatchDueOutboxEvents(now: Date = new Date()): Promise<number> {
  const db = getDb();
  const due = await selectDue(db, now);
  for (const event of due) {
    const binding = bindingFor(event);
    const result = await dispatchOutboxEvent(event, binding, { now, send: sendCallback, log: console.warn });
    const attempts = event.attempts + 1;
    switch (result.kind) {
      case "delivered":
        await db.update(taskOutboxEvents).set({ attempts, firstAttemptAt: event.firstAttemptAt ?? now, deliveredAt: now, lastErrorCode: null }).where(eq(taskOutboxEvents.eventId, event.eventId));
        break;
      case "retry":
        await db.update(taskOutboxEvents).set({ attempts, firstAttemptAt: event.firstAttemptAt ?? now, nextAttemptAt: result.nextAttemptAt, lastErrorCode: "delivery_failed" }).where(eq(taskOutboxEvents.eventId, event.eventId));
        break;
      case "dead_letter":
        await db.update(taskOutboxEvents).set({ attempts, firstAttemptAt: event.firstAttemptAt ?? now, deadLetterAt: now, lastErrorCode: "delivery_failed" }).where(eq(taskOutboxEvents.eventId, event.eventId));
        break;
    }
  }
  return due.length;
}

export class TaskOutboxDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  start(intervalMs = 5_000): void {
    if (this.timer !== null || callbackBindings().length === 0) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    setImmediate(() => void this.tick());
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()): Promise<number> {
    if (this.running) return 0;
    // Phase B §2 不接单：迁移/schema 对齐/执行器未就绪时不派发事件。
    // 事件留在 outbox 里不会丢，等就绪后照常派发；反之在库不对的情况下派发
    // 会把不一致的状态推给下游（北斗/璇玑），比延迟更难收场。
    // 闸门放在循环里而不是 dispatchDueOutboxEvents 内部，是为了让该纯函数保持可直测。
    if (!isReady()) return 0;
    this.running = true;
    try {
      return await dispatchDueOutboxEvents(now);
    } catch (error) {
      console.warn(`task_outbox.dispatch_failed error=${error instanceof Error ? error.name : "unknown"}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}

export const taskOutboxDispatcher = new TaskOutboxDispatcher();
