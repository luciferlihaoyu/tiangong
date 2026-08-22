import { z } from "zod";

export const TASK_TYPES = [
  "triage_task",
  "research_task",
  "writing_task",
  "media_task",
  "coding_task",
  "knowledge_task",
  "approval_task",
  "delivery_task",
] as const;

export const AGENT_SOURCES = ["system", "openclaw", "opencode", "mcp", "human", "beidou"] as const;

export const AGENT_CAPABILITIES = [
  "triage",
  "route",
  "decompose",
  "monitor",
  "summarize",
  "research",
  "analysis",
  "report",
  "writing",
  "editing",
  "summary",
  "image_prompt",
  "image_generation",
  "storyboard",
  "video_generation",
  "data_analysis",
  "spreadsheet",
  "datasource",
  "planning",
  "evaluation",
  "decision",
  "review",
  "test_case",
  "browser_check",
  "coordination",
  "followup",
  "status_report",
  "requirement",
  "code_reading",
  "spec",
  "coding",
  "debugging",
  "tests",
  "pr",
  "knowledge_search",
  "knowledge_write",
  "artifact_link",
  "approval",
] as const;

export const APPROVAL_RISK_TYPES = [
  "github_push",
  "github_merge",
  "github_release",
  "zeabur_deploy",
  "zeabur_restart",
  "zeabur_delete_service",
  "storage_delete",
  "newapi_write",
  "mcp_key_change",
  "external_send",
  "webhook_call",
] as const;

/** 任务重要度（任务 2.3）：important 的任务在 AList 完整归档之外，额外复制一份到 highlights/ 精华目录 */
export const TASK_IMPORTANCE = ["normal", "important"] as const;

export const TaskTypeSchema = z.enum(TASK_TYPES);
export const AgentSourceSchema = z.enum(AGENT_SOURCES);
export const AgentCapabilitySchema = z.enum(AGENT_CAPABILITIES);
export const ApprovalRiskTypeSchema = z.enum(APPROVAL_RISK_TYPES);
export const TaskImportanceSchema = z.enum(TASK_IMPORTANCE);

export const TraceIdSchema = z.string().regex(/^trc_[0-9a-z]+_[0-9a-z]{8}$/);

export const TraceContextSchema = z.object({
  traceId: TraceIdSchema,
  taskId: z.string().min(1).max(64).optional(),
  parentTaskId: z.string().min(1).max(64).optional(),
});

export const TaskOriginSchema = z.object({
  system: AgentSourceSchema,
  channel: z.string().min(1).max(100).optional(),
  conversationRef: z.string().min(1).max(255).optional(),
});

export const KnowledgeRefSchema = z.object({
  source: z.enum(["xuanji", "task", "artifact", "external"]),
  ref: z.string().min(1).max(255),
  title: z.string().min(1).max(255).optional(),
  url: z.string().url().optional(),
});

export const ArtifactRefSchema = z.object({
  storage: z.enum(["tos", "r2", "alist", "inline", "external"]),
  ref: z.string().min(1).max(500),
  artifactType: z.string().min(1).max(100),
  mimeType: z.string().min(1).max(100).optional(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const ModelPolicyRefSchema = z.string().min(1).max(120);

export const PolicyRefsSchema = z.object({
  modelPolicyRef: ModelPolicyRefSchema.optional(),
  knowledgePolicyRef: z.string().min(1).max(120).optional(),
  artifactPolicyRef: z.string().min(1).max(120).optional(),
  approvalPolicyRef: z.string().min(1).max(120).optional(),
});

export const RoutingMetadataSchema = z.object({
  selectedAgentId: z.string().min(1).max(100).optional(),
  candidateAgentIds: z.array(z.string().min(1).max(100)).default([]),
  reasonCode: z.string().min(1).max(100).optional(),
  approvalRequired: z.boolean().default(false),
  riskTypes: z.array(ApprovalRiskTypeSchema).default([]),
});

export const ApprovalRequestSchema = z.object({
  riskType: ApprovalRiskTypeSchema,
  requestedByTaskId: z.string().min(1).max(64),
  requestedByAgentId: z.string().min(1).max(100),
  target: z.string().min(1).max(500),
  preview: z.string().min(1).max(5000),
  decision: z.enum(["pending", "approved", "rejected"]),
  // Sweeper bookkeeping: last time the approval-stale nag was sent (ISO-8601).
  // Required so mergeTaskMetadata round-trips the throttle marker (zod strips unknown keys).
  lastNagAt: z.string().max(40).optional(),
});

export const TaskMetadataSchema = z.object({
  traceId: TraceIdSchema,
  taskType: TaskTypeSchema,
  origin: TaskOriginSchema,
  routing: RoutingMetadataSchema,
  policies: PolicyRefsSchema,
  knowledgeRefs: z.array(KnowledgeRefSchema),
  artifactRefs: z.array(ArtifactRefSchema),
  approval: ApprovalRequestSchema.optional(),
  // 重要度分级：旧 envelope 无此字段，zod 解析时缺省补 "normal"（与 approval 的可选语义不同——
  // importance 恒有值，下游 alist-sync 直接判 === "important" 即可）
  importance: TaskImportanceSchema.default("normal"),
});

export type TaskType = Readonly<z.infer<typeof TaskTypeSchema>>;
export type AgentSource = Readonly<z.infer<typeof AgentSourceSchema>>;
export type AgentCapability = Readonly<z.infer<typeof AgentCapabilitySchema>>;
export type TraceContext = Readonly<z.infer<typeof TraceContextSchema>>;
export type KnowledgeRef = Readonly<z.infer<typeof KnowledgeRefSchema>>;
export type ArtifactRef = Readonly<z.infer<typeof ArtifactRefSchema>>;
export type ModelPolicyRef = Readonly<z.infer<typeof ModelPolicyRefSchema>>;
export type ApprovalRiskType = Readonly<z.infer<typeof ApprovalRiskTypeSchema>>;
export type ApprovalRequest = Readonly<z.infer<typeof ApprovalRequestSchema>>;
export type TaskImportance = Readonly<z.infer<typeof TaskImportanceSchema>>;
export type TaskMetadata = Readonly<z.infer<typeof TaskMetadataSchema>>;
