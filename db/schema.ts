import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  text,
  timestamp,
  int,
  bigint,
  uniqueIndex,
  index,
  decimal,
} from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm";

// ─── Users (内置认证) ───
export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  lastSignInAt: timestamp("last_sign_in_at").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Agents ───
export const agents = mysqlTable("agents", {
  id: serial("id").primaryKey(),
  agentId: varchar("agent_id", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 50 }).notNull(),
  system: varchar("system", { length: 30 }).notNull(),
  status: mysqlEnum("status", ["online", "busy", "idle"]).default("idle").notNull(),
  task: varchar("task", { length: 255 }),
  progress: int("progress").default(0).notNull(),
  messagesCount: int("messages_count").default(0).notNull(),
  description: text("description"),
  createdBy: bigint("created_by", { mode: "number", unsigned: true }),
  // New fields for multi-agent collaboration
  source: varchar("source", { length: 50 }).default("custom"),
  model: varchar("model", { length: 100 }),
  role: varchar("role", { length: 100 }),
  manages: text("manages"),
  reportsTo: bigint("reports_to", { mode: "number" }),
  orgId: bigint("org_id", { mode: "number" }),
  departmentId: bigint("department_id", { mode: "number" }),
  currentTask: text("current_task"),
  capabilities: text("capabilities"),
  budgetCents: int("budget_cents").default(0),
  spentCents: int("spent_cents").default(0),
  lastHeartbeat: timestamp("last_heartbeat"),
  sourceApiKey: varchar("source_api_key", { length: 255 }),
  sourceEndpoint: varchar("source_endpoint", { length: 500 }),
  // ── A2A-lite v0.1: Agent Card extensibility ──
  agentCard: text("agent_card"),
  openclawAgent: varchar("openclaw_agent", { length: 100 }),
  canModifyTiangongCore: mysqlEnum("can_modify_tiangong_core", ["true", "false"]).default("false"),
  canSendExternalMessage: mysqlEnum("can_send_external_message", ["true", "false"]).default("false"),
  mcpToken: varchar("mcp_token", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Agent = typeof agents.$inferSelect;
export type InsertAgent = typeof agents.$inferInsert;

export type AgentCard = {
  capabilities: {
    category: string;
    items: string[];
    level: "expert" | "advanced" | "intermediate" | "beginner";
  }[];
  permissions: {
    canModifyTiangongCore: boolean;
    canSendExternalMessage: boolean;
    canExecuteCode: boolean;
    canAccessFiles: boolean;
    canAccessNetwork: boolean;
  };
  collaboration: {
    supportsTaskExecution: boolean;
    supportsReview: boolean;
    supportsSubtask: boolean;
    supportsHandoff: boolean;
  };
  openclaw: {
    agentId: string;
    sessionKey: string;
    model: string;
    runtime: "acp" | "subagent";
  } | null;
  metadata?: Record<string, unknown>;
};

// ─── Tasks ───
export const tasks = mysqlTable("tasks", {
  id: serial("id").primaryKey(),
  taskId: varchar("task_id", { length: 20 }).notNull().unique(),
  name: varchar("name", { length: 255 }).notNull(),
  agentId: bigint("agent_id", { mode: "number", unsigned: true }),
  status: mysqlEnum("status", ["running", "pending", "done", "failed", "queued"]).default("pending").notNull(),
  progress: int("progress").default(0).notNull(),
  description: text("description"),
  // New orchestration fields
  priority: int("priority").default(0),
  input: text("input"),
  output: text("output"),
  error: text("error"),
  retryCount: int("retry_count").default(0),
  maxRetries: int("max_retries").default(3),
  timeoutMs: int("timeout_ms").default(300000),
  parentTaskId: bigint("parent_task_id", { mode: "number" }),
  // 输出格式校验
  expectedOutputSchema: text("expected_output_schema"),
  outputValid: mysqlEnum("output_valid", ["true", "false", "unknown"]).default("unknown"),
  // ── A2A-lite v0.1: lifecycle status machine ──
  lifecycleStatus: varchar("lifecycle_status", { length: 30 }).default("created"),
  dispatcherAgentId: bigint("dispatcher_agent_id", { mode: "number", unsigned: true }),
  claimedAt: timestamp("claimed_at"),
  dispatchedAt: timestamp("dispatched_at"),
  acceptedAt: timestamp("accepted_at"),
  completedAt: timestamp("completed_at"),
  failedAt: timestamp("failed_at"),
  timeoutAt: timestamp("timeout_at"),
  // ── Phase 2: Taskboard status machine ──
  boardStatus: varchar("board_status", { length: 20 }).default("triage"),
  boardLabels: text("board_labels"), // JSON array of strings
  boardNotes: text("board_notes"),
  sourceUrl: varchar("source_url", { length: 500 }),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  heartbeatIntervalMs: int("heartbeat_interval_ms").default(300000),
  workerLeaseToken: varchar("worker_lease_token", { length: 64 }),
  workerLeaseGeneration: int("worker_lease_generation").default(0).notNull(),
  workerLeaseExpiresAt: timestamp("worker_lease_expires_at"),
  cancelRequestedAt: timestamp("cancel_requested_at"),
  cancelAcknowledgedAt: timestamp("cancel_acknowledged_at"),
  reviewerId: bigint("reviewer_id", { mode: "number", unsigned: true }),
  reviewResult: varchar("review_result", { length: 30 }),
  triagedAt: timestamp("triaged_at"),
  backloggedAt: timestamp("backlogged_at"),
  readyAt: timestamp("ready_at"),
  reviewAt: timestamp("review_at"),
  blockedAt: timestamp("blocked_at"),
  originSystem: varchar("origin_system", { length: 32 }),
  externalRef: varchar("external_ref", { length: 255 }),
  idempotencyKey: varchar("idempotency_key", { length: 128 }),
  canonicalRequestHash: varchar("canonical_request_hash", { length: 64 }),
  canonicalRequestHashVersion: varchar("canonical_request_hash_version", { length: 32 }),
  stateRevision: bigint("state_revision", { mode: "number", unsigned: true }).default(1).notNull(),
  taskRetainUntil: timestamp("task_retain_until"),
  idempotencyRetainUntil: timestamp("idempotency_retain_until"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  externalRefIdx: uniqueIndex("uq_tasks_origin_external_ref").on(table.originSystem, table.externalRef),
  idempotencyKeyIdx: uniqueIndex("uq_tasks_origin_idempotency_key").on(table.originSystem, table.idempotencyKey),
}));

export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

export const tiangongTaskLimits = mysqlTable("tiangong_task_limits", {
  id: serial("id").primaryKey(),
  principalKey: varchar("principal_key", { length: 255 }).notNull(),
  workspaceSlug: varchar("workspace_slug", { length: 100 }).notNull(),
  maxConcurrentTasks: int("max_concurrent_tasks").default(8).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  principalWorkspaceIdx: uniqueIndex("uq_tiangong_task_limits_principal_workspace").on(table.principalKey, table.workspaceSlug),
}));

export const taskExecutionSlots = mysqlTable("task_execution_slots", {
  id: serial("id").primaryKey(),
  taskId: bigint("task_id", { mode: "number", unsigned: true }).notNull(),
  principalKey: varchar("principal_key", { length: 255 }).notNull(),
  workspaceSlug: varchar("workspace_slug", { length: 100 }).notNull(),
  leaseToken: varchar("lease_token", { length: 64 }).notNull(),
  acquiredAt: timestamp("acquired_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => ({
  taskIdx: uniqueIndex("uq_task_execution_slots_task").on(table.taskId),
  scopeIdx: index("idx_task_execution_slots_scope").on(table.principalKey, table.workspaceSlug, table.expiresAt),
}));

export const tiangongWorkerLeases = mysqlTable("tiangong_worker_leases", {
  id: serial("id").primaryKey(),
  leaseToken: varchar("lease_token", { length: 64 }).notNull().unique(),
  workerId: varchar("worker_id", { length: 128 }).notNull(),
  principalKey: varchar("principal_key", { length: 255 }).notNull(),
  workspaceSlug: varchar("workspace_slug", { length: 100 }).notNull(),
  generation: int("generation").notNull(),
  issuedAt: timestamp("issued_at").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
}, (table) => ({
  workerScopeIdx: index("idx_tiangong_worker_leases_worker_scope").on(table.workerId, table.principalKey, table.workspaceSlug, table.expiresAt),
}));

export const taskOutboxEvents = mysqlTable("task_outbox_events", {
  id: serial("id").primaryKey(),
  eventId: varchar("event_id", { length: 36 }).notNull().unique(),
  taskId: bigint("task_id", { mode: "number", unsigned: true }).notNull(),
  taskPublicId: varchar("task_public_id", { length: 20 }).notNull(),
  externalRef: varchar("external_ref", { length: 255 }).notNull(),
  originSystem: varchar("origin_system", { length: 32 }).notNull(),
  workspaceSlug: varchar("workspace_slug", { length: 100 }).notNull(),
  projectSlug: varchar("project_slug", { length: 100 }).notNull(),
  eventType: mysqlEnum("event_type", ["state", "approval", "terminal"]).notNull(),
  status: varchar("status", { length: 30 }).notNull(),
  lifecycleStatus: varchar("lifecycle_status", { length: 30 }),
  boardStatus: varchar("board_status", { length: 20 }),
  reviewResult: varchar("review_result", { length: 30 }),
  stateRevision: bigint("state_revision", { mode: "number", unsigned: true }).notNull(),
  traceId: varchar("trace_id", { length: 64 }).notNull(),
  payloadDigest: varchar("payload_digest", { length: 64 }).notNull(),
  manifestIdentity: varchar("manifest_identity", { length: 64 }),
  keyId: varchar("key_id", { length: 64 }).notNull(),
  attempts: int("attempts").default(0).notNull(),
  nextAttemptAt: timestamp("next_attempt_at").notNull(),
  firstAttemptAt: timestamp("first_attempt_at"),
  deliveredAt: timestamp("delivered_at"),
  deadLetterAt: timestamp("dead_letter_at"),
  lastErrorCode: varchar("last_error_code", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  taskRevisionIdx: uniqueIndex("uq_task_outbox_task_revision").on(table.taskId, table.stateRevision),
  dueIdx: index("idx_task_outbox_due").on(table.nextAttemptAt, table.deliveredAt, table.deadLetterAt),
}));

export type TaskOutboxEvent = typeof taskOutboxEvents.$inferSelect;

export const tiangongProviderIdentity = mysqlTable("tiangong_provider_identity", {
  providerInstanceId: varchar("provider_instance_id", { length: 64 }).primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const tiangongArtifactLimits = mysqlTable("tiangong_artifact_limits", {
  id: serial("id").primaryKey(),
  principalKey: varchar("principal_key", { length: 255 }).notNull(),
  workspaceSlug: varchar("workspace_slug", { length: 100 }).notNull(),
  storageQuotaBytes: bigint("storage_quota_bytes", { mode: "number", unsigned: true }).notNull(),
  retentionSeconds: int("retention_seconds").notNull(),
  gcGraceSeconds: int("gc_grace_seconds").notNull(),
  gcReaperConcurrency: int("gc_reaper_concurrency").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  scopeIdx: uniqueIndex("uq_tiangong_artifact_limits_scope").on(table.principalKey, table.workspaceSlug),
}));

export const stagedObjects = mysqlTable("staged_objects", {
  stageId: varchar("stage_id", { length: 128 }).primaryKey(),
  expectedSha256: varchar("expected_sha256", { length: 64 }).notNull(),
  expectedSize: bigint("expected_size", { mode: "number", unsigned: true }).notNull(),
  expectedMime: varchar("expected_mime", { length: 255 }).notNull(),
  generationId: int("generation_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  ownerPrincipal: varchar("owner_principal", { length: 255 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  state: mysqlEnum("state", ["staging", "verified", "sealed", "abandoned"]).default("staging").notNull(),
});

export const sealedArtifactDescriptors = mysqlTable("sealed_artifact_descriptors", {
  id: serial("id").primaryKey(),
  artifactUuid: varchar("artifact_uuid", { length: 36 }).notNull(),
  taskId: bigint("task_id", { mode: "number", unsigned: true }).notNull(),
  taskPublicId: varchar("task_public_id", { length: 20 }).notNull(),
  externalRef: varchar("external_ref", { length: 255 }).notNull(),
  taskRevision: bigint("task_revision", { mode: "number", unsigned: true }).notNull(),
  creatorAgentId: bigint("creator_agent_id", { mode: "number", unsigned: true }),
  ownerPrincipal: varchar("owner_principal", { length: 255 }).notNull(),
  workspaceSlug: varchar("workspace_slug", { length: 100 }).notNull(),
  projectSlug: varchar("project_slug", { length: 100 }).notNull(),
  providerInstanceId: varchar("provider_instance_id", { length: 64 }).notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  generationId: int("generation_id").notNull(),
  size: bigint("size", { mode: "number", unsigned: true }).notNull(),
  mime: varchar("mime", { length: 255 }).notNull(),
  storedPath: varchar("stored_path", { length: 500 }).notNull(),
  sealedAt: timestamp("sealed_at").notNull(),
  retainUntil: timestamp("retain_until").notNull(),
}, (table) => ({
  taskArtifactIdx: uniqueIndex("uq_sealed_artifact_task_uuid").on(table.taskId, table.artifactUuid),
  taskRevisionIdx: index("idx_sealed_artifact_task_revision").on(table.taskId, table.taskRevision),
}));

export const sealedArtifactManifests = mysqlTable("sealed_artifact_manifests", {
  id: serial("id").primaryKey(),
  taskId: bigint("task_id", { mode: "number", unsigned: true }).notNull().unique(),
  taskPublicId: varchar("task_public_id", { length: 20 }).notNull(),
  externalRef: varchar("external_ref", { length: 255 }).notNull(),
  taskRevision: bigint("task_revision", { mode: "number", unsigned: true }).notNull(),
  providerInstanceId: varchar("provider_instance_id", { length: 64 }).notNull(),
  manifestIdentity: varchar("manifest_identity", { length: 64 }).notNull().unique(),
  canonicalManifest: text("canonical_manifest").notNull(),
  sealedAt: timestamp("sealed_at").notNull(),
});

// ─── Messages (P8.1: reliable message bus) ───
export const messages = mysqlTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    fromAgent: bigint("from_agent", { mode: "number", unsigned: true }).notNull(),
    toAgent: bigint("to_agent", { mode: "number", unsigned: true }).notNull(),
    content: text("content").notNull(),
    type: mysqlEnum("type", ["command", "response", "broadcast", "system", "ack"]).default("command").notNull(),
    status: mysqlEnum("status", ["sent", "delivered", "read", "acked", "expired"]).default("sent").notNull(),
    readAt: timestamp("read_at"),
    conversationId: bigint("conversation_id", { mode: "number", unsigned: true }),

    // ── P8.1: reliable message bus fields ──
    /** Links messages across a logical conversation/transaction. */
    correlationId: varchar("correlation_id", { length: 64 }),
    /** Sender-defined key for idempotent send. Unique per fromAgent. */
    idempotencyKey: varchar("idempotency_key", { length: 128 }),
    /** Task this message is associated with (nullable for non-task messages). */
    taskId: bigint("task_id", { mode: "number", unsigned: true }),
    /** Parent message in a reply chain. */
    parentMessageId: bigint("parent_message_id", { mode: "number", unsigned: true }),
    /** TTL – message expires if not delivered by this time. */
    expiresAt: timestamp("expires_at"),
    /** When the recipient acknowledged receipt. */
    ackedAt: timestamp("acked_at"),
    /** When the message was actually pushed to the recipient (WS). */
    deliveredAt: timestamp("delivered_at"),
    /** Number of delivery retry attempts. */
    retryCount: int("retry_count").default(0).notNull(),
    /** Priority (higher = more urgent). Default 0. */
    priority: int("priority").default(0).notNull(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    // Idempotency: same fromAgent + idempotencyKey → same message
    idempotencyIdx: uniqueIndex("uq_messages_idempotency").on(
      table.fromAgent,
      table.idempotencyKey
    ),
  })
);

export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;

// ─── Systems (external integrations) ───
export const systems = mysqlTable("systems", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 50 }).notNull(),
  slug: varchar("slug", { length: 20 }).notNull().unique(),
  status: mysqlEnum("status", ["connected", "syncing", "disconnected"]).default("disconnected").notNull(),
  config: text("config"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type System = typeof systems.$inferSelect;
export type InsertSystem = typeof systems.$inferInsert;

// ─── Organizations ───
export const organizations = mysqlTable("organizations", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  goals: text("goals"),
  budget: int("budget_cents").default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Organization = typeof organizations.$inferSelect;
export type InsertOrganization = typeof organizations.$inferInsert;

// ─── Departments ───
export const departments = mysqlTable("departments", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  orgId: bigint("org_id", { mode: "number" }).notNull(),
  leadAgentId: bigint("lead_agent_id", { mode: "number" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Department = typeof departments.$inferSelect;
export type InsertDepartment = typeof departments.$inferInsert;

// ─── Task Dependencies (DAG edges) ───
export const taskDependencies = mysqlTable("task_dependencies", {
  id: serial("id").primaryKey(),
  taskId: bigint("task_id", { mode: "number" }).notNull(),
  dependsOnTaskId: bigint("depends_on_task_id", { mode: "number" }).notNull(),
});

export type TaskDependency = typeof taskDependencies.$inferSelect;
export type InsertTaskDependency = typeof taskDependencies.$inferInsert;

// ─── MCP API Keys ───
export const mcpApiKeys = mysqlTable("mcp_api_keys", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  agentId: bigint("agent_id", { mode: "number" }),
  name: varchar("name", { length: 100 }),
  permissions: text("permissions"),
  rateLimit: int("rate_limit").default(10),
  active: mysqlEnum("active", ["true", "false"]).default("true"),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type McpApiKey = typeof mcpApiKeys.$inferSelect;
export type InsertMcpApiKey = typeof mcpApiKeys.$inferInsert;

// ─── Beidou service keys (verifier-only, Todo 20) ───
// Directional keyring: Beidou-to-Tiangong service credentials (this table) are
// independent from the Tiangong-to-Beidou callback HMAC keyring (Todo 22).
// The plaintext token is NEVER stored here — only the full 32-byte
// HMAC-SHA-256(server_pepper, token) verifier plus the key_id and a 6-byte
// key-id prefix. The server pepper is a deployment secret (env/vault).
export const tiangongServiceKeys = mysqlTable(
  "tiangong_service_keys",
  {
    id: serial("id").primaryKey(),
    // Public key identifier: "tgsk_<base64url(16 random bytes)>".
    keyId: varchar("key_id", { length: 64 }).notNull().unique(),
    // 32-byte HMAC-SHA-256(server_pepper, token), hex (64 chars). Verifier only.
    verifier: varchar("verifier", { length: 64 }).notNull(),
    // One-way-redacted 6-byte prefix of the token (base64url, 8 chars).
    keyPrefix: varchar("key_prefix", { length: 12 }).notNull(),
    // Service principal binding: origin system is fixed to "beidou"; the key
    // is scoped to exactly one workspace + project (no wildcard scope).
    originSystem: varchar("origin_system", { length: 32 }).notNull().default("beidou"),
    workspaceSlug: varchar("workspace_slug", { length: 100 }).notNull(),
    projectSlug: varchar("project_slug", { length: 100 }).notNull(),
    // Least-privilege allowlist, JSON array of BeidouServiceScope values.
    scopes: text("scopes").notNull(),
    issuedAt: timestamp("issued_at").notNull(),
    // Rotation: previous key remains valid through the overlap retention
    // window (max callback retry window), then is lazily revoked.
    rotationWindowEnd: timestamp("rotation_window_end"),
    revokedAt: timestamp("revoked_at"),
    revokedReason: varchar("revoked_reason", { length: 100 }),
    version: int("version").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    keyIdIdx: uniqueIndex("uq_tiangong_service_keys_key_id").on(table.keyId),
  })
);

export type TiangongServiceKey = typeof tiangongServiceKeys.$inferSelect;
export type InsertTiangongServiceKey = typeof tiangongServiceKeys.$inferInsert;

// ─── Beidou service key auth audit (Todo 20) ───
// Every auth decision is audit-logged with key_id, originSystem and a
// one-way-redacted token prefix only — never the token or verifier.
export const serviceKeyAuditLog = mysqlTable("service_key_audit_log", {
  id: serial("id").primaryKey(),
  keyId: varchar("key_id", { length: 64 }),
  originSystem: varchar("origin_system", { length: 32 }),
  tokenPrefix: varchar("token_prefix", { length: 12 }),
  decision: mysqlEnum("decision", ["authenticated", "denied"]).notNull(),
  reason: varchar("reason", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ServiceKeyAuditEntry = typeof serviceKeyAuditLog.$inferSelect;
export type InsertServiceKeyAuditEntry = typeof serviceKeyAuditLog.$inferInsert;

// ─── MCP Audit Log ───
export const mcpAuditLog = mysqlTable("mcp_audit_log", {
  id: serial("id").primaryKey(),
  keyId: bigint("key_id", { mode: "number" }),
  tool: varchar("tool", { length: 100 }),
  params: text("params"),
  result: varchar("result", { length: 20 }),
  error: text("error"),
  durationMs: int("duration_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type McpAuditLogEntry = typeof mcpAuditLog.$inferSelect;
export type InsertMcpAuditLogEntry = typeof mcpAuditLog.$inferInsert;

// ─── P13: Model Pricing ───
export const modelPricing = mysqlTable("model_pricing", {
  model: varchar("model", { length: 100 }).primaryKey(),
  provider: varchar("provider", { length: 50 }).default("unknown"),
  inputPrice: decimal("input_price", { precision: 10, scale: 8 }).notNull().default("0"),
  outputPrice: decimal("output_price", { precision: 10, scale: 8 }).notNull().default("0"),
  cachedInputPrice: decimal("cached_input_price", { precision: 10, scale: 8 }),
  currency: varchar("currency", { length: 3 }).default("USD"),
  notes: text("notes"),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type ModelPricing = typeof modelPricing.$inferSelect;
export type InsertModelPricing = typeof modelPricing.$inferInsert;

// ─── Token Usage (P9: 用量监测 + P13: 缓存区分) ───
export const tokenUsage = mysqlTable("token_usage", {
  id: serial("id").primaryKey(),
  model: varchar("model", { length: 100 }).notNull(),
  provider: varchar("provider", { length: 50 }).default("unknown"),
  promptTokens: int("prompt_tokens").default(0).notNull(),
  completionTokens: int("completion_tokens").default(0).notNull(),
  totalTokens: int("total_tokens").default(0).notNull(),
  // P13: cache split
  cachedPromptTokens: int("cached_prompt_tokens").default(0),
  uncachedPromptTokens: int("uncached_prompt_tokens").default(0),
  callCount: int("call_count").default(1).notNull(),
  costCents: int("cost_cents").default(0).notNull(),
  // P13: currency + exchange
  currency: varchar("currency", { length: 3 }).default("USD"),
  exchangeRate: decimal("exchange_rate", { precision: 10, scale: 6 }).default("1.0"),
  costDisplay: decimal("cost_display", { precision: 12, scale: 4 }).default("0"),
  taskId: bigint("task_id", { mode: "number", unsigned: true }),
  agentId: bigint("agent_id", { mode: "number", unsigned: true }),
  // Phase 1: 审计增强字段
  sessionKey: varchar("session_key", { length: 128 }),
  source: varchar("source", { length: 20 }).default("manual"),
  traceId: varchar("trace_id", { length: 64 }),
  startedAt: timestamp("started_at"),
  // Phase 2: 高价模型标记
  highCostModel: mysqlEnum("high_cost_model", ["true", "false"]).default("false"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type TokenUsage = typeof tokenUsage.$inferSelect;
export type InsertTokenUsage = typeof tokenUsage.$inferInsert;

// ─── Phase 2: 模型白名单 ───
export const modelAllowlist = mysqlTable("model_allowlist", {
  id: serial("id").primaryKey(),
  agentId: bigint("agent_id", { mode: "number", unsigned: true }).notNull(),
  model: varchar("model", { length: 100 }).notNull(),
  reason: text("reason"),
  createdBy: varchar("created_by", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type ModelAllowlist = typeof modelAllowlist.$inferSelect;
export type InsertModelAllowlist = typeof modelAllowlist.$inferInsert;

// ─── Phase 2: 高价模型授权 ───
export const highCostModelAuth = mysqlTable("high_cost_model_auth", {
  id: serial("id").primaryKey(),
  agentId: bigint("agent_id", { mode: "number", unsigned: true }).notNull(),
  model: varchar("model", { length: 100 }).notNull(),
  reason: text("reason").notNull(),
  authorizedBy: varchar("authorized_by", { length: 50 }).notNull(),
  expiresAt: timestamp("expires_at"),
  active: mysqlEnum("active", ["true", "false"]).default("true"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type HighCostModelAuth = typeof highCostModelAuth.$inferSelect;
export type InsertHighCostModelAuth = typeof highCostModelAuth.$inferInsert;

// ─── P11: GitHub App Integration ───
export const githubIntegrations = mysqlTable("github_integrations", {
  id: serial("id").primaryKey(),
  appId: varchar("app_id", { length: 20 }),
  installationId: varchar("installation_id", { length: 20 }),
  owner: varchar("owner", { length: 100 }),
  active: mysqlEnum("active", ["true", "false"]).default("true"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type GithubIntegration = typeof githubIntegrations.$inferSelect;
export type InsertGithubIntegration = typeof githubIntegrations.$inferInsert;

export const githubRepos = mysqlTable("github_repos", {
  id: serial("id").primaryKey(),
  owner: varchar("owner", { length: 100 }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  fullName: varchar("full_name", { length: 255 }).notNull(),
  defaultBranch: varchar("default_branch", { length: 100 }).default("main"),
  installationId: bigint("installation_id", { mode: "number", unsigned: true }),
  active: mysqlEnum("active", ["true", "false"]).default("true"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type GithubRepo = typeof githubRepos.$inferSelect;
export type InsertGithubRepo = typeof githubRepos.$inferInsert;

export const githubRepoPermissions = mysqlTable("github_repo_permissions", {
  id: serial("id").primaryKey(),
  agentId: bigint("agent_id", { mode: "number", unsigned: true }).notNull(),
  repoId: bigint("repo_id", { mode: "number", unsigned: true }).notNull(),
  permissionLevel: mysqlEnum("permission_level", ["read", "push", "admin"]).default("read").notNull(),
  active: mysqlEnum("active", ["true", "false"]).default("true"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type GithubRepoPermission = typeof githubRepoPermissions.$inferSelect;
export type InsertGithubRepoPermission = typeof githubRepoPermissions.$inferInsert;

export const githubPullRequests = mysqlTable("github_pull_requests", {
  id: serial("id").primaryKey(),
  repoId: bigint("repo_id", { mode: "number", unsigned: true }).notNull(),
  prNumber: int("pr_number").notNull(),
  title: varchar("title", { length: 500 }).notNull(),
  body: text("body"),
  branchName: varchar("branch_name", { length: 255 }),
  baseBranch: varchar("base_branch", { length: 255 }),
  headSha: varchar("head_sha", { length: 40 }),
  authorAgentId: bigint("author_agent_id", { mode: "number", unsigned: true }),
  status: mysqlEnum("status", ["pending", "approved", "rejected", "merged", "closed"]).default("pending").notNull(),
  approvedBy: bigint("approved_by", { mode: "number", unsigned: true }),
  approvedAt: timestamp("approved_at"),
  mergedAt: timestamp("merged_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type GithubPullRequest = typeof githubPullRequests.$inferSelect;
export type InsertGithubPullRequest = typeof githubPullRequests.$inferInsert;

export const githubAuditLog = mysqlTable("github_audit_log", {
  id: serial("id").primaryKey(),
  prId: bigint("pr_id", { mode: "number", unsigned: true }),
  action: mysqlEnum("action", ["approve", "reject", "merge", "register", "revoke"]).notNull(),
  agentId: bigint("agent_id", { mode: "number", unsigned: true }),
  reason: text("reason"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type GithubAuditLogEntry = typeof githubAuditLog.$inferSelect;
export type InsertGithubAuditLogEntry = typeof githubAuditLog.$inferInsert;

// ─── Conversations (任务记事板) ───
export const conversations = mysqlTable("conversations", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  type: mysqlEnum("type", ["mission", "meeting", "test", "ad_hoc"]).default("ad_hoc").notNull(),
  status: mysqlEnum("status", ["active", "archived"]).default("active").notNull(),
  participants: text("participants"),
  summary: text("summary"),
  createdBy: bigint("created_by", { mode: "number", unsigned: true }),
  archivedAt: timestamp("archived_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;

// ─── A2A-lite v0.1: Task Threads ───
export const taskThreads = mysqlTable("task_threads", {
  id: serial("id").primaryKey(),
  taskId: bigint("task_id", { mode: "number", unsigned: true }).notNull(),
  title: varchar("title", { length: 255 }),
  status: mysqlEnum("status", ["open", "closed", "archived"]).default("open").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type TaskThread = typeof taskThreads.$inferSelect;
export type InsertTaskThread = typeof taskThreads.$inferInsert;

// ─── A2A-lite v0.1: Task Messages (thread events) ───
export const taskMessages = mysqlTable("task_messages", {
  id: serial("id").primaryKey(),
  taskId: bigint("task_id", { mode: "number", unsigned: true }).notNull(),
  threadId: bigint("thread_id", { mode: "number", unsigned: true }),
  fromAgentId: bigint("from_agent_id", { mode: "number", unsigned: true }),
  toAgentId: bigint("to_agent_id", { mode: "number", unsigned: true }),
  eventType: mysqlEnum("event_type", [
    "dispatch",
    "ack",
    "progress",
    "working",
    "result",
    "error",
    "timeout",
    "cancel",
    "system",
  ]).default("system").notNull(),
  content: text("content"),
  metadata: text("metadata"), // JSON
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type TaskMessage = typeof taskMessages.$inferSelect;
export type InsertTaskMessage = typeof taskMessages.$inferInsert;

// ─── A2A-lite v0.1: Mailbox Messages (agent-addressed message bus) ───
export const mailboxMessages = mysqlTable("mailbox_messages", {
  id: serial("id").primaryKey(),
  taskId: bigint("task_id", { mode: "number", unsigned: true }),
  threadId: bigint("thread_id", { mode: "number", unsigned: true }),
  fromAgentId: bigint("from_agent_id", { mode: "number", unsigned: true }),
  fromMailboxId: varchar("from_mailbox_id", { length: 20 }).notNull(),
  toAgentId: bigint("to_agent_id", { mode: "number", unsigned: true }).notNull(),
  toMailboxId: varchar("to_mailbox_id", { length: 20 }).notNull(),
  type: mysqlEnum("mailbox_type", [
    "direct",
    "mention",
    "question",
    "review_request",
    "subtask",
    "handoff",
    "result_notice",
  ]).default("direct").notNull(),
  status: mysqlEnum("mailbox_status", [
    "unread",
    "acknowledged",
    "working",
    "replied",
    "resolved",
    "failed",
  ]).default("unread").notNull(),
  subject: varchar("subject", { length: 255 }),
  body: text("body"),
  payloadJson: text("payload_json"),
  replyToMessageId: bigint("reply_to_message_id", { mode: "number", unsigned: true }),
  artifactId: bigint("artifact_id", { mode: "number", unsigned: true }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  acknowledgedAt: timestamp("acknowledged_at"),
  repliedAt: timestamp("replied_at"),
  resolvedAt: timestamp("resolved_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type MailboxMessage = typeof mailboxMessages.$inferSelect;
export type InsertMailboxMessage = typeof mailboxMessages.$inferInsert;

// ─── A2A-lite v0.1: Task Artifacts ───
export const taskArtifacts = mysqlTable("task_artifacts", {
  id: serial("id").primaryKey(),
  taskId: bigint("task_id", { mode: "number", unsigned: true }).notNull(),
  agentId: bigint("agent_id", { mode: "number", unsigned: true }),
  type: varchar("type", { length: 50 }).notNull(),
  name: varchar("name", { length: 255 }),
  content: text("content"),
  jsonPayload: text("json_payload"),
  mimeType: varchar("mime_type", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type TaskArtifact = typeof taskArtifacts.$inferSelect;
export type InsertTaskArtifact = typeof taskArtifacts.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// 天宫 Phase 1: Workspace / Project / Membership identity foundation
// ═══════════════════════════════════════════════════════════════

// ─── Workspaces ───
export const workspaces = mysqlTable("workspaces", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  description: text("description"),
  ownerId: bigint("owner_id", { mode: "number", unsigned: true }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Workspace = typeof workspaces.$inferSelect;
export type InsertWorkspace = typeof workspaces.$inferInsert;

// ─── Projects ───
export const projects = mysqlTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    workspaceId: bigint("workspace_id", { mode: "number", unsigned: true }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    description: text("description"),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    workspaceSlugIdx: uniqueIndex("uq_projects_workspace_slug").on(table.workspaceId, table.slug),
  })
);

export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

// ─── Workspace Memberships ───
export const workspaceMemberships = mysqlTable(
  "workspace_memberships",
  {
    id: serial("id").primaryKey(),
    workspaceId: bigint("workspace_id", { mode: "number", unsigned: true }).notNull(),
    userId: bigint("user_id", { mode: "number", unsigned: true }).notNull(),
    role: mysqlEnum("role", ["owner", "admin", "member", "viewer"]).default("member").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    membershipIdx: uniqueIndex("uq_workspace_memberships").on(table.workspaceId, table.userId),
  })
);

export type WorkspaceMembership = typeof workspaceMemberships.$inferSelect;
export type InsertWorkspaceMembership = typeof workspaceMemberships.$inferInsert;

// ─── Phase 1: Secret Vault (encrypted write-only references) ───
export const secretVaultItems = mysqlTable(
  "secret_vault_items",
  {
    id: serial("id").primaryKey(),
    workspaceId: bigint("workspace_id", { mode: "number", unsigned: true }).notNull(),
    projectId: bigint("project_id", { mode: "number", unsigned: true }).notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    description: text("description"),
    algorithm: varchar("algorithm", { length: 20 }).notNull(),
    keyId: varchar("key_id", { length: 100 }).notNull(),
    envelopeVersion: varchar("envelope_version", { length: 10 }).notNull(),
    nonce: text("nonce").notNull(),
    authTag: text("auth_tag").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }).notNull(),
    updatedBy: bigint("updated_by", { mode: "number", unsigned: true }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    projectNameIdx: uniqueIndex("uq_secret_vault_items_project_name").on(
      table.workspaceId,
      table.projectId,
      table.name
    ),
  })
);

export type SecretVaultItem = typeof secretVaultItems.$inferSelect;
export type InsertSecretVaultItem = typeof secretVaultItems.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// 天宫 Phase 1: General audit/event ledger
// ═══════════════════════════════════════════════════════════════

export const auditEvents = mysqlTable(
  "audit_events",
  {
    id: serial("id").primaryKey(),
    event: varchar("event", { length: 50 }).notNull(),
    actorUserId: bigint("actor_user_id", { mode: "number", unsigned: true }).notNull(),
    workspaceId: bigint("workspace_id", { mode: "number", unsigned: true }),
    projectId: bigint("project_id", { mode: "number", unsigned: true }),
    targetUserId: bigint("target_user_id", { mode: "number", unsigned: true }),
    entityType: varchar("entity_type", { length: 50 }).notNull(),
    entityId: bigint("entity_id", { mode: "number", unsigned: true }),
    metadata: text("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    // ── Audit hash chain (block-style hardening) ──
    // sha256 hex of the previous chained row; NULL for pre-chain legacy rows.
    prevHash: varchar("prev_hash", { length: 64 }),
    // sha256 hex over [prevHash, event, actorUserId, entityType, entityId,
    // metadataJson, createdAt]; NULL for pre-chain legacy rows.
    hash: varchar("hash", { length: 64 }),
  },
  (table) => ({
    // Chain walk + unified event stream order by time; non-unique by design.
    createdAtIdx: index("idx_audit_events_created_at").on(table.createdAt),
  })
);

export type AuditEvent = typeof auditEvents.$inferSelect;
export type InsertAuditEvent = typeof auditEvents.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// 天宫 Phase 1: Adapter/Connector registry foundation
// ═══════════════════════════════════════════════════════════════

export const connectorRegistry = mysqlTable(
  "connector_registry",
  {
    id: serial("id").primaryKey(),
    workspaceId: bigint("workspace_id", { mode: "number", unsigned: true }).notNull(),
    projectId: bigint("project_id", { mode: "number", unsigned: true }),
    name: varchar("name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    connectorType: mysqlEnum("connector_type", ["opencode", "xuanji", "s3"]).notNull(),
    status: mysqlEnum("status", ["draft", "active", "disabled"]).default("draft").notNull(),
    endpoint: varchar("endpoint", { length: 500 }),
    config: text("config"), // JSON: non-secret configuration only
    secretRefId: bigint("secret_ref_id", { mode: "number", unsigned: true }),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }).notNull(),
    updatedBy: bigint("updated_by", { mode: "number", unsigned: true }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    workspaceProjectSlugIdx: uniqueIndex("uq_connector_registry_workspace_project_slug").on(
      table.workspaceId,
      table.projectId,
      table.slug
    ),
  })
);

export type ConnectorRegistry = typeof connectorRegistry.$inferSelect;
export type InsertConnectorRegistry = typeof connectorRegistry.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// 天宫 Phase 1: Artifact/object metadata abstraction
// ═══════════════════════════════════════════════════════════════

export const artifactRegistry = mysqlTable(
  "artifact_registry",
  {
    id: serial("id").primaryKey(),
    workspaceId: bigint("workspace_id", { mode: "number", unsigned: true }).notNull(),
    projectId: bigint("project_id", { mode: "number", unsigned: true }),
    taskId: bigint("task_id", { mode: "number", unsigned: true }),
    name: varchar("name", { length: 255 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    artifactType: mysqlEnum("artifact_type", ["file", "image", "document", "log", "data"]).notNull(),
    status: mysqlEnum("status", ["draft", "active", "archived", "deleted"]).default("draft").notNull(),
    mimeType: varchar("mime_type", { length: 100 }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    checksumSha256: varchar("checksum_sha256", { length: 64 }),
    storageBackrefType: mysqlEnum("storage_backref_type", ["connector", "inline", "external"]),
    storageBackrefId: varchar("storage_backref_id", { length: 100 }),
    metadata: text("metadata"), // JSON: safe, non-secret metadata only
    createdBy: bigint("created_by", { mode: "number", unsigned: true }).notNull(),
    updatedBy: bigint("updated_by", { mode: "number", unsigned: true }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    workspaceProjectSlugIdx: uniqueIndex("uq_artifact_registry_workspace_project_slug").on(
      table.workspaceId,
      table.projectId,
      table.slug
    ),
  })
);

export type ArtifactRegistry = typeof artifactRegistry.$inferSelect;
export type InsertArtifactRegistry = typeof artifactRegistry.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// 天宫 Phase 3: 上下文共享 + 跨平台接入 + 记忆系统
// ═══════════════════════════════════════════════════════════════

// ─── Shared Sessions: 多 Agent 共享会话 ───
export const sharedSessions = mysqlTable("shared_sessions", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 255 }).notNull(),
  sessionKey: varchar("session_key", { length: 100 }).notNull().unique(),
  type: mysqlEnum("type", ["collaboration", "handoff", "meeting", "review", "adhoc"]).default("adhoc").notNull(),
  status: mysqlEnum("status", ["active", "archived"]).default("active").notNull(),
  participants: text("participants"), // JSON array of agent IDs
  summary: text("summary"), // 会话摘要
  context: text("context"), // 上下文快照（JSON）
  createdBy: bigint("created_by", { mode: "number", unsigned: true }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type SharedSession = typeof sharedSessions.$inferSelect;
export type InsertSharedSession = typeof sharedSessions.$inferInsert;

// ─── Session Messages: 会话消息历史 ───
export const sessionMessages = mysqlTable("session_messages", {
  id: serial("id").primaryKey(),
  sessionId: bigint("session_id", { mode: "number", unsigned: true }).notNull(),
  fromAgentId: bigint("from_agent_id", { mode: "number", unsigned: true }),
  toAgentId: bigint("to_agent_id", { mode: "number", unsigned: true }),
  role: mysqlEnum("role", ["user", "assistant", "system"]).default("assistant").notNull(),
  content: text("content").notNull(),
  metadata: text("metadata"), // JSON
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type SessionMessage = typeof sessionMessages.$inferSelect;
export type InsertSessionMessage = typeof sessionMessages.$inferInsert;

// ─── Agent Memories: Agent 长期记忆 ───
export const agentMemories = mysqlTable("agent_memories", {
  id: serial("id").primaryKey(),
  agentId: bigint("agent_id", { mode: "number", unsigned: true }).notNull(),
  key: varchar("key", { length: 100 }).notNull(),
  value: text("value").notNull(),
  type: mysqlEnum("type", ["personal", "shared", "company"]).default("personal").notNull(),
  tags: varchar("tags", { length: 500 }), // 逗号分隔
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  agentKeyIdx: uniqueIndex("uq_agent_memories_key").on(table.agentId, table.key),
}));

export type AgentMemory = typeof agentMemories.$inferSelect;
export type InsertAgentMemory = typeof agentMemories.$inferInsert;

// ─── External Agents: 外部 Agent 注册 ───
export const externalAgents = mysqlTable("external_agents", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  platform: mysqlEnum("platform", ["hermes", "opencode", "codex", "arkclaw", "openai", "custom"]).notNull(),
  endpoint: varchar("endpoint", { length: 500 }),
  apiKey: varchar("api_key", { length: 500 }),
  model: varchar("model", { length: 100 }),
  status: mysqlEnum("status", ["online", "offline", "error"]).default("offline").notNull(),
  capabilities: text("capabilities"), // JSON
  config: text("config"), // JSON: 平台特定配置
  lastHeartbeat: timestamp("last_heartbeat"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type ExternalAgent = typeof externalAgents.$inferSelect;
export type InsertExternalAgent = typeof externalAgents.$inferInsert;
