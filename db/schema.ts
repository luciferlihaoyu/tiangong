import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  text,
  timestamp,
  int,
  bigint,
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Agent = typeof agents.$inferSelect;
export type InsertAgent = typeof agents.$inferInsert;

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull().$onUpdate(() => new Date()),
});

export type Task = typeof tasks.$inferSelect;
export type InsertTask = typeof tasks.$inferInsert;

// ─── Messages ───
export const messages = mysqlTable("messages", {
  id: serial("id").primaryKey(),
  fromAgent: bigint("from_agent", { mode: "number", unsigned: true }).notNull(),
  toAgent: bigint("to_agent", { mode: "number", unsigned: true }).notNull(),
  content: text("content").notNull(),
  type: mysqlEnum("type", ["command", "response", "broadcast", "system"]).default("command").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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
