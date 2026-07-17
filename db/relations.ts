import { relations } from "drizzle-orm";
import {
  users,
  agents, tasks, messages, organizations, departments, taskDependencies,
  mcpApiKeys, mcpAuditLog, taskThreads, taskMessages, taskArtifacts,
  sharedSessions, sessionMessages, agentMemories, externalAgents,
  workspaces, projects, workspaceMemberships, secretVaultItems, auditEvents,
  connectorRegistry, artifactRegistry,
} from "./schema";

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

// ── Phase 3: Shared Sessions, Session Messages, Agent Memories, External Agents ──
export const sharedSessionRelations = relations(sharedSessions, ({ many }) => ({
  messages: many(sessionMessages),
}));

export const sessionMessageRelations = relations(sessionMessages, ({ one }) => ({
  session: one(sharedSessions, { fields: [sessionMessages.sessionId], references: [sharedSessions.id] }),
  fromAgent: one(agents, { fields: [sessionMessages.fromAgentId], references: [agents.id] }),
  toAgent: one(agents, { fields: [sessionMessages.toAgentId], references: [agents.id] }),
}));

export const agentMemoryRelations = relations(agentMemories, ({ one }) => ({
  agent: one(agents, { fields: [agentMemories.agentId], references: [agents.id] }),
}));

export const externalAgentRelations = relations(externalAgents, () => ({}));

// ── Phase 1: Workspace / Project / Membership identity foundation ──
export const userRelations = relations(users, ({ many }) => ({
  workspaceMemberships: many(workspaceMemberships),
  ownedWorkspaces: many(workspaces, { relationName: "owner" }),
}));

export const workspaceRelations = relations(workspaces, ({ one, many }) => ({
  owner: one(users, { fields: [workspaces.ownerId], references: [users.id], relationName: "owner" }),
  projects: many(projects),
  memberships: many(workspaceMemberships),
}));

export const projectRelations = relations(projects, ({ one }) => ({
  workspace: one(workspaces, { fields: [projects.workspaceId], references: [workspaces.id] }),
  creator: one(users, { fields: [projects.createdBy], references: [users.id] }),
}));

export const workspaceMembershipRelations = relations(workspaceMemberships, ({ one }) => ({
  workspace: one(workspaces, { fields: [workspaceMemberships.workspaceId], references: [workspaces.id] }),
  user: one(users, { fields: [workspaceMemberships.userId], references: [users.id] }),
}));

export const secretVaultItemRelations = relations(secretVaultItems, ({ one }) => ({
  workspace: one(workspaces, { fields: [secretVaultItems.workspaceId], references: [workspaces.id] }),
  project: one(projects, { fields: [secretVaultItems.projectId], references: [projects.id] }),
  creator: one(users, { fields: [secretVaultItems.createdBy], references: [users.id] }),
  updater: one(users, { fields: [secretVaultItems.updatedBy], references: [users.id] }),
}));

export const auditEventRelations = relations(auditEvents, ({ one }) => ({
  actor: one(users, { fields: [auditEvents.actorUserId], references: [users.id] }),
  workspace: one(workspaces, { fields: [auditEvents.workspaceId], references: [workspaces.id] }),
  project: one(projects, { fields: [auditEvents.projectId], references: [projects.id] }),
  targetUser: one(users, { fields: [auditEvents.targetUserId], references: [users.id] }),
}));

export const connectorRegistryRelations = relations(connectorRegistry, ({ one }) => ({
  workspace: one(workspaces, { fields: [connectorRegistry.workspaceId], references: [workspaces.id] }),
  project: one(projects, { fields: [connectorRegistry.projectId], references: [projects.id] }),
  creator: one(users, { fields: [connectorRegistry.createdBy], references: [users.id] }),
  updater: one(users, { fields: [connectorRegistry.updatedBy], references: [users.id] }),
  secretRef: one(secretVaultItems, { fields: [connectorRegistry.secretRefId], references: [secretVaultItems.id] }),
}));

export const artifactRegistryRelations = relations(artifactRegistry, ({ one }) => ({
  workspace: one(workspaces, { fields: [artifactRegistry.workspaceId], references: [workspaces.id] }),
  project: one(projects, { fields: [artifactRegistry.projectId], references: [projects.id] }),
  task: one(tasks, { fields: [artifactRegistry.taskId], references: [tasks.id] }),
  creator: one(users, { fields: [artifactRegistry.createdBy], references: [users.id] }),
  updater: one(users, { fields: [artifactRegistry.updatedBy], references: [users.id] }),
}));
