/**
 * 自动审批（Auto-Approve）：天宫助手审查被审批闸门停放的任务
 *
 * 触发：task-runner 停放任务后 → triggerAutoReview(taskId)
 *
 * 决策流程：
 *   1. 开关检查（默认关闭）：system_settings auto_approve_enabled = "1" 才启用
 *   2. 红线检查：红线风险类型永不自动批 → 评论说明，保持人工
 *   3. 日限额：auto_approve_daily_limit（默认 10）
 *   4. LLM 审查：助手模型读任务内容 → 严格 JSON {"decision":"approve"|"escalate","reason"}
 *      只有明确 approve 才放行；解析失败/escalate/超时 → 一律保持人工
 *   5. 放行：复用 approve 端点同款逻辑（blocked→ready/queued），审计 + 通知
 *
 * 安全护栏：
 *   - 默认关闭，需管理员显式开启
 *   - 红线类型（删除/发布/部署/密钥）永不自动批
 *   - 每日限额
 *   - 全部决策写 taskMessages（eventType=auto_approve）+ 控制台审计日志
 */

import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { tasks, taskMessages } from "../../db/schema";
import { getSetting, setSetting } from "./settings";
import { getApprovalState, approveTaskMetadata } from "./execution-gate";
import { getAssistantModel, ensureAssistantAgent } from "./ai-assistant";
import { wsManager } from "../ws-manager";

const ENABLED_KEY = "auto_approve_enabled";
const DAILY_LIMIT_KEY = "auto_approve_daily_limit";
const DEFAULT_DAILY_LIMIT = 10;

/** 红线：这些风险类型永不自动批准，必须人工 */
const RED_LINE_RISKS = new Set([
  "github_merge",
  "github_release",
  "zeabur_deploy",
  "zeabur_delete_service",
  "storage_delete",
  "mcp_key_change",
]);

const REVIEW_PROMPT = `你是天宫的审批审查员。一个任务因风险标记被闸门停放，等待审批。
请审查任务内容，判断是否安全到可以自动批准执行。

判断标准：
- approve：任务内容明确、目的正当、操作可逆或影响有限（如：提交文档更新、发送普通通知、调用只读接口）
- escalate：任何不确定、涉及删除/覆盖/对外发布/凭据/支付/生产环境变更，或任务描述含糊

只输出严格 JSON（不要其他任何文字）：
{"decision":"approve"|"escalate","reason":"一句话中文理由"}`;

function todayKey(): string {
  return `auto_approve_count:${new Date().toISOString().slice(0, 10)}`;
}

async function isEnabled(): Promise<boolean> {
  const v = await getSetting(ENABLED_KEY).catch(() => null);
  return (v || "").trim() === "1";
}

async function dailyCount(): Promise<number> {
  const v = await getSetting(todayKey()).catch(() => null);
  return parseInt(v || "0", 10) || 0;
}

async function bumpDailyCount(): Promise<void> {
  await setSetting(todayKey(), String((await dailyCount()) + 1), "auto_approve").catch(() => undefined);
}

async function dailyLimit(): Promise<number> {
  const v = await getSetting(DAILY_LIMIT_KEY).catch(() => null);
  return parseInt(v || "", 10) || DEFAULT_DAILY_LIMIT;
}

function tianshuBaseUrl(): string {
  return (process.env.TIANSHU_BASE_URL || "https://tianshu.xianrealme.com").replace(/\/+$/, "");
}

interface ReviewDecision {
  decision: "approve" | "escalate";
  reason: string;
}

async function llmReview(taskPayload: string): Promise<ReviewDecision | null> {
  const apiKey = (process.env.TIANSHU_API_KEY || "").trim();
  if (!apiKey) return null;
  const model = await getAssistantModel();
  try {
    const resp = await fetch(`${tianshuBaseUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: REVIEW_PROMPT },
          { role: "user", content: taskPayload },
        ],
        max_tokens: 300,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = (data.choices?.[0]?.message?.content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim();
    // 抽取第一个 JSON 对象（模型可能包 markdown fence）
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as Partial<ReviewDecision>;
    if (parsed.decision !== "approve" && parsed.decision !== "escalate") return null;
    return { decision: parsed.decision, reason: String(parsed.reason ?? "").slice(0, 200) };
  } catch {
    return null;
  }
}

/** 给任务线程写一条审查记录 */
async function writeReviewNote(taskId: number, assistantId: number, content: string, decisionMeta: object): Promise<void> {
  const db = getDb();
  await db.insert(taskMessages).values({
    taskId,
    fromAgentId: assistantId,
    eventType: "system",
    content,
    metadata: JSON.stringify({ action: "auto_approve_review", ...decisionMeta }),
  });
}

/**
 * 停放任务后触发自动审查（fire-and-forget）
 * 由 task-runner 在 parkTaskForApproval 之后调用。
 */
export function triggerAutoReview(taskId: number): void {
  setImmediate(async () => {
    const tag = `[auto-approve] task=${taskId}`;
    try {
      if (!(await isEnabled())) return; // 默认关闭，静默退出

      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, taskId)).then((r) => r[0]);
      if (!task) return;

      // 只处理仍处于「待执行审批」状态的（可能已被人工处理）
      const state = getApprovalState(task.input);
      const stillPending =
        task.boardStatus === "blocked" && state.required && state.decision === "pending";
      if (!stillPending) return;

      const assistantId = await ensureAssistantAgent();
      const riskTypes = state.riskTypes ?? [];

      // 红线检查
      const redHit = riskTypes.filter((r) => RED_LINE_RISKS.has(r));
      if (redHit.length > 0) {
        await writeReviewNote(
          taskId,
          assistantId,
          `🤖 自动审批跳过：命中红线风险类型（${redHit.join(", ")}），必须人工审批。`,
          { decision: "red_line", riskTypes }
        );
        console.log(`${tag} red line: ${redHit.join(",")}`);
        return;
      }

      // 日限额
      const [count, limit] = [await dailyCount(), await dailyLimit()];
      if (count >= limit) {
        await writeReviewNote(
          taskId,
          assistantId,
          `🤖 自动审批跳过：今日自动批准已达上限（${count}/${limit}），转人工。`,
          { decision: "limit_exceeded", count, limit }
        );
        console.log(`${tag} daily limit reached ${count}/${limit}`);
        return;
      }

      // LLM 审查
      const payload = [
        `任务编号: ${task.taskId}`,
        `任务名: ${task.name}`,
        task.description ? `描述: ${task.description}` : null,
        `风险类型: ${riskTypes.join(", ") || "未知"}`,
        task.input ? `输入: ${task.input.slice(0, 1500)}` : null,
      ].filter(Boolean).join("\n");

      const review = await llmReview(payload);
      if (!review || review.decision !== "approve") {
        await writeReviewNote(
          taskId,
          assistantId,
          `🤖 自动审批：${review ? `建议转人工——${review.reason}` : "LLM 审查失败/超时，转人工"}`,
          { decision: review?.decision ?? "llm_failed", reason: review?.reason ?? null }
        );
        console.log(`${tag} escalate: ${review?.reason ?? "llm failed"}`);
        return;
      }

      // ── 放行（复用 approve 端点逻辑）──
      await db
        .update(tasks)
        .set({
          boardStatus: "ready",
          status: "queued",
          boardNotes: task.boardNotes
            ? `${task.boardNotes} · auto-approved by 天宫助手`
            : "Auto-approved by 天宫助手",
          reviewResult: "approved",
          reviewerId: assistantId,
          input: approveTaskMetadata(task.input),
          blockedAt: null,
          readyAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(tasks.id, taskId));

      await writeReviewNote(
        taskId,
        assistantId,
        `🤖 自动批准执行：${review.reason}（风险类型：${riskTypes.join(", ") || "无"}）`,
        { decision: "approve", reason: review.reason, riskTypes }
      );
      await bumpDailyCount();

      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "approved",
        id: task.id,
        taskId: task.taskId,
        name: task.name,
        status: "queued",
        agentId: assistantId,
        timestamp: new Date().toISOString(),
      });

      console.log(`${tag} AUTO-APPROVED (${riskTypes.join(",")}): ${review.reason}`);
    } catch (e) {
      // 任何异常都必须 fail-safe 到人工——绝不因 bug 放行
      console.warn(`[auto-approve] task=${taskId} error (task stays parked):`, e instanceof Error ? e.message : e);
    }
  });
}
