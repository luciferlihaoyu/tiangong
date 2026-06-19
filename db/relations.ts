import { relations } from "drizzle-orm";
import { agents, tasks, messages, organizations, departments, taskDependencies, mcpApiKeys, mcpAuditLog, taskThreads, taskMessages, taskArtifacts } from "./schema";

export const agentRelations = relations(agents, ({ many, one }) => ({
  tasks: many(tasks),
  reportTo: one(agents, { fields: [agents.reportsTo], references: [agents.id] }),
  subordinates: many(agents, { relationName: "subordinates" }),
  org: one(organizations, { fields: [agents.orgId], references: [organizations.id] }),
  department: one(departments, { fields: [agents.departmentId], references: [departments.id] }),
}));

export const taskRelations = relations(tasks, ({ one, many }) => ({
  agent: one(agents, { fields: [tasks.agentId], references: [agents.id] }),
  parentTask: one(tasks, { fields: [tasks.parentTaskId], references: [tasks.id] }),
  childTasks: many(tasks, { relationName: "childTasks" }),
  dependencies: many(taskDependencies),
  // A2A-lite v0.1
  threads: many(taskThreads),
  taskMessages: many(taskMessages),
  artifacts: many(taskArtifacts),
}));

export const messageRelations = relations(messages, ({ one }) => ({
  fromAgentRef: one(agents, { fields: [messages.fromAgent], references: [agents.id] }),
  toAgentRef: one(agents, { fields: [messages.toAgent], references: [agents.id] }),
}));

export const organizationRelations = relations(organizations, ({ many }) => ({
  departments: many(departments),
  agents: many(agents),
}));

export const departmentRelations = relations(departments, ({ one, many }) => ({
  org: one(organizations, { fields: [departments.orgId], references: [organizations.id] }),
  leadAgent: one(agents, { fields: [departments.leadAgentId], references: [agents.id] }),
  agents: many(agents),
}));

export const taskDependencyRelations = relations(taskDependencies, ({ one }) => ({
  task: one(tasks, { fields: [taskDependencies.taskId], references: [tasks.id] }),
  dependsOn: one(tasks, { fields: [taskDependencies.dependsOnTaskId], references: [tasks.id] }),
}));

export const mcpApiKeyRelations = relations(mcpApiKeys, ({ one, many }) => ({
  agent: one(agents, { fields: [mcpApiKeys.agentId], references: [agents.id] }),
  auditLogs: many(mcpAuditLog),
}));

export const mcpAuditLogRelations = relations(mcpAuditLog, ({ one }) => ({
  apiKey: one(mcpApiKeys, { fields: [mcpAuditLog.keyId], references: [mcpApiKeys.id] }),
}));

// ── A2A-lite v0.1 relations ──
export const taskThreadRelations = relations(taskThreads, ({ one, many }) => ({
  task: one(tasks, { fields: [taskThreads.taskId], references: [tasks.id] }),
  messages: many(taskMessages),
}));

export const taskMessageRelations = relations(taskMessages, ({ one }) => ({
  task: one(tasks, { fields: [taskMessages.taskId], references: [tasks.id] }),
  thread: one(taskThreads, { fields: [taskMessages.threadId], references: [taskThreads.id] }),
  fromAgent: one(agents, { fields: [taskMessages.fromAgentId], references: [agents.id] }),
  toAgent: one(agents, { fields: [taskMessages.toAgentId], references: [agents.id] }),
}));

export const taskArtifactRelations = relations(taskArtifacts, ({ one }) => ({
  task: one(tasks, { fields: [taskArtifacts.taskId], references: [tasks.id] }),
  agent: one(agents, { fields: [taskArtifacts.agentId], references: [agents.id] }),
}));
