import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  sealedArtifactDescriptors,
  sealedArtifactManifests,
  stagedObjects,
  tasks,
  tiangongArtifactLimits,
} from "@db/schema";
import { getDb } from "../../queries/connection";
import { enqueueTaskOutboxEvent } from "../task-outbox";
import { externalStateOf, isExternalTerminalState } from "../external-task-lifecycle";
import { ArtifactStorageError, ArtifactVolume, computeSealedManifest } from "./artifact-volume";
import { ARTIFACT_MANIFEST_VERSION } from "./artifact-types";

type SealArtifact = Readonly<{
  artifactUuid: string;
  bytes: Uint8Array;
  sha256: string;
  size: number;
  mime: string;
  creatorAgentId: number | null;
}>;

type SealRequest = Readonly<{
  taskDatabaseId: number;
  taskPublicId: string;
  externalRef: string;
  expectedRevision: number;
  ownerPrincipal: string;
  workspaceSlug: string;
  projectSlug: string;
  providerInstanceId: string;
  artifacts: readonly SealArtifact[];
  now: Date;
}>;

export class ArtifactSealer {
  constructor(private readonly volume: ArtifactVolume) {}

  async seal(request: SealRequest): Promise<Readonly<{ manifestIdentity: string; taskRevision: number }>> {
    const db = getDb();
    const task = await db.select().from(tasks).where(eq(tasks.id, request.taskDatabaseId)).limit(1).then((rows) => rows[0]);
    if (!task || task.taskId !== request.taskPublicId || task.externalRef !== request.externalRef || task.stateRevision !== request.expectedRevision) {
      throw new ArtifactStorageError("artifact_task_binding_mismatch", "task identity or revision does not match");
    }
    const current = externalStateOf({ status: task.status, lifecycleStatus: task.lifecycleStatus, approvalRequired: false });
    if (current === null || isExternalTerminalState(current)) throw new ArtifactStorageError("artifact_late", "artifacts cannot be registered after terminal revision");
    const limit = await db.select().from(tiangongArtifactLimits).where(and(
      eq(tiangongArtifactLimits.principalKey, request.ownerPrincipal),
      eq(tiangongArtifactLimits.workspaceSlug, request.workspaceSlug),
    )).limit(1).then((rows) => rows[0]);
    if (!limit) throw new ArtifactStorageError("storage_limits_unconfigured", "DB-backed artifact limits are required");
    const totalSize = request.artifacts.reduce((sum, artifact) => sum + artifact.size, 0);
    if (totalSize > limit.storageQuotaBytes) throw new ArtifactStorageError("storage_quota_exceeded", "artifact set exceeds principal storage quota");
    const installed: Array<SealArtifact & { readonly storedPath: string }> = [];
    for (const artifact of request.artifacts) {
      const stageId = randomUUID();
      await db.insert(stagedObjects).values({
        stageId,
        expectedSha256: artifact.sha256,
        expectedSize: artifact.size,
        expectedMime: artifact.mime,
        generationId: 1,
        ownerPrincipal: request.ownerPrincipal,
        expiresAt: new Date(request.now.getTime() + limit.gcGraceSeconds * 1000),
        state: "staging",
      });
      await this.volume.stage({ stageId, bytes: artifact.bytes, expectedSha256: artifact.sha256, expectedSize: artifact.size });
      await db.update(stagedObjects).set({ state: "verified" }).where(eq(stagedObjects.stageId, stageId));
      const result = await this.volume.install({ stageId, sha256: artifact.sha256, size: artifact.size });
      installed.push({ ...artifact, storedPath: result.path });
    }
    for (const artifact of installed) await this.volume.verifyInstalled(artifact.sha256, artifact.size);
    const taskRevision = request.expectedRevision + 1;
    const manifest = computeSealedManifest({
      schema_version: ARTIFACT_MANIFEST_VERSION,
      task_id: request.taskPublicId,
      external_ref: request.externalRef,
      task_revision: taskRevision,
      sealed_at: request.now.toISOString(),
      artifacts: installed.map((artifact) => ({ artifact_uuid: artifact.artifactUuid, sha256: artifact.sha256, generation_id: 1, size: artifact.size, mime: artifact.mime })),
    });
    await db.transaction(async (tx) => {
      await tx.insert(sealedArtifactDescriptors).values(installed.map((artifact) => ({
        artifactUuid: artifact.artifactUuid,
        taskId: request.taskDatabaseId,
        taskPublicId: request.taskPublicId,
        externalRef: request.externalRef,
        taskRevision,
        creatorAgentId: artifact.creatorAgentId,
        ownerPrincipal: request.ownerPrincipal,
        workspaceSlug: request.workspaceSlug,
        projectSlug: request.projectSlug,
        providerInstanceId: request.providerInstanceId,
        sha256: artifact.sha256,
        generationId: 1,
        size: artifact.size,
        mime: artifact.mime,
        storedPath: artifact.storedPath,
        sealedAt: request.now,
        retainUntil: new Date(request.now.getTime() + limit.retentionSeconds * 1000),
      })));
      await tx.insert(sealedArtifactManifests).values({
        taskId: request.taskDatabaseId,
        taskPublicId: request.taskPublicId,
        externalRef: request.externalRef,
        taskRevision,
        providerInstanceId: request.providerInstanceId,
        manifestIdentity: manifest.identity,
        canonicalManifest: manifest.canonicalBytes.toString("utf8"),
        sealedAt: request.now,
      });
      const update = await tx.update(tasks).set({ status: "done", lifecycleStatus: "completed", progress: 100, completedAt: request.now, stateRevision: taskRevision }).where(and(eq(tasks.id, request.taskDatabaseId), eq(tasks.stateRevision, request.expectedRevision)));
      if (Number((update as { affectedRows?: unknown }).affectedRows) !== 1) throw new ArtifactStorageError("stale_state", "task revision changed while sealing");
      await enqueueTaskOutboxEvent(tx, {
        taskId: request.taskDatabaseId,
        taskPublicId: request.taskPublicId,
        externalRef: request.externalRef,
        originSystem: "beidou",
        workspaceSlug: request.workspaceSlug,
        projectSlug: request.projectSlug,
        eventType: "terminal",
        status: "done",
        lifecycleStatus: "completed",
        boardStatus: task.boardStatus,
        reviewResult: task.reviewResult,
        stateRevision: taskRevision,
        traceId: `task:${request.taskPublicId}:${taskRevision}`,
        now: request.now,
        manifestIdentity: manifest.identity,
      });
    });
    return { manifestIdentity: manifest.identity, taskRevision };
  }
}
