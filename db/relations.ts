import { relations } from "drizzle-orm";
import { agents, tasks, messages } from "./schema";

export const agentRelations = relations(agents, ({ many }) => ({
  tasks: many(tasks),
}));

export const taskRelations = relations(tasks, ({ one }) => ({
  agent: one(agents, { fields: [tasks.agentId], references: [agents.id] }),
}));

export const messageRelations = relations(messages, ({ one }) => ({
  fromAgentRef: one(agents, { fields: [messages.fromAgent], references: [agents.id] }),
  toAgentRef: one(agents, { fields: [messages.toAgent], references: [agents.id] }),
}));
