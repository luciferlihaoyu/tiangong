/**
 * AI 助手路由：模型查看/切换（存 system_settings，立即生效）
 * - getModel：当前助手模型 + 可用列表（复用 tianshu.listModels 的上游）
 * - setModel：切换模型（admin）
 */
import { z } from "zod";
import { createRouter, publicQuery, adminQuery } from "./middleware";
import { getAssistantModel, ASSISTANT_MODEL_KEY, ASSISTANT_NAME } from "./lib/ai-assistant";
import { setSetting } from "./lib/settings";

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
});
