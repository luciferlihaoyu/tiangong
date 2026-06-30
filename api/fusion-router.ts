/**
 * P10.1: Fusion 审查模式
 *
 * 借鉴 OpenRouter Fusion Router，实现多模型并行审查 + Judge 汇总。
 *
 * 流程：
 * 1. 主模型输出结果后，提交审查请求
 * 2. 系统选择 2-3 个审查 Agent 并行执行
 * 3. 每个审查 Agent 返回点评（共识/分歧/风险/建议）
 * 4. Judge 汇总所有审查结果，生成最终报告
 * 5. 全程记录 traceId，串联任务、审查、模型调用
 */
import { z } from "zod";
import { createRouter, publicQuery, authedQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { agents, tasks, messages } from "@db/schema";
import { eq, and, inArray, desc, sql, type SQL } from "drizzle-orm";
import { wsManager } from "./ws-manager";

/* ═══════════════════════════════════════════
   类型定义
   ═══════════════════════════════════════════ */

interface ReviewResult {
  reviewerId: number;
  reviewerName: string;
  reviewerModel: string;
  consensus: string[];
  conflicts: string[];
  risks: string[];
  suggestions: string[];
  confidence: number; // 0-1
  rawOutput: string;
  completedAt: string;
}

interface JudgeResult {
  consensus: string[];
  conflicts: string[];
  coverageGaps: string[];
  uniqueInsights: string[];
  blindSpots: string[];
  riskAssessment: string;
  recommendedActions: string[];
  finalVerdict: string;
  confidence: number;
  generatedAt: string;
}

interface FusionReport {
  id: number;
  traceId: string;
  taskId: number | null;
  agentId: number | null;
  subject: string;
  content: string;
  reviewers: ReviewResult[];
  judge: JudgeResult | null;
  status: string;
  createdAt: string;
}

/* ═══════════════════════════════════════════
   审查 Agent 选择逻辑
   ═══════════════════════════════════════════ */

/**
 * 根据审查主题选择合适的审查 Agent
 * 优先选择不同模型/角色的 Agent，保证多样性
 */
async function selectReviewers(
  subject: string,
  count: number = 3
): Promise<Array<{ id: number; name: string; agentId: string; model: string; role: string }>> {
  const db = getDb();

  // 获取所有在线且非 idle 的 Agent
  const allAgents = await db
    .select({
      id: agents.id,
      name: agents.name,
      agentId: agents.agentId,
      model: agents.model,
      role: agents.role,
      status: agents.status,
    })
    .from(agents)
    .where(
      and(
        sql`${agents.status} IN ('online', 'busy', 'idle')`,
        sql`${agents.model} IS NOT NULL`,
        sql`${agents.model} != ''`
      )
    );

  if (allAgents.length === 0) return [];

  // 按角色/模型多样性排序
  // 优先选不同模型的 Agent
  const seenModels = new Set<string>();
  const reviewers: typeof allAgents = [];

  for (const agent of allAgents) {
    if (reviewers.length >= count) break;
    const model = agent.model || "unknown";
    if (!seenModels.has(model)) {
      seenModels.add(model);
      reviewers.push(agent);
    }
  }

  // 如果还不够，补选
  if (reviewers.length < count) {
    for (const agent of allAgents) {
      if (reviewers.length >= count) break;
      if (!reviewers.find((r) => r.id === agent.id)) {
        reviewers.push(agent);
      }
    }
  }

  return reviewers.map((a) => ({
    id: a.id,
    name: a.name || a.agentId,
    agentId: a.agentId,
    model: a.model || "unknown",
    role: a.role || "reviewer",
  }));
}

/* ═══════════════════════════════════════════
   审查 Prompt 生成
   ═══════════════════════════════════════════ */

function buildReviewPrompt(subject: string, content: string, reviewerName: string, reviewerRole: string): string {
  return [
    `你被天宫 Fusion 审查系统分配了一个审查任务。`,
    ``,
    `## 审查主题`,
    subject,
    ``,
    `## 待审查内容`,
    content,
    ``,
    `## 你的角色`,
    `审查者: ${reviewerName}`,
    `职责: ${reviewerRole}`,
    ``,
    `## 审查要求`,
    `请从以下维度分析：`,
    `1. **共识点** — 你认同的内容`,
    `2. **分歧点** — 你有不同意见的内容`,
    `3. **风险点** — 你发现的风险或问题`,
    `4. **改进建议** — 你的具体建议`,
    `5. **置信度** — 你对审查结论的信心 (0-1)`,
    ``,
    `请以 JSON 格式输出：`,
    `{`,
    `  "consensus": ["..."],`,
    `  "conflicts": ["..."],`,
    `  "risks": ["..."],`,
    `  "suggestions": ["..."],`,
    `  "confidence": 0.85`,
    `}`,
    ``,
    `请确保 JSON 有效，不要包含其他内容。`,
  ].join("\n");
}

function buildJudgePrompt(
  subject: string,
  content: string,
  reviews: ReviewResult[]
): string {
  const reviewsText = reviews
    .map(
      (r, i) =>
        `## 审查者 ${i + 1}: ${r.reviewerName} (${r.reviewerModel})\n` +
        `共识: ${r.consensus.join(", ") || "(无)"}\n` +
        `分歧: ${r.conflicts.join(", ") || "(无)"}\n` +
        `风险: ${r.risks.join(", ") || "(无)"}\n` +
        `建议: ${r.suggestions.join(", ") || "(无)"}\n` +
        `置信度: ${r.confidence}`
    )
    .join("\n\n");

  return [
    `你被天宫 Fusion 审查系统指定为 Judge。`,
    ``,
    `## 审查主题`,
    subject,
    ``,
    `## 原始内容`,
    content,
    ``,
    `## 审查结果汇总`,
    reviewsText,
    ``,
    `## Judge 职责`,
    `请综合分析所有审查结果，输出：`,
    `1. **最终共识** — 所有审查者一致认同的结论`,
    `2. **主要分歧** — 审查者之间的分歧点`,
    `3. **覆盖盲区** — 所有审查者都未覆盖的方面`,
    `4. **独特洞见** — 某个审查者独有的有价值的观点`,
    `5. **盲点** — 被忽略但重要的方面`,
    `6. **风险评估** — 综合风险判断`,
    `7. **建议行动** — 具体建议`,
    `8. **最终裁决** — 你的最终结论`,
    `9. **置信度** — 你对最终裁决的信心 (0-1)`,
    ``,
    `请以 JSON 格式输出：`,
    `{`,
    `  "consensus": ["..."],`,
    `  "conflicts": ["..."],`,
    `  "coverageGaps": ["..."],`,
    `  "uniqueInsights": ["..."],`,
    `  "blindSpots": ["..."],`,
    `  "riskAssessment": "...",`,
    `  "recommendedActions": ["..."],`,
    `  "finalVerdict": "...",`,
    `  "confidence": 0.9`,
    `}`,
    ``,
    `请确保 JSON 有效，不要包含其他内容。`,
  ].join("\n");
}

/* ═══════════════════════════════════════════
   Fusion Router
   ═══════════════════════════════════════════ */

export const fusionRouter = createRouter({
  /**
   * 提交审查请求
   * 选择审查 Agent 并发送审查任务
   */
  submit: authedQuery
    .input(
      z.object({
        subject: z.string().min(1).max(500),
        content: z.string().min(1),
        taskId: z.number().optional(),
        agentId: z.number().optional(),
        reviewerCount: z.number().int().min(2).max(5).default(3),
        traceId: z.string().max(64).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const traceId = input.traceId || `fusion-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      // 选择审查 Agent
      const reviewers = await selectReviewers(input.subject, input.reviewerCount);

      if (reviewers.length < 2) {
        return {
          success: false,
          error: "可用审查 Agent 不足，至少需要 2 个",
          traceId,
        };
      }

      // 为每个审查者创建审查任务
      const reviewTasks: Array<{
        reviewer: typeof reviewers[0];
        reviewPrompt: string;
      }> = reviewers.map((reviewer) => ({
        reviewer,
        reviewPrompt: buildReviewPrompt(input.subject, input.content, reviewer.name, reviewer.role),
      }));

      // 创建 Fusion 审查记录
      const fusionId = `fusion-${traceId}`;

      // 为每个审查者发送消息
      const sentMessages: Array<{ reviewerId: number; messageId: number | null }> = [];

      for (const { reviewer, reviewPrompt } of reviewTasks) {
        const result = await db.insert(messages).values({
          fromAgent: input.agentId ?? 1, // 默认从美智子发出
          toAgent: reviewer.id,
          content: reviewPrompt,
          type: "command",
          status: "sent",
          correlationId: traceId,
          idempotencyKey: `fusion:${traceId}:${reviewer.id}`,
          taskId: input.taskId ?? null,
          priority: 10, // 审查任务较高优先级
        });
        const messageId = (result as any).insertId as number | undefined;

        // 如果审查者在线，实时推送
        if (messageId && wsManager.isOnline(reviewer.id)) {
          const pushed = await db
            .select()
            .from(messages)
            .where(eq(messages.id, messageId))
            .then((rows) => rows[0]);
          if (pushed) {
            await wsManager.sendToAgent(reviewer.id, {
              type: "fusion_review",
              message: pushed,
              traceId,
              subject: input.subject,
            });
            await db
              .update(messages)
              .set({ status: "delivered", deliveredAt: new Date() })
              .where(eq(messages.id, messageId));
          }
        }

        sentMessages.push({ reviewerId: reviewer.id, messageId: messageId ?? null });
      }

      // 广播事件
      wsManager.broadcastToDashboard({
        type: "fusion_submitted",
        traceId,
        subject: input.subject,
        reviewerCount: reviewers.length,
        reviewers: reviewers.map((r) => ({ id: r.id, name: r.name, model: r.model })),
        timestamp: new Date().toISOString(),
      });

      return {
        success: true,
        traceId,
        reviewers: reviewers.map((r) => ({ id: r.id, name: r.name, model: r.model, role: r.role })),
        messages: sentMessages,
      };
    }),

  /**
   * 提交审查结果（由审查 Agent 调用）
   */
  submitReview: authedQuery
    .input(
      z.object({
        traceId: z.string().max(64),
        reviewerId: z.number(),
        consensus: z.array(z.string()).default([]),
        conflicts: z.array(z.string()).default([]),
        risks: z.array(z.string()).default([]),
        suggestions: z.array(z.string()).default([]),
        confidence: z.number().min(0).max(1).default(0.5),
        rawOutput: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      // 获取审查者信息
      const reviewer = await db
        .select({ id: agents.id, name: agents.name, model: agents.model })
        .from(agents)
        .where(eq(agents.id, input.reviewerId))
        .then((rows) => rows[0]);

      if (!reviewer) {
        return { success: false, error: "审查者不存在" };
      }

      // 存储审查结果到 messages 表（作为 response 类型）
      const reviewContent = JSON.stringify({
        type: "fusion_review_result",
        traceId: input.traceId,
        reviewerId: input.reviewerId,
        reviewerName: reviewer.name,
        reviewerModel: reviewer.model,
        consensus: input.consensus,
        conflicts: input.conflicts,
        risks: input.risks,
        suggestions: input.suggestions,
        confidence: input.confidence,
        rawOutput: input.rawOutput,
        completedAt: new Date().toISOString(),
      });

      await db.insert(messages).values({
        fromAgent: input.reviewerId,
        toAgent: 1, // 发回给美智子（协调者）
        content: reviewContent,
        type: "response",
        status: "sent",
        correlationId: input.traceId,
        idempotencyKey: `fusion-review:${input.traceId}:${input.reviewerId}`,
        priority: 10,
      });

      // 广播审查完成事件
      wsManager.broadcastToDashboard({
        type: "fusion_review_completed",
        traceId: input.traceId,
        reviewerId: input.reviewerId,
        reviewerName: reviewer.name,
        confidence: input.confidence,
        timestamp: new Date().toISOString(),
      });

      return { success: true, traceId: input.traceId, reviewerId: input.reviewerId };
    }),

  /**
   * 提交 Judge 裁决（由 Judge Agent 调用）
   */
  submitJudge: authedQuery
    .input(
      z.object({
        traceId: z.string().max(64),
        consensus: z.array(z.string()).default([]),
        conflicts: z.array(z.string()).default([]),
        coverageGaps: z.array(z.string()).default([]),
        uniqueInsights: z.array(z.string()).default([]),
        blindSpots: z.array(z.string()).default([]),
        riskAssessment: z.string(),
        recommendedActions: z.array(z.string()).default([]),
        finalVerdict: z.string(),
        confidence: z.number().min(0).max(1).default(0.5),
      })
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      const judgeContent = JSON.stringify({
        type: "fusion_judge_result",
        traceId: input.traceId,
        consensus: input.consensus,
        conflicts: input.conflicts,
        coverageGaps: input.coverageGaps,
        uniqueInsights: input.uniqueInsights,
        blindSpots: input.blindSpots,
        riskAssessment: input.riskAssessment,
        recommendedActions: input.recommendedActions,
        finalVerdict: input.finalVerdict,
        confidence: input.confidence,
        generatedAt: new Date().toISOString(),
      });

      await db.insert(messages).values({
        fromAgent: 1, // Judge 由协调者（美智子）执行
        toAgent: 1,
        content: judgeContent,
        type: "response",
        status: "sent",
        correlationId: input.traceId,
        idempotencyKey: `fusion-judge:${input.traceId}`,
        priority: 10,
      });

      // 广播 Fusion 完成事件
      wsManager.broadcastToDashboard({
        type: "fusion_completed",
        traceId: input.traceId,
        finalVerdict: input.finalVerdict,
        confidence: input.confidence,
        consensusCount: input.consensus.length,
        conflictsCount: input.conflicts.length,
        timestamp: new Date().toISOString(),
      });

      return { success: true, traceId: input.traceId };
    }),

  /**
   * 查询 Fusion 审查状态
   */
  status: publicQuery
    .input(z.object({ traceId: z.string().max(64) }))
    .query(async ({ input }) => {
      const db = getDb();

      // 查找该 traceId 下的所有相关消息
      const allMessages = await db
        .select()
        .from(messages)
        .where(eq(messages.correlationId, input.traceId))
        .orderBy(desc(messages.createdAt));

      // 按类型分类
      const reviewMessages = allMessages.filter(
        (m) => m.type === "response" && m.content?.includes("fusion_review_result")
      );
      const judgeMessages = allMessages.filter(
        (m) => m.type === "response" && m.content?.includes("fusion_judge_result")
      );
      const commandMessages = allMessages.filter((m) => m.type === "command");

      // 解析审查结果
      const reviews: ReviewResult[] = [];
      for (const msg of reviewMessages) {
        try {
          const parsed = JSON.parse(msg.content || "{}");
          if (parsed.type === "fusion_review_result") {
            reviews.push({
              reviewerId: parsed.reviewerId,
              reviewerName: parsed.reviewerName,
              reviewerModel: parsed.reviewerModel,
              consensus: parsed.consensus || [],
              conflicts: parsed.conflicts || [],
              risks: parsed.risks || [],
              suggestions: parsed.suggestions || [],
              confidence: parsed.confidence || 0,
              rawOutput: parsed.rawOutput || "",
              completedAt: parsed.completedAt,
            });
          }
        } catch {}
      }

      // 解析 Judge 结果
      let judge: JudgeResult | null = null;
      for (const msg of judgeMessages) {
        try {
          const parsed = JSON.parse(msg.content || "{}");
          if (parsed.type === "fusion_judge_result") {
            judge = {
              consensus: parsed.consensus || [],
              conflicts: parsed.conflicts || [],
              coverageGaps: parsed.coverageGaps || [],
              uniqueInsights: parsed.uniqueInsights || [],
              blindSpots: parsed.blindSpots || [],
              riskAssessment: parsed.riskAssessment || "",
              recommendedActions: parsed.recommendedActions || [],
              finalVerdict: parsed.finalVerdict || "",
              confidence: parsed.confidence || 0,
              generatedAt: parsed.generatedAt,
            };
          }
        } catch {}
      }

      const status = judge ? "completed" : reviews.length > 0 ? "reviewing" : "pending";

      return {
        traceId: input.traceId,
        status,
        reviewerCount: commandMessages.length,
        reviewCompleted: reviews.length,
        judgeCompleted: judge !== null,
        reviews,
        judge,
        messages: allMessages.map((m) => ({
          id: m.id,
          type: m.type,
          fromAgent: m.fromAgent,
          toAgent: m.toAgent,
          status: m.status,
          createdAt: m.createdAt,
        })),
      };
    }),

  /**
   * 获取所有 Fusion 审查记录
   */
  list: publicQuery
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(20),
          status: z.enum(["pending", "reviewing", "completed"]).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();

      // 从 messages 表中查找所有 fusion 相关的 correlationId
      const fusionMessages = await db
        .select({
          correlationId: messages.correlationId,
          type: messages.type,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(
          and(
            sql`${messages.correlationId} LIKE 'fusion-%'`,
            eq(messages.type, "command")
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(input?.limit ?? 20);

      // 去重，按 correlationId 分组
      const seen = new Set<string>();
      const results: Array<{
        traceId: string;
        subject: string;
        status: string;
        createdAt: string;
      }> = [];

      for (const msg of fusionMessages) {
        if (!msg.correlationId || seen.has(msg.correlationId)) continue;
        seen.add(msg.correlationId);

        // 尝试从内容中提取 subject
        let subject = "(未知)";
        const lines = (msg.content || "").split("\n");
        for (const line of lines) {
          if (line.startsWith("## 审查主题")) {
            const idx = lines.indexOf(line);
            if (idx >= 0 && idx + 1 < lines.length) {
              subject = lines[idx + 1].trim();
            }
            break;
          }
        }

        // 检查是否有 judge 结果
        const judgeMsgs = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.correlationId, msg.correlationId),
              sql`${messages.content} LIKE '%fusion_judge_result%'`
            )
          )
          .limit(1);

        const reviewMsgs = await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.correlationId, msg.correlationId),
              sql`${messages.content} LIKE '%fusion_review_result%'`
            )
          )
          .limit(1);

        const status = judgeMsgs.length > 0 ? "completed" : reviewMsgs.length > 0 ? "reviewing" : "pending";

        results.push({
          traceId: msg.correlationId,
          subject,
          status,
          createdAt: msg.createdAt?.toISOString?.() || String(msg.createdAt),
        });
      }

      return results;
    }),
});
