import { randomBytes } from "node:crypto";
import { z } from "zod";

import {
  ArtifactRefSchema,
  ApprovalRequestSchema,
  KnowledgeRefSchema,
  PolicyRefsSchema,
  RoutingMetadataSchema,
  TaskImportanceSchema,
  TaskMetadataSchema,
  TaskOriginSchema,
  TaskTypeSchema,
  type ArtifactRef,
  type KnowledgeRef,
  type TaskMetadata,
  type TaskType,
} from "../contracts/platform";

const TraceIdSeedSchema = z.object({
  timestamp: z.date().optional(),
  entropy: z.string().regex(/^[0-9a-z]{8}$/).optional(),
});

const TaskMetadataPatchSchema = z.object({
  traceId: TaskMetadataSchema.shape.traceId.optional(),
  taskType: TaskTypeSchema.optional(),
  origin: TaskOriginSchema.partial().optional(),
  routing: RoutingMetadataSchema.partial().optional(),
  policies: PolicyRefsSchema.partial().optional(),
  knowledgeRefs: z.array(KnowledgeRefSchema).optional(),
  artifactRefs: z.array(ArtifactRefSchema).optional(),
  approval: ApprovalRequestSchema.optional(),
  importance: TaskImportanceSchema.optional(),
});

const JsonRecordSchema = z.record(z.string(), z.unknown());
const MetadataEnvelopeSchema = z.object({ metadata: TaskMetadataSchema }).passthrough();

export type TraceIdSeed = Readonly<z.infer<typeof TraceIdSeedSchema>>;
export type TaskMetadataPatch = Readonly<z.infer<typeof TaskMetadataPatchSchema>>;

export function createTraceId(seed: TraceIdSeed = {}): string {
  const parsedSeed = TraceIdSeedSchema.parse(seed);
  const timestamp = parsedSeed.timestamp ?? new Date();
  const entropy = parsedSeed.entropy ?? randomBytes(4).toString("hex");
  return `trc_${timestamp.getTime().toString(36)}_${entropy}`;
}

export function createTaskMetadata(input: TaskMetadataPatch = {}): TaskMetadata {
  const patch = TaskMetadataPatchSchema.parse(input);
  return TaskMetadataSchema.parse({
    traceId: patch.traceId ?? createTraceId(),
    taskType: patch.taskType ?? "triage_task",
    origin: {
      system: patch.origin?.system ?? "system",
      ...(patch.origin?.channel !== undefined ? { channel: patch.origin.channel } : {}),
      ...(patch.origin?.conversationRef !== undefined
        ? { conversationRef: patch.origin.conversationRef }
        : {}),
    },
    routing: {
      candidateAgentIds: patch.routing?.candidateAgentIds ?? [],
      approvalRequired: patch.routing?.approvalRequired ?? false,
      riskTypes: patch.routing?.riskTypes ?? [],
      ...(patch.routing?.selectedAgentId !== undefined
        ? { selectedAgentId: patch.routing.selectedAgentId }
        : {}),
      ...(patch.routing?.reasonCode !== undefined ? { reasonCode: patch.routing.reasonCode } : {}),
    },
    policies: {
      ...(patch.policies?.modelPolicyRef !== undefined
        ? { modelPolicyRef: patch.policies.modelPolicyRef }
        : {}),
      ...(patch.policies?.knowledgePolicyRef !== undefined
        ? { knowledgePolicyRef: patch.policies.knowledgePolicyRef }
        : {}),
      ...(patch.policies?.artifactPolicyRef !== undefined
        ? { artifactPolicyRef: patch.policies.artifactPolicyRef }
        : {}),
      ...(patch.policies?.approvalPolicyRef !== undefined
        ? { approvalPolicyRef: patch.policies.approvalPolicyRef }
        : {}),
    },
    knowledgeRefs: patch.knowledgeRefs ?? [],
    artifactRefs: patch.artifactRefs ?? [],
    ...(patch.approval !== undefined ? { approval: patch.approval } : {}),
    importance: patch.importance ?? "normal",
  });
}

export function parseTaskMetadata(raw: unknown): TaskMetadata | null {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (value === null) return null;

  const envelope = MetadataEnvelopeSchema.safeParse(value);
  if (envelope.success) return envelope.data.metadata;

  const direct = TaskMetadataSchema.safeParse(value);
  return direct.success ? direct.data : null;
}

export function mergeTaskMetadata(rawInput: string | null | undefined, input: TaskMetadataPatch): string {
  const patch = TaskMetadataPatchSchema.parse(input);
  const existing = parseTaskMetadata(rawInput);
  const base = existing ?? createTaskMetadata(patch);
  const metadata = mergeMetadata(base, patch);
  const rawValue = parseTaskInput(rawInput);

  if (TaskMetadataSchema.safeParse(rawValue).success) {
    return JSON.stringify({ metadata });
  }

  const record = JsonRecordSchema.safeParse(rawValue);
  if (record.success) {
    return JSON.stringify({ ...record.data, metadata });
  }

  return JSON.stringify({ payload: rawValue, metadata });
}

export function getKnowledgeRefs(raw: unknown): readonly KnowledgeRef[] {
  return parseTaskMetadata(raw)?.knowledgeRefs ?? [];
}

export function getArtifactRefs(raw: unknown): readonly ArtifactRef[] {
  return parseTaskMetadata(raw)?.artifactRefs ?? [];
}

export function assertTaskType(value: unknown): TaskType {
  return TaskTypeSchema.parse(value);
}

function mergeMetadata(base: TaskMetadata, patch: TaskMetadataPatch): TaskMetadata {
  return TaskMetadataSchema.parse({
    traceId: patch.traceId ?? base.traceId,
    taskType: patch.taskType ?? base.taskType,
    origin: { ...base.origin, ...patch.origin },
    routing: { ...base.routing, ...patch.routing },
    policies: { ...base.policies, ...patch.policies },
    knowledgeRefs: patch.knowledgeRefs ?? base.knowledgeRefs,
    artifactRefs: patch.artifactRefs ?? base.artifactRefs,
    ...(patch.approval !== undefined
      ? { approval: patch.approval }
      : base.approval !== undefined
        ? { approval: base.approval }
        : {}),
    // 必须显式带出：schema 的 default 只在字段缺失时补 "normal"，
    // 若不透传，无关字段的 merge 会把既有 important 抹回 normal
    importance: patch.importance ?? base.importance,
  });
}

function parseTaskInput(rawInput: string | null | undefined): unknown {
  if (rawInput === null || rawInput === undefined) return {};
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) return {};
  return parseJson(trimmed) ?? rawInput;
}

function parseJson(raw: string): unknown | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}
