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
  decimal,
} from "drizzle-orm/mysql-core";

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
  agentId: varchar("agent_id", { length: 20 }).notNull().unique(),
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
  reviewerId: bigint("reviewer_id", { mode: "number", unsigned: true }),
  reviewResult: varchar("review_result", { length: 30 }),
  triagedAt: timestamp("triaged_at"),
  backloggedAt: timestamp("backlogged_at"),
  readyAt: timestamp("ready_at"),
  reviewAt: timestamp("review_at"),
  blockedAt: timestamp("blocked_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

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
