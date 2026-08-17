/**
 * Todo 20 (Beidou plan): scoped Beidou service-principal router.
 *
 * External research-task operations bound to `originSystem=beidou` and to the
 * key's allowed workspace/project. Least-privilege allowlist:
 *   research-task:create / read / cancel / artifact-stream
 * No wildcard scope, no weak unbound task mutations (no updateProgress /
 * approve / reject / delete / dispatch / promote exposed here), no credential
 * ever returned by APIs.
 *
 * Canonical request-hash normalization (Todo 21 consumes it): RFC 8785 JCS
 * over the exact named field set (originSystem, external_ref, idempotency_key,
 * operation, target, params_snapshot), recorded alongside the idempotency
 * reference; duplicate creates with the same canonical hash return the same
 * TG id; the same hash is reused on get-by-reference.
 */

import { z } from "zod";
import { randomBytes } from "node:crypto";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, sealedArtifactDescriptors, sealedArtifactManifests } from "@db/schema";
import { eq, and, or } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  ORIGIN_SYSTEM_BEIDOU,
  BEIDOU_SERVICE_SCOPES,
  type BeidouServiceScope,
  type ServicePrincipal,
} from "./lib/beidou-service-keys";
import { canonicalRequestHash, type CanonicalRequest } from "./lib/canonical-request-hash";
import { createTaskMetadata } from "./lib/task-metadata";
import { enqueueTaskOutboxEvent } from "./lib/task-outbox";
import { externalStateOf, canExternalTransition } from "./lib/external-task-lifecycle";
import { requestExecutorCancellation } from "./lib/executor-cancellation";

// ─── Input schemas ───

const ExternalRefLookupSchema = z.object({
  external_ref: z.string().min(1).max(255).optional(),
  task_id: z.string().min(1).max(20).optional(),
  expected_state_revision: z.number().int().positive().optional(),
});

const BeidouRequestFieldsSchema = z.object({
  external_ref: z.string().min(1).max(255),
  idempotency_key: z.string().min(1).max(128),
  operation: z.string().min(1).max(64).default("create"),
  target: z.string().min(1).max(255),
  params_snapshot: z.record(z.string(), z.unknown()).default({}),
  // Claimed origin must be "beidou" (checked at business level → FORBIDDEN).
  origin_system: z.string().min(1).max(32).optional(),
  workspace_slug: z.string().min(1).max(100).optional(),
  project_slug: z.string().min(1).max(100).optional(),
});

const BeidouCreateInputSchema = BeidouRequestFieldsSchema.extend({
  priority: z.number().int().min(0).max(100).optional(),
  timeout_ms: z.number().int().min(1000).max(86_400_000).optional(),
});

const ArtifactStreamInputSchema = ExternalRefLookupSchema.extend({
  artifact_uuid: z.string().uuid().optional(),
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().positive().max(1024 * 1024).default(1024 * 1024),
});


export type BeidouExternalCreateInput = z.infer<typeof BeidouCreateInputSchema>;
export type BeidouExternalLookupInput = z.infer<typeof ExternalRefLookupSchema>;

// ─── Service-principal procedure factory (least-privilege) ───

function servicePrincipalProcedure(requiredScope: BeidouServiceScope) {
  return publicQuery.use(async ({ ctx, next }) => {
    if (!ctx.servicePrincipal) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "需要有效的 Beidou 服务身份" });
    }
    if (!ctx.servicePrincipal.scopes.includes(requiredScope)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `scope 不足: 需要 ${requiredScope}（当前: ${ctx.servicePrincipal.scopes.join(",")}）`,
      });
    }
    return next({ ctx: { ...ctx, servicePrincipal: ctx.servicePrincipal } });
  });
}

// ─── Helpers ───

function generateTaskId(): string {
  const ts = Date.now().toString(36).slice(-5).toUpperCase();
  const rand = randomBytes(2).toString("hex").slice(0, 3).toUpperCase();
  return `TG-${ts}${rand}`;
}

/** The workspace/project binding enforced for every operation. */
function assertBinding(input: { workspace_slug?: string; project_slug?: string }, principal: ServicePrincipal): { workspaceSlug: string; projectSlug: string } {
  const workspaceSlug = input.workspace_slug ?? principal.workspaceSlug;
  const projectSlug = input.project_slug ?? principal.projectSlug;
  if (workspaceSlug !== principal.workspaceSlug || projectSlug !== principal.projectSlug) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "服务主体不允许访问该 workspace/project",
    });
  }
  return { workspaceSlug, projectSlug };
}

function assertOriginSystem(input: { origin_system?: string }): void {
  const claimed = input.origin_system ?? ORIGIN_SYSTEM_BEIDOU;
  if (claimed !== ORIGIN_SYSTEM_BEIDOU) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `originSystem 必须是 ${ORIGIN_SYSTEM_BEIDOU}`,
    });
  }
}

function canonicalOf(input: {
  origin_system?: string;
  external_ref: string;
  idempotency_key: string;
  operation: string;
  target: string;
  params_snapshot: Record<string, unknown>;
}): string {
  const req: CanonicalRequest = {
    originSystem: input.origin_system ?? ORIGIN_SYSTEM_BEIDOU,
    external_ref: input.external_ref,
    idempotency_key: input.idempotency_key,
    operation: input.operation,
    target: input.target,
    params_snapshot: input.params_snapshot,
  };
  return canonicalRequestHash(req);
}

type ExternalEnvelope = {
  originSystem: string;
  externalRef: string;
  idempotencyKey: string;
  operation: string;
  target: string;
  canonicalRequestHash: string;
  workspaceSlug: string;
  projectSlug: string;
  stateRevision: number;
};

function parseExternalEnvelope(rawInput: unknown): ExternalEnvelope | null {
  const value = typeof rawInput === "string" ? tryParseJson(rawInput) : rawInput;
  if (!value || typeof value !== "object") return null;
  const external = (value as Record<string, unknown>).external;
  if (!external || typeof external !== "object") return null;
  const e = external as Record<string, unknown>;
  if (
    typeof e.originSystem !== "string" ||
    typeof e.externalRef !== "string" ||
    typeof e.canonicalRequestHash !== "string"
  ) {
    return null;
  }
  return {
    originSystem: e.originSystem,
    externalRef: e.externalRef,
    idempotencyKey: typeof e.idempotencyKey === "string" ? e.idempotencyKey : "",
    operation: typeof e.operation === "string" ? e.operation : "",
    target: typeof e.target === "string" ? e.target : "",
    canonicalRequestHash: e.canonicalRequestHash,
    workspaceSlug: typeof e.workspaceSlug === "string" ? e.workspaceSlug : "",
    projectSlug: typeof e.projectSlug === "string" ? e.projectSlug : "",
    stateRevision: 1,
  };
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function insertIdOf(result: unknown): number {
  if (Array.isArray(result)) return Number((result[0] as { insertId?: unknown } | undefined)?.insertId);
  return Number((result as { insertId?: unknown }).insertId);
}

function affectedRowsOf(result: unknown): number {
  if (Array.isArray(result)) return Number((result[0] as { affectedRows?: unknown } | undefined)?.affectedRows);
  return Number((result as { affectedRows?: unknown }).affectedRows);
}

async function findTaskByExternalRef(db: ReturnType<typeof getDb>, externalRef: string): Promise<ExternalEnvelope & { id: number; taskId: string } | null> {
  const rows = await db.select().from(tasks).where(and(
    eq(tasks.originSystem, ORIGIN_SYSTEM_BEIDOU),
    eq(tasks.externalRef, externalRef),
  )).limit(1);
  for (const row of rows) {
    const envelope = parseExternalEnvelope(row.input);
    if (row.originSystem && row.externalRef && row.canonicalRequestHash) {
      return {
        originSystem: row.originSystem,
        externalRef: row.externalRef,
        idempotencyKey: row.idempotencyKey ?? "",
        operation: envelope?.operation ?? "create",
        target: envelope?.target ?? row.name,
        canonicalRequestHash: row.canonicalRequestHash,
        workspaceSlug: envelope?.workspaceSlug ?? "",
        projectSlug: envelope?.projectSlug ?? "",
        stateRevision: row.stateRevision,
        id: row.id,
        taskId: row.taskId,
      };
    }
  }
  return null;
}

async function findTaskByTaskId(db: ReturnType<typeof getDb>, taskId: string): Promise<ExternalEnvelope & { id: number; taskId: string } | null> {
  const rows = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  const persisted = parseExternalEnvelope(row.input);
  const envelope = row.originSystem && row.externalRef && row.canonicalRequestHash
    ? {
        originSystem: row.originSystem,
        externalRef: row.externalRef,
        idempotencyKey: row.idempotencyKey ?? "",
        operation: persisted?.operation ?? "create",
        target: persisted?.target ?? row.name,
        canonicalRequestHash: row.canonicalRequestHash,
        workspaceSlug: persisted?.workspaceSlug ?? "",
        projectSlug: persisted?.projectSlug ?? "",
        stateRevision: row.stateRevision,
      }
    : persisted;
  if (!envelope || envelope.originSystem !== ORIGIN_SYSTEM_BEIDOU) return null;
  return { ...envelope, id: row.id, taskId: row.taskId };
}

function resolveScopedTask(
  principal: ServicePrincipal,
  input: { external_ref?: string; task_id?: string },
): Promise<ExternalEnvelope & { id: number; taskId: string }> {
  return resolveScopedTaskInner(principal, input);
}

async function resolveScopedTaskInner(
  principal: ServicePrincipal,
  input: { external_ref?: string; task_id?: string },
): Promise<ExternalEnvelope & { id: number; taskId: string }> {
  const db = getDb();
  let found: ExternalEnvelope & { id: number; taskId: string } | null = null;
  if (input.external_ref) {
    found = await findTaskByExternalRef(db, input.external_ref);
  } else if (input.task_id) {
    found = await findTaskByTaskId(db, input.task_id);
  }
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "外部任务不存在" });
  }
  // Workspace/project binding: the task must belong to this principal.
  if (found.workspaceSlug !== principal.workspaceSlug || found.projectSlug !== principal.projectSlug) {
    throw new TRPCError({ code: "FORBIDDEN", message: "服务主体不允许访问该任务" });
  }
  return found;
}
function taskFacts(row: typeof tasks.$inferSelect, envelope: ExternalEnvelope) {
  return {
    id: row.id,
    taskId: row.taskId,
    name: row.name,
    status: row.status,
    lifecycleStatus: row.lifecycleStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    stateRevision: row.stateRevision,
    external: {
      originSystem: envelope.originSystem,
      externalRef: envelope.externalRef,
      idempotencyKey: envelope.idempotencyKey,
      operation: envelope.operation,
      target: envelope.target,
      canonicalRequestHash: envelope.canonicalRequestHash,
      workspaceSlug: envelope.workspaceSlug,
      projectSlug: envelope.projectSlug,
    },
  };
}

// ─── Router ───

export const beidouExternalRouter = createRouter({
  /**
   * Create an external research task as the Beidou service principal.
   * Idempotent on (external_ref + canonical request hash): a duplicate with
   * the same canonical hash returns the same TG id; a changed payload is
   * rejected with 409 CONFLICT. Tiangong generates the TG id (sole authority).
   */
  create: servicePrincipalProcedure("research-task:create")
    .input(BeidouCreateInputSchema)
    .mutation(async ({ input, ctx }) => {
      const principal = ctx.servicePrincipal!;
      assertOriginSystem(input);
      const { workspaceSlug, projectSlug } = assertBinding(input, principal);
      const hash = canonicalOf(input);
      const db = getDb();

      const existing = await findTaskByExternalRef(db, input.external_ref);
      if (existing) {
        if (existing.canonicalRequestHash === hash) {
          return {
            success: true,
            duplicate: true,
            task: { id: existing.id, taskId: existing.taskId, name: existing.target },
            canonicalRequestHash: hash,
            originSystem: ORIGIN_SYSTEM_BEIDOU,
          };
        }
        throw new TRPCError({
          code: "CONFLICT",
          message: "同一 external_ref 已存在且请求体（canonical hash）不一致",
        });
      }

      const taskId = generateTaskId();
      const taskRetainUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const idempotencyRetainUntil = new Date(taskRetainUntil.getTime() + 24 * 60 * 60 * 1000);
      const inputJson = JSON.stringify({
        external: {
          originSystem: ORIGIN_SYSTEM_BEIDOU,
          externalRef: input.external_ref,
          idempotencyKey: input.idempotency_key,
          operation: input.operation,
          target: input.target,
          canonicalRequestHash: hash,
          workspaceSlug,
          projectSlug,
        },
        metadata: createTaskMetadata({
          origin: { system: ORIGIN_SYSTEM_BEIDOU, channel: "service", conversationRef: input.external_ref },
          taskType: "research_task",
        }),
      });
      try {
        await db.transaction(async (tx) => {
          const inserted = await tx.insert(tasks).values({
            taskId,
            name: input.target,
            agentId: null,
            description: input.target,
            priority: input.priority ?? 0,
            input: inputJson,
            status: "pending",
            lifecycleStatus: "created",
            maxRetries: 3,
            timeoutMs: input.timeout_ms ?? 300000,
            originSystem: ORIGIN_SYSTEM_BEIDOU,
            externalRef: input.external_ref,
            idempotencyKey: input.idempotency_key,
            canonicalRequestHash: hash,
            canonicalRequestHashVersion: "rfc8785-jcs-v1",
            stateRevision: 1,
            taskRetainUntil,
            idempotencyRetainUntil,
          });
          const insertedId = insertIdOf(inserted);
          await enqueueTaskOutboxEvent(tx, {
            taskId: insertedId,
            taskPublicId: taskId,
            externalRef: input.external_ref,
            originSystem: ORIGIN_SYSTEM_BEIDOU,
            workspaceSlug,
            projectSlug,
            eventType: "state",
            status: "pending",
            lifecycleStatus: "created",
            boardStatus: "triage",
            reviewResult: null,
            stateRevision: 1,
            traceId: `task:${taskId}:1`,
            now: new Date(),
          });
        });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ER_DUP_ENTRY") throw error;
        const raced = await db.select().from(tasks).where(and(
          eq(tasks.originSystem, ORIGIN_SYSTEM_BEIDOU),
          or(eq(tasks.externalRef, input.external_ref), eq(tasks.idempotencyKey, input.idempotency_key)),
        )).limit(1).then((rows) => rows[0]);
        if (raced?.canonicalRequestHash === hash) {
          return {
            success: true,
            duplicate: true,
            task: { id: raced.id, taskId: raced.taskId, name: raced.name },
            canonicalRequestHash: hash,
            originSystem: ORIGIN_SYSTEM_BEIDOU,
          };
        }
        throw new TRPCError({ code: "CONFLICT", message: "外部任务身份已存在且 canonical hash 不一致" });
      }

      const rows = await db.select().from(tasks).where(eq(tasks.taskId, taskId)).limit(1);
      const created = rows[0];
      return {
        success: true,
        duplicate: false,
        task: { id: created?.id ?? null, taskId, name: input.target },
        canonicalRequestHash: hash,
        originSystem: ORIGIN_SYSTEM_BEIDOU,
      };
    }),

  /** Read task facts of the principal's own external task. */
  get: servicePrincipalProcedure("research-task:read")
    .input(ExternalRefLookupSchema.refine((v) => v.external_ref !== undefined || v.task_id !== undefined, { message: "需要 external_ref 或 task_id" }))
    .query(async ({ input, ctx }) => {
      const found = await resolveScopedTask(ctx.servicePrincipal!, input);
      const db = getDb();
      const rows = await db.select().from(tasks).where(eq(tasks.id, found.id)).limit(1);
      const row = rows[0]!;
      return taskFacts(row, found);
    }),

  /**
   * Reuse the canonical request hash to retrieve the existing TG id.
   * Same external_ref + same canonical hash → same TG id; changed payload →
   * 409 CONFLICT; unknown ref → 404.
   */
  getByReference: servicePrincipalProcedure("research-task:read")
    .input(BeidouRequestFieldsSchema)
    .query(async ({ input, ctx }) => {
      const principal = ctx.servicePrincipal!;
      assertOriginSystem(input);
      const hash = canonicalOf(input);
      const db = getDb();
      const existing = await findTaskByExternalRef(db, input.external_ref);
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "外部任务不存在" });
      }
      if (existing.workspaceSlug !== principal.workspaceSlug || existing.projectSlug !== principal.projectSlug) {
        throw new TRPCError({ code: "FORBIDDEN", message: "服务主体不允许访问该任务" });
      }
      if (existing.canonicalRequestHash !== hash) {
        throw new TRPCError({ code: "CONFLICT", message: "canonical hash 与已存在任务不一致" });
      }
      return { taskId: existing.taskId, canonicalRequestHash: hash, duplicate: true, originSystem: ORIGIN_SYSTEM_BEIDOU, stateRevision: existing.stateRevision };
    }),


  /** Scoped cancel: terminal-state-safe, idempotent, bound to the principal. */
  cancel: servicePrincipalProcedure("research-task:cancel")
    .input(ExternalRefLookupSchema.refine((v) => v.external_ref !== undefined || v.task_id !== undefined, { message: "需要 external_ref 或 task_id" }))
    .mutation(async ({ input, ctx }) => {
      const found = await resolveScopedTask(ctx.servicePrincipal!, input);
      const db = getDb();
      const rows = await db.select().from(tasks).where(eq(tasks.id, found.id)).limit(1);
      const row = rows[0]!;
       const approvalRequired = Boolean(tryParseJson(String(row.input ?? "")) && JSON.stringify(tryParseJson(String(row.input ?? ""))).includes('"approvalRequired":true'));
       const currentState = externalStateOf({ status: row.status, lifecycleStatus: row.lifecycleStatus, approvalRequired });
       const terminal = currentState === "completed" || currentState === "failed" || currentState === "cancelled";
      if (input.expected_state_revision !== undefined && input.expected_state_revision !== row.stateRevision) {
        throw new TRPCError({ code: "CONFLICT", message: "state_revision 已过期" });
      }
       if (!terminal) {
         const running = currentState === "running" || currentState === "submitted";
         const nextState = running ? "cancel_requested" : "cancelled";
         if (currentState === null || !canExternalTransition(currentState, nextState, "service_principal")) {
           throw new TRPCError({ code: "CONFLICT", message: "external state transition is forbidden" });
         }
         await db.transaction(async (tx) => {
          const now = new Date();
          const update = await tx
            .update(tasks)
            .set({
               status: running ? "running" : "failed",
               lifecycleStatus: nextState,
               error: running ? "cancellation_requested_by_beidou_service_principal" : "cancelled_by_beidou_service_principal",
               cancelRequestedAt: now,
               cancelAcknowledgedAt: running ? null : now,
               failedAt: running ? null : now,
              updatedAt: now,
              stateRevision: row.stateRevision + 1,
            })
            .where(and(eq(tasks.id, found.id), eq(tasks.stateRevision, row.stateRevision)));
          if (affectedRowsOf(update) !== 1) throw new TRPCError({ code: "CONFLICT", message: "state_revision 已过期" });
          await enqueueTaskOutboxEvent(tx, {
            taskId: found.id,
            taskPublicId: found.taskId,
            externalRef: found.externalRef,
            originSystem: ORIGIN_SYSTEM_BEIDOU,
            workspaceSlug: found.workspaceSlug,
            projectSlug: found.projectSlug,
             eventType: running ? "state" : "terminal",
             status: running ? "running" : "failed",
             lifecycleStatus: nextState,
            boardStatus: row.boardStatus,
            reviewResult: row.reviewResult,
            stateRevision: row.stateRevision + 1,
            traceId: `task:${found.taskId}:${row.stateRevision + 1}`,
            now,
         });
         if (running) requestExecutorCancellation(found.id);
        });
        const current = await db.select({ stateRevision: tasks.stateRevision }).from(tasks).where(eq(tasks.id, found.id)).limit(1).then((rows) => rows[0]);
        if (current?.stateRevision !== row.stateRevision + 1) throw new TRPCError({ code: "CONFLICT", message: "state_revision 已过期" });
      }
      return {
        success: true,
         task: {
           id: found.id,
           taskId: found.taskId,
           status: terminal ? row.status : currentState === "running" || currentState === "submitted" ? "running" : "failed",
           lifecycleStatus: terminal ? row.lifecycleStatus : currentState === "running" || currentState === "submitted" ? "cancel_requested" : "cancelled",
           cancellationAcknowledged: terminal ? currentState === "cancelled" : currentState !== "running" && currentState !== "submitted",
           stateRevision: terminal ? row.stateRevision : row.stateRevision + 1,
         },
      };
    }),

  artifactStream: servicePrincipalProcedure("research-task:artifact-stream")
    .input(ArtifactStreamInputSchema.refine((v) => v.external_ref !== undefined || v.task_id !== undefined, { message: "需要 external_ref 或 task_id" }))
    .query(async ({ input, ctx }) => {
      const found = await resolveScopedTask(ctx.servicePrincipal!, input);
      const db = getDb();
      const manifest = await db.select().from(sealedArtifactManifests).where(eq(sealedArtifactManifests.taskId, found.id)).limit(1).then((rows) => rows[0]);
      if (!manifest) throw new TRPCError({ code: "NOT_FOUND", message: "sealed artifact manifest does not exist" });
      const artifacts = await db.select().from(sealedArtifactDescriptors).where(eq(sealedArtifactDescriptors.taskId, found.id)).limit(50);
      const selected = input.artifact_uuid ? artifacts.find((artifact) => artifact.artifactUuid === input.artifact_uuid) : undefined;
      let stream: { artifactUuid: string; offset: number; bytesBase64: string; eof: boolean } | null = null;
      if (input.artifact_uuid) {
        if (!selected) throw new TRPCError({ code: "NOT_FOUND", message: "artifact descriptor does not exist for task" });
        if (selected.retainUntil <= new Date()) throw new TRPCError({ code: "NOT_FOUND", message: "artifact retention expired" });
        const { open } = await import("node:fs/promises");
        const { constants } = await import("node:fs");
        const handle = await open(selected.storedPath, constants.O_NOFOLLOW | constants.O_RDONLY);
        const maximum = Math.min(input.length, Math.max(0, selected.size - input.offset));
        const bytes = Buffer.alloc(maximum);
        const read = await handle.read(bytes, 0, maximum, input.offset);
        await handle.close();
        stream = { artifactUuid: selected.artifactUuid, offset: input.offset, bytesBase64: bytes.subarray(0, read.bytesRead).toString("base64"), eof: input.offset + read.bytesRead >= selected.size };
      }
      return {
        tiangongProviderInstanceId: manifest.providerInstanceId,
        manifestIdentity: manifest.manifestIdentity,
        manifest: JSON.parse(manifest.canonicalManifest),
        artifacts: artifacts.map((a) => ({
          artifactUuid: a.artifactUuid,
          sha256: a.sha256,
          generationId: a.generationId,
          size: a.size,
          mime: a.mime,
          taskRevision: a.taskRevision,
        })),
        stream,
      };
    }),
});

export { BEIDOU_SERVICE_SCOPES };
