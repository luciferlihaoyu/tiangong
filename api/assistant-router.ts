/**
 * AI 助手路由：模型查看/切换（存 system_settings，立即生效）
 * - getModel：当前助手模型 + 可用列表（复用 tianshu.listModels 的上游）
 * - setModel：切换模型（admin）
 */
import { z } from "zod";
import { createRouter, publicQuery, adminQuery } from "./middleware";
import { getAssistantModel, ASSISTANT_MODEL_KEY, ASSISTANT_NAME } from "./lib/ai-assistant";
import { getSetting, setSetting } from "./lib/settings";

const AUTO_APPROVE_ENABLED_KEY = "auto_approve_enabled";
const AUTO_APPROVE_LIMIT_KEY = "auto_approve_daily_limit";

export const assistantRouter = createRouter({
  /** 当前助手模型 */
  getModel: publicQuery.query(async () => ({
    model: await getAssistantModel(),
    assistantName: ASSISTANT_NAME,
  })),

  /** 切换助手模型（写入 system_settings，立即生效） */
  setModel: adminQuery
    .input(z.object({ model: z.string().min(1).max(100) }))
    .mutation(async ({ input }) => {
      await setSetting(ASSISTANT_MODEL_KEY, input.model, "assistant");
      return { success: true, model: input.model };
    }),

  /** 自动审批状态（开关 + 今日计数 + 限额 + 红线类型） */
  getAutoApprove: publicQuery.query(async () => {
    const enabled = ((await getSetting(AUTO_APPROVE_ENABLED_KEY).catch(() => null)) || "").trim() === "1";
    const limit = parseInt((await getSetting(AUTO_APPROVE_LIMIT_KEY).catch(() => null)) || "", 10) || 10;
    const todayKey = `auto_approve_count:${new Date().toISOString().slice(0, 10)}`;
    const count = parseInt((await getSetting(todayKey).catch(() => null)) || "0", 10) || 0;
    return {
      enabled,
      dailyLimit: limit,
      todayCount: count,
      redLineRisks: ["github_merge", "github_release", "zeabur_deploy", "zeabur_delete_service", "storage_delete", "mcp_key_change"],
    };
  }),

  /** 开关自动审批（admin；默认关闭。开启后天宫助手自动审查低风险停放任务） */
  setAutoApprove: adminQuery
    .input(z.object({ enabled: z.boolean(), dailyLimit: z.number().int().min(1).max(100).optional() }))
    .mutation(async ({ input }) => {
      await setSetting(AUTO_APPROVE_ENABLED_KEY, input.enabled ? "1" : "0", "auto_approve");
      if (input.dailyLimit !== undefined) {
        await setSetting(AUTO_APPROVE_LIMIT_KEY, String(input.dailyLimit), "auto_approve");
      }
      return { success: true, enabled: input.enabled };
    }),
});
