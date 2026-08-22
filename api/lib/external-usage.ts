/**
 * 外部执行路径的公共用量记账 helper（任务 1.4）
 *
 * 外部执行体（dsh-poller 等）经 task.updateProgress 回写任务结果时，
 * 服务端按 model-pricing 折算成本：写一行 token_usage（provider="external"），
 * 并原子递增 agents.spentCents——让 guard_check 的预算熔断对外部执行体同样生效
 * （此前只有内部 Runner / guard 路径记账，外部任务的模型消耗永远不进 spentCents）。
 *
 * 单位约定（本模块最容易踩的坑，务必注意）：
 *   - calculateCost 返回的 costMicros 是微美元（1 USD = 1,000,000 micros）
 *   - token_usage.costMicros 存微美元；token_usage.costCents 与
 *     agents.spentCents / agents.budgetCents 存美分
 *   - 1 美分 = 10,000 微美元 → 美分 = Math.round(costMicros / 10000)（整数运算，避免浮点漂移）
 *
 * 整体尽力而为：任何异常只 warn 不抛出，绝不影响任务完成主流程。
 */
import { eq, sql } from "drizzle-orm";
import { agents, tokenUsage } from "@db/schema";
import { resolveModelPricing, calculateCost, buildTokenUsageValues } from "./model-pricing";
import type { Db } from "./execution-gate";

/** 微美元 → 美分（1 美分 = 10,000 微美元），四舍五入到整数美分 */
export function microsToCents(costMicros: number): number {
  return Math.round(costMicros / 10000);
}

export interface RecordExternalUsageParams {
  taskId: number;
  /** 任务认领人；为空时只写 token_usage，不递增任何 agent 的预算消耗 */
  agentId?: number | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number;
  /** token_usage.source（varchar(20)），默认 "external" */
  source?: string;
}

/**
 * 记一笔外部执行体的模型用量：
 *   1. resolveModelPricing 按上下文长度选档 → calculateCost 折算成本
 *   2. 写 token_usage 一行（provider="external"，source 用入参）
 *   3. 原子递增 agents.spentCents（guard-router 同款 COALESCE SQL 模式，防并发丢失更新）
 */
export async function recordExternalUsage(db: Db, params: RecordExternalUsageParams): Promise<void> {
  try {
    const promptTokens = params.promptTokens ?? 0;
    const completionTokens = params.completionTokens ?? 0;
    const cachedPromptTokens = Math.max(0, params.cachedPromptTokens ?? 0);
    const uncachedPromptTokens = Math.max(0, promptTokens - cachedPromptTokens);

    // 分层定价模型按本次请求的实际上下文长度选档计价（与 task-runner 记账口径一致）
    const pricing = await resolveModelPricing(params.model, promptTokens);
    const costResult = calculateCost(pricing, cachedPromptTokens, uncachedPromptTokens, completionTokens);

    await db.insert(tokenUsage).values(
      buildTokenUsageValues(
        {
          model: params.model,
          provider: "external",
          promptTokens,
          completionTokens,
          cachedPromptTokens,
          uncachedPromptTokens,
          callCount: 1,
          taskId: params.taskId,
          agentId: params.agentId ?? undefined,
          source: params.source ?? "external",
        },
        costResult
      )
    );

    // 预算消耗按"微美元 → 美分"换算后的整数美分入账（costCents 字段同口径）
    const cents = microsToCents(costResult.costMicros);
    if (params.agentId && cents > 0) {
      await db
        .update(agents)
        .set({
          spentCents: sql`COALESCE(${agents.spentCents}, 0) + ${cents}`,
        })
        .where(eq(agents.id, params.agentId));
    }
  } catch (e) {
    // 尽力而为：记账失败绝不影响任务完成/回写主流程
    console.warn(
      `[external-usage] 记账失败 (task=${params.taskId}, model=${params.model}): ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
