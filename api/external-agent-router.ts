import { z } from "zod";
import { createRouter, publicQuery, authedQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { externalAgents } from "@db/schema";
import { eq, desc } from "drizzle-orm";
import { wsManager } from "./ws-manager";

export const externalAgentRouter = createRouter({
  // ─── 外部 Agent 注册 ───
  register: authedQuery
    .input(z.object({
      name: z.string().min(1).max(100),
      platform: z.enum(["hermes", "opencode", "codex", "arkclaw", "openai", "custom"]),
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      capabilities: z.string().optional(),
      config: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const result = await db.insert(externalAgents).values({
        name: input.name,
        platform: input.platform,
        endpoint: input.endpoint ?? null,
        apiKey: input.apiKey ?? null,
        model: input.model ?? null,
        capabilities: input.capabilities ?? null,
        config: input.config ? JSON.stringify(input.config) : null,
        status: "offline",
      });
      return { success: true, id: (result as any).insertId as number };
    }),

  list: publicQuery.query(async () => {
    const db = getDb();
    return db.select().from(externalAgents).orderBy(desc(externalAgents.createdAt));
  }),

  getById: publicQuery
    .input(z.object({ id: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(externalAgents).where(eq(externalAgents.id, input.id)).then(r => r[0] || null);
    }),

  update: authedQuery
    .input(z.object({
      id: z.number(),
      name: z.string().min(1).max(100).optional(),
      endpoint: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      capabilities: z.string().optional(),
      config: z.record(z.string(), z.any()).optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name) updates.name = input.name;
      if (input.endpoint !== undefined) updates.endpoint = input.endpoint;
      if (input.apiKey !== undefined) updates.apiKey = input.apiKey;
      if (input.model !== undefined) updates.model = input.model;
      if (input.capabilities !== undefined) updates.capabilities = input.capabilities;
      if (input.config !== undefined) updates.config = JSON.stringify(input.config);
      await db.update(externalAgents).set(updates).where(eq(externalAgents.id, input.id));
      return { success: true };
    }),

  delete: adminQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(externalAgents).where(eq(externalAgents.id, input.id));
      return { success: true };
    }),

  // ─── 通过外部 Agent 发送消息 ───
  sendMessage: authedQuery
    .input(z.object({
      agentId: z.number(),
      message: z.string(),
      platform: z.enum(["hermes", "opencode", "codex", "arkclaw", "openai", "custom"]),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const agent = await db.select().from(externalAgents).where(eq(externalAgents.id, input.agentId)).then(r => r[0]);
      if (!agent) throw new Error("External agent not found");

      switch (input.platform) {
        case "opencode":
          return await sendToOpenCode(agent, input.message);
        case "codex":
          return await sendToCodex(agent, input.message);
        case "arkclaw":
          return await sendToArkClaw(agent, input.message);
        case "hermes":
          return await sendToHermes(agent, input.message);
        case "openai":
          return await sendToOpenAI(agent, input.message);
        default:
          return await sendToCustom(agent, input.message);
      }
    }),

  // ─── 心跳 ───
  heartbeat: authedQuery
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(externalAgents).set({ status: "online", lastHeartbeat: new Date() }).where(eq(externalAgents.id, input.id));
      return { success: true };
    }),
});

// ─── 平台适配器 ───

async function sendToOpenCode(agent: any, message: string) {
  const endpoint = agent.endpoint || "http://localhost:4096";
  try {
    const res = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(agent.apiKey ? { "Authorization": `Bearer ${agent.apiKey}` } : {}) },
      body: JSON.stringify({ prompt: message, model: agent.model || undefined }),
    });
    const data = await res.json();
    return { success: true, response: data };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function sendToCodex(_agent: any, _message: string) {
  return { success: true, note: "Codex ACP integration - use OpenClaw gateway sessions.send" };
}

async function sendToArkClaw(agent: any, message: string) {
  const endpoint = agent.endpoint || "https://ark.cn-beijing.volces.com/api/v3";
  try {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${agent.apiKey}` },
      body: JSON.stringify({ model: agent.model || "ep-xxx", messages: [{ role: "user", content: message }] }),
    });
    const data: any = await res.json();
    return { success: true, response: data.choices?.[0]?.message?.content || data };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function sendToHermes(agent: any, message: string) {
  const endpoint = agent.endpoint || "";
  if (!endpoint) return { success: false, error: "Hermes endpoint not configured" };
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(agent.apiKey ? { "Authorization": `Bearer ${agent.apiKey}` } : {}) },
      body: JSON.stringify({ message, agent: agent.name }),
    });
    const data = await res.json();
    return { success: true, response: data };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function sendToOpenAI(agent: any, message: string) {
  const endpoint = agent.endpoint || "https://api.openai.com/v1";
  try {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${agent.apiKey}` },
      body: JSON.stringify({ model: agent.model || "gpt-4", messages: [{ role: "user", content: message }] }),
    });
    const data: any = await res.json();
    return { success: true, response: data.choices?.[0]?.message?.content || data };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

async function sendToCustom(agent: any, message: string) {
  const endpoint = agent.endpoint || "";
  if (!endpoint) return { success: false, error: "Custom agent endpoint not configured" };
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(agent.apiKey ? { "Authorization": `Bearer ${agent.apiKey}` } : {}) },
      body: JSON.stringify({ message, ...(agent.config ? JSON.parse(agent.config) : {}) }),
    });
    const data = await res.json();
    return { success: true, response: data };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}
