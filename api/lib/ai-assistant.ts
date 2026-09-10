/**
 * 天宫 AI 助手 worker（方案 C：异步触发 + WS 推送）
 *
 * 触发：message.send 成功且 toAgent 是「天宫助手」→ triggerAssistantReply()
 * 流程：
 *   1. 确保助手 agent 存在（agents 表 upsert，幂等）
 *   2. 拉该会话最近 N 条消息组装 OpenAI messages 上下文
 *   3. 调 tianshu /v1/chat/completions（默认 MiniMax-M3，可从 system_settings 切换）
 *   4. 剥离 reasoning_content（MiniMax-M3 会返回英文思考流，不能展示给用户）
 *   5. 回复插入 messages 表 + wsManager.broadcastToDashboard 实时推送
 *
 * 护栏：
 *   - 回复 ≤2000 字符
 *   - LLM 60s 超时
 *   - 失败插入「暂时不可用」系统消息，不阻塞主流程
 *   - in-process setImmediate 异步（不引 Redis，2C/7.6G 容器约束，AGENTS.md）
 *
 * 模型切换：trpc.assistant.getModel / setModel（system_settings key: ai_assistant_model）
 */

import { and, desc, eq, or } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { agents, messages } from "../../db/schema";
import { getSetting } from "./settings";
import { wsManager } from "../ws-manager";

/** 「天宫助手」固定标识 */
export const ASSISTANT_AGENT_KEY = "tianshu-assistant";
export const ASSISTANT_NAME = "天宫助手";

export const ASSISTANT_MODEL_KEY = "ai_assistant_model";
const DEFAULT_MODEL = "MiniMax-M3";
const CONTEXT_LIMIT = 20;
const MAX_REPLY_CHARS = 2000;
const LLM_TIMEOUT_MS = 60_000;

/** system prompt：助手人格 + 边界（消息对话用） */
export const ASSISTANT_CHAT_SYSTEM_PROMPT = `你是「天宫助手」，天宫多智能体协作平台的内置 AI 助手。
规则：
- 用简洁中文回答，直接给结论，不寒暄
- 回答 ≤300 字，除非用户明确要求详细展开
- 你可以解释天宫的功能（任务板、Agent、消息、Fusion 审查等），但不要编造不存在的功能
- 如果问题超出你的能力（如操作数据库、执行代码），如实说明并建议用户去对应页面操作
- 不要输出任何思考过程、推理标记或英文内心独白，只给最终回答`;

/** 任务执行人格：分配给天宫助手的任务经 task-runner tianshu 模式执行时使用 */
export const ASSISTANT_TASK_SYSTEM_PROMPT = `你是「天宫助手」，正在执行天宫任务板分配给你的任务。
规则：
- 直接产出任务要求的结果（文档/方案/代码/分析），不要复述任务描述
- 结构：先给结论/成果，再给要点说明
- 无法实际执行的操作（访问外网、操作数据库、部署等）不要假装完成，如实说明并给出可执行的替代方案
- 输出即交付物，会被归档——写清楚、完整、可独立阅读
- 不要输出任何思考过程或推理标记`;

function tianshuBaseUrl(): string {
  return (process.env.TIANSHU_BASE_URL || "https://tianshu.xianrealme.com").replace(/\/+$/, "");
}

function tianshuApiKey(): string | null {
  return (process.env.TIANSHU_API_KEY || "").trim() || null;
}

/** 当前助手模型（system_settings 优先，默认 MiniMax-M3） */
export async function getAssistantModel(): Promise<string> {
  const v = await getSetting(ASSISTANT_MODEL_KEY).catch(() => null);
  return (v || "").trim() || DEFAULT_MODEL;
}

/** 确保「天宫助手」agent 存在，返回其数字 id（不存在则创建） */
export async function ensureAssistantAgent(): Promise<number> {
  const db = getDb();
  const existing = await db
    .select()
    .from(agents)
    .where(eq(agents.agentId, ASSISTANT_AGENT_KEY))
    .then((r) => r[0]);
  if (existing) return existing.id;

  await db.insert(agents).values({
    agentId: ASSISTANT_AGENT_KEY,
    name: ASSISTANT_NAME,
    system: "assistant",
    status: "online",
    description: "天宫内置 AI 助手：在消息面板给它发消息即可获得 LLM 回复（默认 MiniMax-M3，可切换）",
    lastHeartbeat: new Date(),
  });
  const created = await db
    .select()
    .from(agents)
    .where(eq(agents.agentId, ASSISTANT_AGENT_KEY))
    .then((r) => r[0]);
  return created.id;
}

/** 判断某 agentId 是否是天宫助手 */
export async function isAssistantAgent(agentId: number): Promise<boolean> {
  const db = getDb();
  const row = await db
    .select({ agentId: agents.agentId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((r) => r[0]);
  return row?.agentId === ASSISTANT_AGENT_KEY;
}

/** 剥离 MiniMax 思考流：content 里混有 <think>…</think> 或 reasoning 字段时清理 */
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "")
    .trim();
}

/** 组装 OpenAI messages 上下文（最近 N 条，用户↔助手往返） */
async function buildContext(assistantId: number, userAgentId: number) {
  const db = getDb();
  const rows = await db
    .select()
    .from(messages)
    .where(
      or(
        and(eq(messages.fromAgent, userAgentId), eq(messages.toAgent, assistantId)),
        and(eq(messages.fromAgent, assistantId), eq(messages.toAgent, userAgentId))
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(CONTEXT_LIMIT);

  const ordered = rows.reverse(); // 时间正序
  return [
    { role: "system" as const, content: ASSISTANT_CHAT_SYSTEM_PROMPT },
    ...ordered.map((m) => ({
      role: (m.fromAgent === assistantId ? "assistant" : "user") as "assistant" | "user",
      content: m.content,
    })),
  ];
}

/** 调 LLM 生成回复（失败返回 null） */
async function callLLM(model: string, context: Array<{ role: string; content: string }>): Promise<string | null> {
  const apiKey = tianshuApiKey();
  if (!apiKey) return null;
  try {
    const resp = await fetch(`${tianshuBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: context,
        max_tokens: 1500,
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const clean = stripReasoning(raw);
    return clean.slice(0, MAX_REPLY_CHARS) || null;
  } catch {
    return null;
  }
}

/**
 * 触发助手异步回复（fire-and-forget，setImmediate 不阻塞 message.send 主流程）
 * @param userAgentId 发消息的用户 agent id
 * @param userMessageId 用户那条消息的 id（用于关联）
 */
export function triggerAssistantReply(userAgentId: number, userMessageId: number): void {
  setImmediate(async () => {
    const db = getDb();
    let assistantId: number;
    try {
      assistantId = await ensureAssistantAgent();
    } catch (e) {
      console.warn("[assistant] ensure agent failed:", e instanceof Error ? e.message : e);
      return;
    }

    const model = await getAssistantModel();
    const context = await buildContext(assistantId, userAgentId);
    const reply = await callLLM(model, context);

    const content = reply ?? "⚠️ AI 助手暂时不可用（LLM 调用失败或 TIANSHU_API_KEY 未配置），请稍后重试。";

    // 插入回复消息
    const result = await db.insert(messages).values({
      fromAgent: assistantId,
      toAgent: userAgentId,
      content,
      type: "response",
      status: "delivered",
      deliveredAt: new Date(),
      parentMessageId: userMessageId,
    });
    // better-sqlite3 返回 lastInsertRowid；兼容 mysql2 的 insertId
    const rawResult = result as unknown as { lastInsertRowid?: number | bigint; insertId?: number };
    const insertId = rawResult.lastInsertRowid !== undefined ? Number(rawResult.lastInsertRowid) : (rawResult.insertId ?? 0);

    // 拉完整行广播给 dashboard
    const full = insertId
      ? await db.select().from(messages).where(eq(messages.id, insertId)).then((r) => r[0])
      : null;

    wsManager.broadcastToDashboard({
      type: "new_message",
      message: full
        ? {
            id: full.id,
            fromAgent: full.fromAgent,
            toAgent: full.toAgent,
            content: full.content,
            type: full.type,
            status: full.status,
            createdAt: full.createdAt,
          }
        : {
            id: insertId ?? Date.now(),
            fromAgent: assistantId,
            toAgent: userAgentId,
            content,
            type: "response",
            status: "delivered",
            createdAt: new Date().toISOString(),
          },
    });
  });
}
