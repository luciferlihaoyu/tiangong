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

// ─── Users (OAuth auth) ───
export const users = mysqlTable("users", {
  id: serial("id").primaryKey(),
  unionId: varchar("unionId", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 255 }),
  email: varchar("email", { length: 320 }),
  avatar: text("avatar"),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull().$onUpdate(() => new Date()),
  lastSignInAt: timestamp("lastSignInAt").defaultNow().notNull(),
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
  status: mysqlEnum("status", ["running", "pending", "done", "failed"]).default("pending").notNull(),
  progress: int("progress").default(0).notNull(),
  description: text("description"),
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
