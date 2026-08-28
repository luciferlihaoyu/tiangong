import { text, uniqueIndex, index, sqliteTable, integer, int, real, blob, primaryKey, foreignKey } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

// ─── Users (内置认证) ───
export const users = sqliteTable("users", {
  id: integer("id", { mode: "number" }).primaryKey(),
  username: text("username", { length: 50 }).notNull().unique(),
  passwordHash: text("password_hash", { length: 255 }).notNull(),
  name: text("name", { length: 255 }),
  email: text("email", { length: 320 }),
  role: text("role", { enum: ["user", "admin"] }).default("user").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
  lastSignInAt: integer("last_sign_in_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Agents ───
export const agents = sqliteTable("agents", {
  id: integer("id", { mode: "number" }).primaryKey(),
  agentId: text("agent_id", { length: 64 }).notNull().unique(),
  name: text("name", { length: 50 }).notNull(),
  system: text("system", { length: 30 }).notNull(),
  status: text("status", { enum: ["online", "busy", "idle"] }).default("idle").notNull(),
  task: text("task", { length: 255 }),
  progress: integer("progress", { mode: "number" }).default(0).notNull(),
  messagesCount: integer("messages_count", { mode: "number" }).default(0).notNull(),
  description: text("description"),
  createdBy: integer("created_by", {mode: "number"}),
  // New fields for multi-agent collaboration
  source: text("source", { length: 50 }).default("custom"),
  model: text("model", { length: 100 }),
  role: text("role", { length: 100 }),
  manages: text("manages"),
  reportsTo: integer("reports_to", {mode: "number"}),
  orgId: integer("org_id", {mode: "number"}),
  departmentId: integer("department_id", {mode: "number"}),
  currentTask: text("current_task"),
  capabilities: text("capabilities"),
  budgetCents: integer("budget_cents", { mode: "number" }).default(0),
  spentCents: integer("spent_cents", { mode: "number" }).default(0),
  lastHeartbeat: integer("last_heartbeat", { mode: "timestamp" }),
  sourceApiKey: text("source_api_key", { length: 255 }),
  sourceEndpoint: text("source_endpoint", { length: 500 }),
  // ── A2A-lite v0.1: Agent Card extensibility ──
  agentCard: text("agent_card"),
  openclawAgent: text("openclaw_agent", { length: 100 }),
  canModifyTiangongCore: text("can_modify_tiangong_core", { enum: ["true", "false"] }).default("false"),
  canSendExternalMessage: text("can_send_external_message", { enum: ["true", "false"] }).default("false"),
  mcpToken: text("mcp_token", { length: 100 }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
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
export const tasks = sqliteTable("tasks", {
  id: integer("id", { mode: "number" }).primaryKey(),
  taskId: text("task_id", { length: 20 }).notNull().unique(),
  name: text("name", { length: 255 }).notNull(),
  agentId: integer("agent_id", {mode: "number"}),
  status: text("status", { enum: ["running", "pending", "done", "failed", "queued"] }).default("pending").notNull(),
  progress: integer("progress", { mode: "number" }).default(0).notNull(),
  description: text("description"),
  // New orchestration fields
  priority: integer("priority", { mode: "number" }).default(0),
  input: text("input"),
  output: text("output"),
  error: text("error"),
  retryCount: integer("retry_count", { mode: "number" }).default(0),
  maxRetries: integer("max_retries", { mode: "number" }).default(3),
  timeoutMs: integer("timeout_ms", { mode: "number" }).default(300000),
  parentTaskId: integer("parent_task_id", {mode: "number"}),
  // 输出格式校验
  expectedOutputSchema: text("expected_output_schema"),
  outputValid: text("output_valid", { enum: ["true", "false", "unknown"] }).default("unknown"),
  // ── A2A-lite v0.1: lifecycle status machine ──
  lifecycleStatus: text("lifecycle_status", { length: 30 }).default("created"),
  dispatcherAgentId: integer("dispatcher_agent_id", {mode: "number"}),
  claimedAt: integer("claimed_at", { mode: "timestamp" }),
  dispatchedAt: integer("dispatched_at", { mode: "timestamp" }),
  acceptedAt: integer("accepted_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  failedAt: integer("failed_at", { mode: "timestamp" }),
  timeoutAt: integer("timeout_at", { mode: "timestamp" }),
  // ── Phase 2: Taskboard status machine ──
  boardStatus: text("board_status", { length: 20 }).default("triage"),
  boardLabels: text("board_labels"), // JSON array of strings
  boardNotes: text("board_notes"),
  sourceUrl: text("source_url", { length: 500 }),
  lastHeartbeatAt: integer("last_heartbeat_at", { mode: "timestamp" }),
  heartbeatIntervalMs: integer("heartbeat_interval_ms", { mode: "number" }).default(300000),
  workerLeaseToken: text("worker_lease_token", { length: 64 }),
  workerLeaseGeneration: integer("worker_lease_generation", { mode: "number" }).default(0).notNull(),
  workerLeaseExpiresAt: integer("worker_lease_expires_at", { mode: "timestamp" }),
  cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp" }),
  cancelAcknowledgedAt: integer("cancel_acknowledged_at", { mode: "timestamp" }),
  reviewerId: integer("reviewer_id", {mode: "number"}),
  reviewResult: text("review_result", { length: 30 }),
  triagedAt: integer("triaged_at", { mode: "timestamp" }),
  backloggedAt: integer("backlogged_at", { mode: "timestamp" }),
  readyAt: integer("ready_at", { mode: "timestamp" }),
  reviewAt: integer("review_at", { mode: "timestamp" }),
  blockedAt: integer("blocked_at", { mode: "timestamp" }),
  originSystem: text("origin_system", { length: 32 }),
  externalRef: text("external_ref", { length: 255 }),
  idempotencyKey: text("idempotency_key", { length: 128 }),
  canonicalRequestHash: text("canonical_request_hash", { length: 64 }),
  canonicalRequestHashVersion: text("canonical_request_hash_version", { length: 32 }),
  stateRevision: integer("state_revision", {mode: "number"}).default(1).notNull(),
  taskRetainUntil: integer("task_retain_until", { mode: "timestamp" }),
  idempotencyRetainUntil: integer("idempotency_retain_until", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  externalRefIdx: uniqueIndex("uq_tasks_origin_external_ref").on(table.originSystem, table.externalRef),
  idempotencyKeyIdx: uniqueIndex("uq_tasks_origin_idempotency_key").on(table.originSystem, table.idempotencyKey),
}));

export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

export const tiangongTaskLimits = sqliteTable("tiangong_task_limits", {
  id: integer("id", { mode: "number" }).primaryKey(),
  principalKey: text("principal_key", { length: 255 }).notNull(),
  workspaceSlug: text("workspace_slug", { length: 100 }).notNull(),
  maxConcurrentTasks: integer("max_concurrent_tasks", { mode: "number" }).default(8).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  principalWorkspaceIdx: uniqueIndex("uq_tiangong_task_limits_principal_workspace").on(table.principalKey, table.workspaceSlug),
}));

export const taskExecutionSlots = sqliteTable("task_execution_slots", {
  id: integer("id", { mode: "number" }).primaryKey(),
  taskId: integer("task_id", {mode: "number"}).notNull(),
  principalKey: text("principal_key", { length: 255 }).notNull(),
  workspaceSlug: text("workspace_slug", { length: 100 }).notNull(),
  leaseToken: text("lease_token", { length: 64 }).notNull(),
  acquiredAt: integer("acquired_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
}, (table) => ({
  taskIdx: uniqueIndex("uq_task_execution_slots_task").on(table.taskId),
  scopeIdx: index("idx_task_execution_slots_scope").on(table.principalKey, table.workspaceSlug, table.expiresAt),
}));

export const tiangongWorkerLeases = sqliteTable("tiangong_worker_leases", {
  id: integer("id", { mode: "number" }).primaryKey(),
  leaseToken: text("lease_token", { length: 64 }).notNull().unique(),
  workerId: text("worker_id", { length: 128 }).notNull(),
  principalKey: text("principal_key", { length: 255 }).notNull(),
  workspaceSlug: text("workspace_slug", { length: 100 }).notNull(),
  generation: integer("generation", { mode: "number" }).notNull(),
  issuedAt: integer("issued_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
}, (table) => ({
  workerScopeIdx: index("idx_tiangong_worker_leases_worker_scope").on(table.workerId, table.principalKey, table.workspaceSlug, table.expiresAt),
}));

export const taskOutboxEvents = sqliteTable("task_outbox_events", {
  id: integer("id", { mode: "number" }).primaryKey(),
  eventId: text("event_id", { length: 36 }).notNull().unique(),
  taskId: integer("task_id", {mode: "number"}).notNull(),
  taskPublicId: text("task_public_id", { length: 20 }).notNull(),
  externalRef: text("external_ref", { length: 255 }).notNull(),
  originSystem: text("origin_system", { length: 32 }).notNull(),
  workspaceSlug: text("workspace_slug", { length: 100 }).notNull(),
  projectSlug: text("project_slug", { length: 100 }).notNull(),
  eventType: text("event_type", { enum: ["state", "approval", "terminal"] }).notNull(),
  status: text("status", { length: 30 }).notNull(),
  lifecycleStatus: text("lifecycle_status", { length: 30 }),
  boardStatus: text("board_status", { length: 20 }),
  reviewResult: text("review_result", { length: 30 }),
  stateRevision: integer("state_revision", {mode: "number"}).notNull(),
  traceId: text("trace_id", { length: 64 }).notNull(),
  payloadDigest: text("payload_digest", { length: 64 }).notNull(),
  manifestIdentity: text("manifest_identity", { length: 64 }),
  keyId: text("key_id", { length: 64 }).notNull(),
  attempts: integer("attempts", { mode: "number" }).default(0).notNull(),
  nextAttemptAt: integer("next_attempt_at", { mode: "timestamp" }).notNull(),
  firstAttemptAt: integer("first_attempt_at", { mode: "timestamp" }),
  deliveredAt: integer("delivered_at", { mode: "timestamp" }),
  deadLetterAt: integer("dead_letter_at", { mode: "timestamp" }),
  lastErrorCode: text("last_error_code", { length: 64 }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  taskRevisionIdx: uniqueIndex("uq_task_outbox_task_revision").on(table.taskId, table.stateRevision),
  dueIdx: index("idx_task_outbox_due").on(table.nextAttemptAt, table.deliveredAt, table.deadLetterAt),
}));

export type TaskOutboxEvent = typeof taskOutboxEvents.$inferSelect;

export const tiangongProviderIdentity = sqliteTable("tiangong_provider_identity", {
  providerInstanceId: text("provider_instance_id", { length: 64 }).primaryKey(),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export const tiangongArtifactLimits = sqliteTable("tiangong_artifact_limits", {
  id: integer("id", { mode: "number" }).primaryKey(),
  principalKey: text("principal_key", { length: 255 }).notNull(),
  workspaceSlug: text("workspace_slug", { length: 100 }).notNull(),
  storageQuotaBytes: integer("storage_quota_bytes", {mode: "number"}).notNull(),
  retentionSeconds: integer("retention_seconds", { mode: "number" }).notNull(),
  gcGraceSeconds: integer("gc_grace_seconds", { mode: "number" }).notNull(),
  gcReaperConcurrency: integer("gc_reaper_concurrency", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  scopeIdx: uniqueIndex("uq_tiangong_artifact_limits_scope").on(table.principalKey, table.workspaceSlug),
}));

export const stagedObjects = sqliteTable("staged_objects", {
  stageId: text("stage_id", { length: 128 }).primaryKey(),
  expectedSha256: text("expected_sha256", { length: 64 }).notNull(),
  expectedSize: integer("expected_size", {mode: "number"}).notNull(),
  expectedMime: text("expected_mime", { length: 255 }).notNull(),
  generationId: integer("generation_id", { mode: "number" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  ownerPrincipal: text("owner_principal", { length: 255 }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  state: text("state", { enum: ["staging", "verified", "sealed", "abandoned"] }).default("staging").notNull(),
});

export const sealedArtifactDescriptors = sqliteTable("sealed_artifact_descriptors", {
  id: integer("id", { mode: "number" }).primaryKey(),
  artifactUuid: text("artifact_uuid", { length: 36 }).notNull(),
  taskId: integer("task_id", {mode: "number"}).notNull(),
  taskPublicId: text("task_public_id", { length: 20 }).notNull(),
  externalRef: text("external_ref", { length: 255 }).notNull(),
  taskRevision: integer("task_revision", {mode: "number"}).notNull(),
  creatorAgentId: integer("creator_agent_id", {mode: "number"}),
  ownerPrincipal: text("owner_principal", { length: 255 }).notNull(),
  workspaceSlug: text("workspace_slug", { length: 100 }).notNull(),
  projectSlug: text("project_slug", { length: 100 }).notNull(),
  providerInstanceId: text("provider_instance_id", { length: 64 }).notNull(),
  sha256: text("sha256", { length: 64 }).notNull(),
  generationId: integer("generation_id", { mode: "number" }).notNull(),
  size: integer("size", {mode: "number"}).notNull(),
  mime: text("mime", { length: 255 }).notNull(),
  storedPath: text("stored_path", { length: 500 }).notNull(),
  sealedAt: integer("sealed_at", { mode: "timestamp" }).notNull(),
  retainUntil: integer("retain_until", { mode: "timestamp" }).notNull(),
}, (table) => ({
  taskArtifactIdx: uniqueIndex("uq_sealed_artifact_task_uuid").on(table.taskId, table.artifactUuid),
  taskRevisionIdx: index("idx_sealed_artifact_task_revision").on(table.taskId, table.taskRevision),
}));

export const sealedArtifactManifests = sqliteTable("sealed_artifact_manifests", {
  id: integer("id", { mode: "number" }).primaryKey(),
  taskId: integer("task_id", {mode: "number"}).notNull().unique(),
  taskPublicId: text("task_public_id", { length: 20 }).notNull(),
  externalRef: text("external_ref", { length: 255 }).notNull(),
  taskRevision: integer("task_revision", {mode: "number"}).notNull(),
  providerInstanceId: text("provider_instance_id", { length: 64 }).notNull(),
  manifestIdentity: text("manifest_identity", { length: 64 }).notNull().unique(),
  canonicalManifest: text("canonical_manifest").notNull(),
  sealedAt: integer("sealed_at", { mode: "timestamp" }).notNull(),
});

// ─── Messages (P8.1: reliable message bus) ───
export const messages = sqliteTable(
  "messages",
  {
    id: integer("id", { mode: "number" }).primaryKey(),
    fromAgent: integer("from_agent", {mode: "number"}).notNull(),
    toAgent: integer("to_agent", {mode: "number"}).notNull(),
    content: text("content").notNull(),
    type: text("type", { enum: ["command", "response", "broadcast", "system", "ack"] }).default("command").notNull(),
    status: text("status", { enum: ["sent", "delivered", "read", "acked", "expired"] }).default("sent").notNull(),
    readAt: integer("read_at", { mode: "timestamp" }),
    conversationId: integer("conversation_id", {mode: "number"}),

    // ── P8.1: reliable message bus fields ──
    /** Links messages across a logical conversation/transaction. */
    correlationId: text("correlation_id", { length: 64 }),
    /** Sender-defined key for idempotent send. Unique per fromAgent. */
    idempotencyKey: text("idempotency_key", { length: 128 }),
    /** Task this message is associated with (nullable for non-task messages). */
    taskId: integer("task_id", {mode: "number"}),
    /** Parent message in a reply chain. */
    parentMessageId: integer("parent_message_id", {mode: "number"}),
    /** TTL – message expires if not delivered by this time. */
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    /** When the recipient acknowledged receipt. */
    ackedAt: integer("acked_at", { mode: "timestamp" }),
    /** When the message was actually pushed to the recipient (WS). */
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
    /** Number of delivery retry attempts. */
    retryCount: integer("retry_count", { mode: "number" }).default(0).notNull(),
    /** Priority (higher = more urgent). Default 0. */
    priority: integer("priority", { mode: "number" }).default(0).notNull(),

    createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
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
export const systems = sqliteTable("systems", {
  id: integer("id", { mode: "number" }).primaryKey(),
  name: text("name", { length: 50 }).notNull(),
  slug: text("slug", { length: 20 }).notNull().unique(),
  status: text("status", { enum: ["connected", "syncing", "disconnected"] }).default("disconnected").notNull(),
  config: text("config"),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type System = typeof systems.$inferSelect;
export type InsertSystem = typeof systems.$inferInsert;

// ─── Organizations ───
export const organizations = sqliteTable("organizations", {
  id: integer("id", { mode: "number" }).primaryKey(),
  name: text("name", { length: 100 }).notNull(),
  description: text("description"),
  goals: text("goals"),
  budget: integer("budget_cents", { mode: "number" }).default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Organization = typeof organizations.$inferSelect;
export type InsertOrganization = typeof organizations.$inferInsert;

// ─── Departments ───
export const departments = sqliteTable("departments", {
  id: integer("id", { mode: "number" }).primaryKey(),
  name: text("name", { length: 100 }).notNull(),
  description: text("description"),
  orgId: integer("org_id", {mode: "number"}).notNull(),
  leadAgentId: integer("lead_agent_id", {mode: "number"}),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Department = typeof departments.$inferSelect;
export type InsertDepartment = typeof departments.$inferInsert;

// ─── Task Dependencies (DAG edges) ───
export const taskDependencies = sqliteTable("task_dependencies", {
  id: integer("id", { mode: "number" }).primaryKey(),
  taskId: integer("task_id", {mode: "number"}).notNull(),
  dependsOnTaskId: integer("depends_on_task_id", {mode: "number"}).notNull(),
});

export type TaskDependency = typeof taskDependencies.$inferSelect;
export type InsertTaskDependency = typeof taskDependencies.$inferInsert;

// ─── MCP API Keys ───
export const mcpApiKeys = sqliteTable("mcp_api_keys", {
  id: integer("id", { mode: "number" }).primaryKey(),
  key: text("key", { length: 64 }).notNull().unique(),
  agentId: integer("agent_id", {mode: "number"}),
  name: text("name", { length: 100 }),
  permissions: text("permissions"),
  rateLimit: integer("rate_limit", { mode: "number" }).default(10),
  active: text("active", { enum: ["true", "false"] }).default("true"),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type McpApiKey = typeof mcpApiKeys.$inferSelect;
export type InsertMcpApiKey = typeof mcpApiKeys.$inferInsert;

// ─── Beidou service keys (verifier-only, Todo 20) ───
// Directional keyring: Beidou-to-Tiangong service credentials (this table) are
// independent from the Tiangong-to-Beidou callback HMAC keyring (Todo 22).
// The plaintext token is NEVER stored here — only the full 32-byte
// HMAC-SHA-256(server_pepper, token) verifier plus the key_id and a 6-byte
// key-id prefix. The server pepper is a deployment secret (env/vault).
export const tiangongServiceKeys = sqliteTable(
  "tiangong_service_keys",
  {
    id: integer("id", { mode: "number" }).primaryKey(),
    // Public key identifier: "tgsk_<base64url(16 random bytes)>".
    keyId: text("key_id", { length: 64 }).notNull().unique(),
    // 32-byte HMAC-SHA-256(server_pepper, token), hex (64 chars). Verifier only.
    verifier: text("verifier", { length: 64 }).notNull(),
    // One-way-redacted 6-byte prefix of the token (base64url, 8 chars).
    keyPrefix: text("key_prefix", { length: 12 }).notNull(),
    // Service principal binding: origin system is fixed to "beidou"; the key
    // is scoped to exactly one workspace + project (no wildcard scope).
    originSystem: text("origin_system", { length: 32 }).notNull().default("beidou"),
    workspaceSlug: text("workspace_slug", { length: 100 }).notNull(),
    projectSlug: text("project_slug", { length: 100 }).notNull(),
    // Least-privilege allowlist, JSON array of BeidouServiceScope values.
    scopes: text("scopes").notNull(),
    issuedAt: integer("issued_at", { mode: "timestamp" }).notNull(),
    // Rotation: previous key remains valid through the overlap retention
    // window (max callback retry window), then is lazily revoked.
    rotationWindowEnd: integer("rotation_window_end", { mode: "timestamp" }),
    revokedAt: integer("revoked_at", { mode: "timestamp" }),
    revokedReason: text("revoked_reason", { length: 100 }),
    version: integer("version", { mode: "number" }).notNull().default(1),
    createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
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
export const serviceKeyAuditLog = sqliteTable("service_key_audit_log", {
  id: integer("id", { mode: "number" }).primaryKey(),
  keyId: text("key_id", { length: 64 }),
  originSystem: text("origin_system", { length: 32 }),
  tokenPrefix: text("token_prefix", { length: 12 }),
  decision: text("decision", { enum: ["authenticated", "denied"] }).notNull(),
  reason: text("reason", { length: 100 }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type ServiceKeyAuditEntry = typeof serviceKeyAuditLog.$inferSelect;
export type InsertServiceKeyAuditEntry = typeof serviceKeyAuditLog.$inferInsert;

// ─── MCP Audit Log ───
export const mcpAuditLog = sqliteTable("mcp_audit_log", {
  id: integer("id", { mode: "number" }).primaryKey(),
  keyId: integer("key_id", {mode: "number"}),
  tool: text("tool", { length: 100 }),
  params: text("params"),
  result: text("result", { length: 20 }),
  error: text("error"),
  durationMs: integer("duration_ms", { mode: "number" }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type McpAuditLogEntry = typeof mcpAuditLog.$inferSelect;
export type InsertMcpAuditLogEntry = typeof mcpAuditLog.$inferInsert;

// ─── P13: Model Pricing ───
export const modelPricing = sqliteTable("model_pricing", {
  model: text("model", { length: 100 }).primaryKey(),
  provider: text("provider", { length: 50 }).default("unknown"),
  inputPrice: text("input_price").notNull().default("0"),
  outputPrice: text("output_price").notNull().default("0"),
  cachedInputPrice: text("cached_input_price"),
  currency: text("currency", { length: 3 }).default("USD"),
  notes: text("notes"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type ModelPricing = typeof modelPricing.$inferSelect;
export type InsertModelPricing = typeof modelPricing.$inferInsert;

// ─── System Settings (KV 配置：模型默认选择、密码托管标记等) ───
export const systemSettings = sqliteTable("system_settings", {
  key: text("key", { length: 100 }).primaryKey(),
  value: text("value"),
  category: text("category", { length: 50 }).default("general"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type SystemSetting = typeof systemSettings.$inferSelect;
export type InsertSystemSetting = typeof systemSettings.$inferInsert;

// ─── Token Usage (P9: 用量监测 + P13: 缓存区分) ───
export const tokenUsage = sqliteTable("token_usage", {
  id: integer("id", { mode: "number" }).primaryKey(),
  model: text("model", { length: 100 }).notNull(),
  provider: text("provider", { length: 50 }).default("unknown"),
  promptTokens: integer("prompt_tokens", { mode: "number" }).default(0).notNull(),
  completionTokens: integer("completion_tokens", { mode: "number" }).default(0).notNull(),
  totalTokens: integer("total_tokens", { mode: "number" }).default(0).notNull(),
  // P13: cache split
  cachedPromptTokens: integer("cached_prompt_tokens", { mode: "number" }).default(0),
  uncachedPromptTokens: integer("uncached_prompt_tokens", { mode: "number" }).default(0),
  callCount: integer("call_count", { mode: "number" }).default(1).notNull(),
  costCents: integer("cost_cents", { mode: "number" }).default(0).notNull(),
  // 高精度成本（微美元，1 USD = 1,000,000 micros）：解决小额调用按分四舍五入后成本全为 0 的问题
  costMicros: integer("cost_micros", {mode: "number"}).default(0).notNull(),
  // P13: currency + exchange
  currency: text("currency", { length: 3 }).default("USD"),
  exchangeRate: text("exchange_rate").default("1.0"),
  costDisplay: text("cost_display").default("0"),
  taskId: integer("task_id", {mode: "number"}),
  agentId: integer("agent_id", {mode: "number"}),
  // Phase 1: 审计增强字段
  sessionKey: text("session_key", { length: 128 }),
  source: text("source", { length: 20 }).default("manual"),
  traceId: text("trace_id", { length: 64 }),
  startedAt: integer("started_at", { mode: "timestamp" }),
  // Phase 2: 高价模型标记
  highCostModel: text("high_cost_model", { enum: ["true", "false"] }).default("false"),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type TokenUsage = typeof tokenUsage.$inferSelect;
export type InsertTokenUsage = typeof tokenUsage.$inferInsert;

// ─── Phase 2: 模型白名单 ───
export const modelAllowlist = sqliteTable("model_allowlist", {
  id: integer("id", { mode: "number" }).primaryKey(),
  agentId: integer("agent_id", {mode: "number"}).notNull(),
  model: text("model", { length: 100 }).notNull(),
  reason: text("reason"),
  createdBy: text("created_by", { length: 50 }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type ModelAllowlist = typeof modelAllowlist.$inferSelect;
export type InsertModelAllowlist = typeof modelAllowlist.$inferInsert;

// ─── Phase 2: 高价模型授权 ───
export const highCostModelAuth = sqliteTable("high_cost_model_auth", {
  id: integer("id", { mode: "number" }).primaryKey(),
  agentId: integer("agent_id", {mode: "number"}).notNull(),
  model: text("model", { length: 100 }).notNull(),
  reason: text("reason").notNull(),
  authorizedBy: text("authorized_by", { length: 50 }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  active: text("active", { enum: ["true", "false"] }).default("true"),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type HighCostModelAuth = typeof highCostModelAuth.$inferSelect;
export type InsertHighCostModelAuth = typeof highCostModelAuth.$inferInsert;

// ─── P11: GitHub App Integration ───
export const githubIntegrations = sqliteTable("github_integrations", {
  id: integer("id", { mode: "number" }).primaryKey(),
  appId: text("app_id", { length: 20 }),
  installationId: text("installation_id", { length: 20 }),
  owner: text("owner", { length: 100 }),
  active: text("active", { enum: ["true", "false"] }).default("true"),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type GithubIntegration = typeof githubIntegrations.$inferSelect;
export type InsertGithubIntegration = typeof githubIntegrations.$inferInsert;

export const githubRepos = sqliteTable("github_repos", {
  id: integer("id", { mode: "number" }).primaryKey(),
  owner: text("owner", { length: 100 }).notNull(),
  name: text("name", { length: 100 }).notNull(),
  fullName: text("full_name", { length: 255 }).notNull(),
  defaultBranch: text("default_branch", { length: 100 }).default("main"),
  installationId: integer("installation_id", {mode: "number"}),
  active: text("active", { enum: ["true", "false"] }).default("true"),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type GithubRepo = typeof githubRepos.$inferSelect;
export type InsertGithubRepo = typeof githubRepos.$inferInsert;

export const githubRepoPermissions = sqliteTable("github_repo_permissions", {
  id: integer("id", { mode: "number" }).primaryKey(),
  agentId: integer("agent_id", {mode: "number"}).notNull(),
  repoId: integer("repo_id", {mode: "number"}).notNull(),
  permissionLevel: text("permission_level", { enum: ["read", "push", "admin"] }).default("read").notNull(),
  active: text("active", { enum: ["true", "false"] }).default("true"),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type GithubRepoPermission = typeof githubRepoPermissions.$inferSelect;
export type InsertGithubRepoPermission = typeof githubRepoPermissions.$inferInsert;

export const githubPullRequests = sqliteTable("github_pull_requests", {
  id: integer("id", { mode: "number" }).primaryKey(),
  repoId: integer("repo_id", {mode: "number"}).notNull(),
  prNumber: integer("pr_number", { mode: "number" }).notNull(),
  title: text("title", { length: 500 }).notNull(),
  body: text("body"),
  branchName: text("branch_name", { length: 255 }),
  baseBranch: text("base_branch", { length: 255 }),
  headSha: text("head_sha", { length: 40 }),
  authorAgentId: integer("author_agent_id", {mode: "number"}),
  status: text("status", { enum: ["pending", "approved", "rejected", "merged", "closed"] }).default("pending").notNull(),
  approvedBy: integer("approved_by", {mode: "number"}),
  approvedAt: integer("approved_at", { mode: "timestamp" }),
  mergedAt: integer("merged_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type GithubPullRequest = typeof githubPullRequests.$inferSelect;
export type InsertGithubPullRequest = typeof githubPullRequests.$inferInsert;

export const githubAuditLog = sqliteTable("github_audit_log", {
  id: integer("id", { mode: "number" }).primaryKey(),
  prId: integer("pr_id", {mode: "number"}),
  action: text("action", { enum: ["approve", "reject", "merge", "register", "revoke"] }).notNull(),
  agentId: integer("agent_id", {mode: "number"}),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type GithubAuditLogEntry = typeof githubAuditLog.$inferSelect;
export type InsertGithubAuditLogEntry = typeof githubAuditLog.$inferInsert;

// ─── Conversations (任务记事板) ───
export const conversations = sqliteTable("conversations", {
  id: integer("id", { mode: "number" }).primaryKey(),
  title: text("title", { length: 255 }).notNull(),
  type: text("type", { enum: ["mission", "meeting", "test", "ad_hoc"] }).default("ad_hoc").notNull(),
  status: text("status", { enum: ["active", "archived"] }).default("active").notNull(),
  participants: text("participants"),
  summary: text("summary"),
  createdBy: integer("created_by", {mode: "number"}),
  archivedAt: integer("archived_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Conversation = typeof conversations.$inferSelect;
export type InsertConversation = typeof conversations.$inferInsert;

// ─── A2A-lite v0.1: Task Threads ───
export const taskThreads = sqliteTable("task_threads", {
  id: integer("id", { mode: "number" }).primaryKey(),
  taskId: integer("task_id", {mode: "number"}).notNull(),
  title: text("title", { length: 255 }),
  status: text("status", { enum: ["open", "closed", "archived"] }).default("open").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type TaskThread = typeof taskThreads.$inferSelect;
export type InsertTaskThread = typeof taskThreads.$inferInsert;

// ─── A2A-lite v0.1: Task Messages (thread events) ───
export const taskMessages = sqliteTable("task_messages", {
  id: integer("id", { mode: "number" }).primaryKey(),
  taskId: integer("task_id", {mode: "number"}).notNull(),
  threadId: integer("thread_id", {mode: "number"}),
  fromAgentId: integer("from_agent_id", {mode: "number"}),
  toAgentId: integer("to_agent_id", {mode: "number"}),
  eventType: text("event_type", { enum: [
    "dispatch",
    "ack",
    "progress",
    "working",
    "result",
    "error",
    "timeout",
    "cancel",
    "system",
  ] }).default("system").notNull(),
  content: text("content"),
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type TaskMessage = typeof taskMessages.$inferSelect;
export type InsertTaskMessage = typeof taskMessages.$inferInsert;

// ─── A2A-lite v0.1: Mailbox Messages (agent-addressed message bus) ───
export const mailboxMessages = sqliteTable("mailbox_messages", {
  id: integer("id", { mode: "number" }).primaryKey(),
  taskId: integer("task_id", {mode: "number"}),
  threadId: integer("thread_id", {mode: "number"}),
  fromAgentId: integer("from_agent_id", {mode: "number"}),
  fromMailboxId: text("from_mailbox_id", { length: 20 }).notNull(),
  toAgentId: integer("to_agent_id", {mode: "number"}).notNull(),
  toMailboxId: text("to_mailbox_id", { length: 20 }).notNull(),
  type: text("mailbox_type", { enum: [
    "direct",
    "mention",
    "question",
    "review_request",
    "subtask",
    "handoff",
    "result_notice",
  ] }).default("direct").notNull(),
  status: text("mailbox_status", { enum: [
    "unread",
    "acknowledged",
    "working",
    "replied",
    "resolved",
    "failed",
  ] }).default("unread").notNull(),
  subject: text("subject", { length: 255 }),
  body: text("body"),
  payloadJson: text("payload_json"),
  replyToMessageId: integer("reply_to_message_id", {mode: "number"}),
  artifactId: integer("artifact_id", {mode: "number"}),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  acknowledgedAt: integer("acknowledged_at", { mode: "timestamp" }),
  repliedAt: integer("replied_at", { mode: "timestamp" }),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type MailboxMessage = typeof mailboxMessages.$inferSelect;
export type InsertMailboxMessage = typeof mailboxMessages.$inferInsert;

// ─── A2A-lite v0.1: Task Artifacts ───
export const taskArtifacts = sqliteTable("task_artifacts", {
  id: integer("id", { mode: "number" }).primaryKey(),
  taskId: integer("task_id", {mode: "number"}).notNull(),
  agentId: integer("agent_id", {mode: "number"}),
  type: text("type", { length: 50 }).notNull(),
  name: text("name", { length: 255 }),
  content: text("content"),
  jsonPayload: text("json_payload"),
  mimeType: text("mime_type", { length: 100 }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type TaskArtifact = typeof taskArtifacts.$inferSelect;
export type InsertTaskArtifact = typeof taskArtifacts.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// 天宫 Phase 1: Workspace / Project / Membership identity foundation
// ═══════════════════════════════════════════════════════════════

// ─── Workspaces ───
export const workspaces = sqliteTable("workspaces", {
  id: integer("id", { mode: "number" }).primaryKey(),
  name: text("name", { length: 100 }).notNull(),
  slug: text("slug", { length: 100 }).notNull().unique(),
  description: text("description"),
  ownerId: integer("owner_id", {mode: "number"}).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Workspace = typeof workspaces.$inferSelect;
export type InsertWorkspace = typeof workspaces.$inferInsert;

// ─── Projects ───
export const projects = sqliteTable(
  "projects",
  {
    id: integer("id", { mode: "number" }).primaryKey(),
    workspaceId: integer("workspace_id", {mode: "number"}).notNull(),
    name: text("name", { length: 100 }).notNull(),
    slug: text("slug", { length: 100 }).notNull(),
    description: text("description"),
    createdBy: integer("created_by", {mode: "number"}).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    workspaceSlugIdx: uniqueIndex("uq_projects_workspace_slug").on(table.workspaceId, table.slug),
  })
);

export type Project = typeof projects.$inferSelect;
export type InsertProject = typeof projects.$inferInsert;

// ─── Workspace Memberships ───
export const workspaceMemberships = sqliteTable(
  "workspace_memberships",
  {
    id: integer("id", { mode: "number" }).primaryKey(),
    workspaceId: integer("workspace_id", {mode: "number"}).notNull(),
    userId: integer("user_id", {mode: "number"}).notNull(),
    role: text("role", { enum: ["owner", "admin", "member", "viewer"] }).default("member").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
  },
  (table) => ({
    membershipIdx: uniqueIndex("uq_workspace_memberships").on(table.workspaceId, table.userId),
  })
);

export type WorkspaceMembership = typeof workspaceMemberships.$inferSelect;
export type InsertWorkspaceMembership = typeof workspaceMemberships.$inferInsert;

// ─── Phase 1: Secret Vault (encrypted write-only references) ───
export const secretVaultItems = sqliteTable(
  "secret_vault_items",
  {
    id: integer("id", { mode: "number" }).primaryKey(),
    workspaceId: integer("workspace_id", {mode: "number"}).notNull(),
    projectId: integer("project_id", {mode: "number"}).notNull(),
    name: text("name", { length: 100 }).notNull(),
    description: text("description"),
    algorithm: text("algorithm", { length: 20 }).notNull(),
    keyId: text("key_id", { length: 100 }).notNull(),
    envelopeVersion: text("envelope_version", { length: 10 }).notNull(),
    nonce: text("nonce").notNull(),
    authTag: text("auth_tag").notNull(),
    ciphertext: text("ciphertext").notNull(),
    createdBy: integer("created_by", {mode: "number"}).notNull(),
    updatedBy: integer("updated_by", {mode: "number"}).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
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

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id", { mode: "number" }).primaryKey(),
    event: text("event", { length: 50 }).notNull(),
    actorUserId: integer("actor_user_id", {mode: "number"}).notNull(),
    workspaceId: integer("workspace_id", {mode: "number"}),
    projectId: integer("project_id", {mode: "number"}),
    targetUserId: integer("target_user_id", {mode: "number"}),
    entityType: text("entity_type", { length: 50 }).notNull(),
    entityId: integer("entity_id", {mode: "number"}),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
    // ── Audit hash chain (block-style hardening) ──
    // sha256 hex of the previous chained row; NULL for pre-chain legacy rows.
    prevHash: text("prev_hash", { length: 64 }),
    // sha256 hex over [prevHash, event, actorUserId, entityType, entityId,
    // metadataJson, createdAt]; NULL for pre-chain legacy rows.
    hash: text("hash", { length: 64 }),
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

export const connectorRegistry = sqliteTable(
  "connector_registry",
  {
    id: integer("id", { mode: "number" }).primaryKey(),
    workspaceId: integer("workspace_id", {mode: "number"}).notNull(),
    projectId: integer("project_id", {mode: "number"}),
    name: text("name", { length: 100 }).notNull(),
    slug: text("slug", { length: 100 }).notNull(),
    connectorType: text("connector_type", { enum: ["opencode", "xuanji", "s3"] }).notNull(),
    status: text("status", { enum: ["draft", "active", "disabled"] }).default("draft").notNull(),
    endpoint: text("endpoint", { length: 500 }),
    config: text("config"), // JSON: non-secret configuration only
    secretRefId: integer("secret_ref_id", {mode: "number"}),
    createdBy: integer("created_by", {mode: "number"}).notNull(),
    updatedBy: integer("updated_by", {mode: "number"}).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
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

export const artifactRegistry = sqliteTable(
  "artifact_registry",
  {
    id: integer("id", { mode: "number" }).primaryKey(),
    workspaceId: integer("workspace_id", {mode: "number"}).notNull(),
    projectId: integer("project_id", {mode: "number"}),
    taskId: integer("task_id", {mode: "number"}),
    name: text("name", { length: 255 }).notNull(),
    slug: text("slug", { length: 100 }).notNull(),
    artifactType: text("artifact_type", { enum: ["file", "image", "document", "log", "data"] }).notNull(),
    status: text("status", { enum: ["draft", "active", "archived", "deleted"] }).default("draft").notNull(),
    mimeType: text("mime_type", { length: 100 }),
    sizeBytes: integer("size_bytes", {mode: "number"}),
    checksumSha256: text("checksum_sha256", { length: 64 }),
    storageBackrefType: text("storage_backref_type", { enum: ["connector", "inline", "external"] }),
    storageBackrefId: text("storage_backref_id", { length: 100 }),
    metadata: text("metadata"), // JSON: safe, non-secret metadata only
    createdBy: integer("created_by", {mode: "number"}).notNull(),
    updatedBy: integer("updated_by", {mode: "number"}).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
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
export const sharedSessions = sqliteTable("shared_sessions", {
  id: integer("id", { mode: "number" }).primaryKey(),
  title: text("title", { length: 255 }).notNull(),
  sessionKey: text("session_key", { length: 100 }).notNull().unique(),
  type: text("type", { enum: ["collaboration", "handoff", "meeting", "review", "adhoc"] }).default("adhoc").notNull(),
  status: text("status", { enum: ["active", "archived"] }).default("active").notNull(),
  participants: text("participants"), // JSON array of agent IDs
  summary: text("summary"), // 会话摘要
  context: text("context"), // 上下文快照（JSON）
  createdBy: integer("created_by", {mode: "number"}),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type SharedSession = typeof sharedSessions.$inferSelect;
export type InsertSharedSession = typeof sharedSessions.$inferInsert;

// ─── Session Messages: 会话消息历史 ───
export const sessionMessages = sqliteTable("session_messages", {
  id: integer("id", { mode: "number" }).primaryKey(),
  sessionId: integer("session_id", {mode: "number"}).notNull(),
  fromAgentId: integer("from_agent_id", {mode: "number"}),
  toAgentId: integer("to_agent_id", {mode: "number"}),
  role: text("role", { enum: ["user", "assistant", "system"] }).default("assistant").notNull(),
  content: text("content").notNull(),
  metadata: text("metadata"), // JSON
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
});

export type SessionMessage = typeof sessionMessages.$inferSelect;
export type InsertSessionMessage = typeof sessionMessages.$inferInsert;

// ─── Agent Memories: Agent 长期记忆 ───
export const agentMemories = sqliteTable("agent_memories", {
  id: integer("id", { mode: "number" }).primaryKey(),
  agentId: integer("agent_id", {mode: "number"}).notNull(),
  key: text("key", { length: 100 }).notNull(),
  value: text("value").notNull(),
  type: text("type", { enum: ["personal", "shared", "company"] }).default("personal").notNull(),
  tags: text("tags", { length: 500 }), // 逗号分隔
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  agentKeyIdx: uniqueIndex("uq_agent_memories_key").on(table.agentId, table.key),
}));

export type AgentMemory = typeof agentMemories.$inferSelect;
export type InsertAgentMemory = typeof agentMemories.$inferInsert;

// ─── External Agents: 外部 Agent 注册 ───
export const externalAgents = sqliteTable("external_agents", {
  id: integer("id", { mode: "number" }).primaryKey(),
  name: text("name", { length: 100 }).notNull(),
  platform: text("platform", { enum: ["hermes", "opencode", "codex", "arkclaw", "openai", "custom"] }).notNull(),
  endpoint: text("endpoint", { length: 500 }),
  apiKey: text("api_key", { length: 500 }),
  model: text("model", { length: 100 }),
  status: text("status", { enum: ["online", "offline", "error"] }).default("offline").notNull(),
  capabilities: text("capabilities"), // JSON
  config: text("config"), // JSON: 平台特定配置
  lastHeartbeat: integer("last_heartbeat", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).defaultNow().notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).defaultNow().notNull().$onUpdate(() => new Date()),
});

export type ExternalAgent = typeof externalAgents.$inferSelect;
export type InsertExternalAgent = typeof externalAgents.$inferInsert;

// ═══════════════════════════════════════════════════════════════
// 通知中心（任务 NC-1 引入，后续任务 NC-2+ 接入 helper 与挂点）
// 当前里程碑仅定义表结构，recordNotification / notifyLessonRecorded / tRPC procedure 在后续任务中实现。
// ─── Notifications: 通知中心 ───
export const notifications = sqliteTable("notifications", {
  id: integer("id", { mode: "number" }).primaryKey(),
  agentId: integer("agent_id", {mode: "number"}).notNull().references(() => agents.id, { onDelete: "cascade" }),
  type: text("type", { enum: [
    "task_approved",        // 任务审批通过
    "task_rejected",        // 任务审批驳回
    "task_completed",       // 任务完成（NC-5 暂不挂，注释说明）
    "task_failed",          // 任务失败（NC-5 接入）
    "lesson_recorded",      // 失败教训已写璇玑（NC-3 接入）
    "budget_exhausted",     // 任务级预算熔断（NC-5 接入）
  ] }).notNull(),
  taskId: integer("task_id", {mode: "number"}).references(() => tasks.id, { onDelete: "cascade" }),
  title: text("title", { length: 200 }).notNull(),
  body: text("body").notNull(),
  metadata: text("metadata", { mode: "json" }),  // 可选：额外上下文（审批人/理由/错误摘要等）
  readAt: integer("read_at", { mode: "timestamp" }),  // null = 未读
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().defaultNow(),
}, (table) => ({
  // 索引：list API 高效分页 + 防抖查询
  agentReadIdx: index("idx_notifications_agent_read").on(table.agentId, table.readAt),
  createdAtIdx: index("idx_notifications_created_at").on(table.createdAt),
}));
