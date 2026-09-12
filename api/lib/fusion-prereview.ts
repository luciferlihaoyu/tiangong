/**
 * Fusion 预审（红线任务的多模型审查，结论给人工审批参考）
 *
 * 与自动审批（auto-approve.ts）的区别：
 *   - 自动审批 = 替人决策（可放行），受 auto_approve_enabled 开关控制
 *   - 预审     = 给人参考（绝不放行），红线任务停放后自动跑，开关独立于自动审批
 *
 * 为什么不用 fusion-router.ts 的审查链：那条链是"给审查者智能体发消息等人回"的
 * 异步模式，当前没有任何客户端消费 fusion_review 消息，报告会永远 pending。
 * 这里改为直连天枢网关的多模型并行审查（Fusion 方法论：多模型独立审 + Judge 汇总），
 * 同步完成、结果直接落任务线程。
 *
 * 流程（红线任务停放后触发，fire-and-forget）：
 *   1. 门槛：仍处待审批 + 命中红线 + 未做过预审（幂等）+ 日限额未满
 *   2. 从天枢 /v1/models 取最多 3 个不同模型，各自独立审查（严格 JSON）
 *   3. 助手模型做 Judge 汇总（风险评估 + 结论 + 建议动作）
 *   4. 结果写入 taskThreads（metadata.action=fusion_prereview，UI 渲染成卡片）
 *
 * 安全护栏：绝不改任务状态（任务保持停放等人工）；任何异常 fail-safe 只写日志；
 * 日限额防成本失控；幂等防重复扣费。
 */

import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { tasks, taskMessages } from "../../db/schema";
import { getSetting, setSetting } from "./settings";
import { getApprovalState } from "./execution-gate";
import { RED_LINE_RISKS } from "./auto-approve";
import { getAssistantModel, ensureAssistantAgent } from "./ai-assistant";
import { wsManager } from "../ws-manager";

const DAILY_LIMIT_KEY = "fusion_prereview_daily_limit";
const DEFAULT_DAILY_LIMIT = 10;

const REVIEW_PROMPT = `你是风险评估员。以下是一个因命中红线风险类型而被停放、等待人工审批的任务。
请独立审查该任务，找出执行它可能带来的问题。从你的视角给出结构化评估。

只输出严格 JSON（不要任何其他文字）：
{"consensus":["基本没问题的方面"],"conflicts":["可疑或矛盾的点"],"risks":["具体风险，每条一句话"],"suggestions":["降低风险的建议"],"confidence":0.85,"summary":"一句话总体判断"}`;

const JUDGE_PROMPT = `你是审批法官。多个不同模型独立审查了同一个红线任务，下面是它们的评估结果（JSON 数组）。
请汇总各方观点，给出供人工审批参考的最终意见。注意：你无权批准或拒绝任务，只提供决策参考。

只输出严格 JSON（不要任何其他文字）：
{"riskAssessment":"综合风险评估，2-3 句话","finalVerdict":"approve"|"modify"|"reject","recommendedActions":["建议人工审批时采取的动作"],"confidence":0.8}`;

function todayKey(): string {
  return `fusion_prereview_count:${new Date().toISOString().slice(0, 10)}`;
}

async function dailyCount(): Promise<number> {
  const v = await getSetting(todayKey()).catch(() => null);
  return parseInt(v || "0", 10) || 0;
}

async function bumpDailyCount(): Promise<void> {
  await setSetting(todayKey(), String((await dailyCount()) + 1), "fusion_prereview").catch(() => undefined);
}

async function dailyLimit(): Promise<number> {
  const v = await getSetting(DAILY_LIMIT_KEY).catch(() => null);
  return parseInt(v || "", 10) || DEFAULT_DAILY_LIMIT;
}

function tianshuBaseUrl(): string {
  return (process.env.TIANSHU_BASE_URL || "https://tianshu.xianrealme.com").replace(/\/+$/, "");
}

/** 非 chat 模型特征：embedding/rerank/语音/图像等不能做 chat completion */
const NON_CHAT_MODEL = /(embed|bge|rerank|whisper|tts|speech|asr|ocr|clip|dall|stable-?diff|sdxl|flux|midjourney|guard|moderation)/i;

/** 从天枢拉可用模型列表，过滤非 chat 模型后去重取前 n 个。
 *  天枢 /v1/models 返回 140+ 条目，前段混着 BAAI/bge-* 等 embedding 模型，
 *  不过滤会全部调用失败（实证：预审首测 3 个全命中 embedding）。 */
async function pickModels(n: number): Promise<string[]> {
  const apiKey = (process.env.TIANSHU_API_KEY || "").trim();
  if (!apiKey) return [];
  try {
    const resp = await fetch(`${tianshuBaseUrl()}/v1/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const ids = (data.data ?? []).map((m) => (m.id || "").trim()).filter(Boolean);
    const chatModels = [...new Set(ids)].filter((id) => !NON_CHAT_MODEL.test(id));
    // 助手模型专职 Judge；其他 chat 模型够 3 个时审查者全部避开 Judge 模型（多样性）
    const assistant = await getAssistantModel();
    const others = chatModels.filter((m) => m !== assistant);
    const reviewers = others.length >= n ? others.slice(0, n) : [assistant, ...others].slice(0, n);
    return reviewers;
  } catch {
    return [];
  }
}

interface ModelReview {
  model: string;
  consensus: string[];
  conflicts: string[];
  risks: string[];
  suggestions: string[];
  confidence: number;
  summary: string;
}

function extractJson<T>(raw: string): T | null {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

async function chat(model: string, system: string, user: string, maxTokens: number): Promise<string | null> {
  const apiKey = (process.env.TIANSHU_API_KEY || "").trim();
  if (!apiKey) return null;
  try {
    const resp = await fetch(`${tianshuBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

async function reviewWithModel(model: string, payload: string): Promise<ModelReview | null> {
  const raw = await chat(model, REVIEW_PROMPT, payload, 600);
  if (!raw) return null;
  const parsed = extractJson<Partial<ModelReview>>(raw);
  if (!parsed || !Array.isArray(parsed.risks)) return null;
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).slice(0, 6) : []);
  return {
    model,
    consensus: arr(parsed.consensus),
    conflicts: arr(parsed.conflicts),
    risks: arr(parsed.risks),
    suggestions: arr(parsed.suggestions),
    confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
    summary: String(parsed.summary ?? "").slice(0, 300),
  };
}

interface JudgeVerdict {
  riskAssessment: string;
  finalVerdict: "approve" | "modify" | "reject";
  recommendedActions: string[];
  confidence: number;
  degraded: boolean;
}

async function judgeReviews(reviews: ModelReview[], judgeModel: string): Promise<JudgeVerdict> {
  const raw = await chat(
    judgeModel,
    JUDGE_PROMPT,
    JSON.stringify(reviews.map((r) => ({ model: r.model, risks: r.risks, conflicts: r.conflicts, consensus: r.consensus, suggestions: r.suggestions, summary: r.summary })), null, 1),
    500
  );
  const parsed = raw ? extractJson<Partial<JudgeVerdict>>(raw) : null;
  if (parsed && typeof parsed.riskAssessment === "string" && parsed.riskAssessment) {
    const verdict = parsed.finalVerdict === "approve" || parsed.finalVerdict === "modify" || parsed.finalVerdict === "reject"
      ? parsed.finalVerdict
      : "modify";
    const actions = Array.isArray(parsed.recommendedActions) ? parsed.recommendedActions.map(String).slice(0, 5) : [];
    return {
      riskAssessment: String(parsed.riskAssessment).slice(0, 600),
      finalVerdict: verdict,
      recommendedActions: actions,
      confidence: typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
      degraded: false,
    };
  }
  // Judge 失败 → 降级：按风险计数生成保守结论，绝不丢预审结果
  const totalRisks = reviews.reduce((n, r) => n + r.risks.length, 0);
  return {
    riskAssessment: `（Judge 汇总失败，降级结论）${reviews.length} 个模型共报告 ${totalRisks} 条风险，请人工逐条阅读下方各模型意见。`,
    finalVerdict: totalRisks >= 5 ? "reject" : "modify",
    recommendedActions: ["阅读各模型风险清单后决策"],
    confidence: 0.3,
    degraded: true,
  };
}

/** 进程内去重：LLM 一轮要 2-4 分钟，期间 tick 每 30s 会重复触发，
 *  DB 幂等标记要等第一条消息落库才生效，拦不住并发窗口 */
const inFlight = new Set<number>();

export function triggerFusionPreReview(taskId: number, riskTypes: readonly string[]): void {
  if (inFlight.has(taskId)) return; // 并发窗口去重
  inFlight.add(taskId);
  setImmediate(async () => {
    const tag = `[fusion-prereview] task=${taskId}`;
    try {
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((r) => r[0]);
      if (!task) return;

      // 只处理仍处「待执行审批」的（可能已被人工处理）
      const state = getApprovalState(task.input);
      const stillPending = task.boardStatus === "blocked" && state.required && state.decision === "pending";
      if (!stillPending) return;

      // 红线才预审（非红线走自动审批链路）
      const redHit = riskTypes.filter((r) => RED_LINE_RISKS.has(r));
      if (redHit.length === 0) return;

      // 幂等：该任务已做过预审则跳过（防重复扣费）
      const existing = await db
        .select({ metadata: taskMessages.metadata })
        .from(taskMessages)
        .where(eq(taskMessages.taskId, taskId));
      if (existing.some((m) => {
        try {
          const md = typeof m.metadata === "string" ? JSON.parse(m.metadata || "{}") : m.metadata;
          return md?.action === "fusion_prereview";
        } catch { return false; }
      })) {
        console.log(`${tag} already prereviewed, skip`);
        return;
      }

      // 日限额
      const [count, limit] = [await dailyCount(), await dailyLimit()];
      if (count >= limit) {
        console.log(`${tag} daily limit reached ${count}/${limit}, skip`);
        return;
      }

      const assistantId = await ensureAssistantAgent();
      const payload = [
        `任务编号: ${task.taskId}`,
        `任务名: ${task.name}`,
        task.description ? `描述: ${task.description}` : null,
        `命中红线风险类型: ${redHit.join(", ")}`,
        task.input ? `输入: ${task.input.slice(0, 1500)}` : null,
      ].filter(Boolean).join("\n");

      // 多模型并行独立审查
      const judgeModel = await getAssistantModel();
      const models = await pickModels(3);
      const candidates = models.length > 0 ? models : [judgeModel];
      const reviews = (await Promise.all(candidates.map((m) => reviewWithModel(m, payload)))).filter(
        (r): r is ModelReview => r !== null
      );
      if (reviews.length === 0) {
        console.warn(`${tag} all model reviews failed, no prereview written`);
        return;
      }

      const judge = await judgeReviews(reviews, judgeModel);

      const verdictIcon = judge.finalVerdict === "approve" ? "🟢" : judge.finalVerdict === "modify" ? "🟡" : "🔴";
      const verdictText = judge.finalVerdict === "approve" ? "倾向可执行" : judge.finalVerdict === "modify" ? "建议修改后执行" : "建议拒绝";
      const content = [
        `🔍 Fusion 预审（${reviews.length} 模型：${reviews.map((r) => r.model).join("、")}）`,
        `${verdictIcon} 综合结论：${verdictText}${judge.degraded ? "（Judge 降级）" : ""}`,
        `风险评估：${judge.riskAssessment}`,
        judge.recommendedActions.length > 0 ? `建议动作：\n${judge.recommendedActions.map((a) => `- ${a}`).join("\n")}` : null,
      ].filter(Boolean).join("\n");

      await db.insert(taskMessages).values({
        taskId,
        fromAgentId: assistantId,
        eventType: "system",
        content,
        metadata: JSON.stringify({
          action: "fusion_prereview",
          traceId: `prereview-${task.taskId}-${Date.now().toString(36)}`,
          redLineRisks: redHit,
          models: reviews.map((r) => r.model),
          reviews,
          judge,
        }),
      });
      await bumpDailyCount();

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "prereview_completed",
        id: task.id,
        taskId: task.taskId,
        name: task.name,
        status: task.status,
        agentId: assistantId,
        timestamp: new Date().toISOString(),
      });

      console.log(`${tag} done: ${reviews.length} models, verdict=${judge.finalVerdict}`);
    } catch (e) {
      // fail-safe：预审失败绝不影响任务停放状态，人工照常审批
      console.warn(`${tag} error (task stays parked):`, e instanceof Error ? e.message : e);
    } finally {
      inFlight.delete(taskId);
    }
  });
}
