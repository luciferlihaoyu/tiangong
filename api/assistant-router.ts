/**
 * AI 助手路由：模型查看/切换、消息/任务系统接口
 * - getModel / setModel：助手模型（admin）
 * - getAutoApprove / setAutoApprove：自动审批状态/开关（admin）
 * - setAutoApproveBySecret / archiveFailedTasksBySecret：用 X-Admin-Token 旁路
 *   鉴权的运维端点（不需登录 JWT），给 runner / 运维脚本用。secret
 *   默认 = TIANSHU_API_KEY（容器内可读）。
 */
import { z } from "zod";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { createRouter, publicQuery, publicProcedure, adminQuery } from "./middleware";
import { getAssistantModel, ASSISTANT_MODEL_KEY, ASSISTANT_NAME } from "./lib/ai-assistant";
import { getSetting, setSetting } from "./lib/settings";
import { getDb } from "./queries/connection";
import { tasks} from "@db/schema";
import { finalizeFailedTask } from "./lib/task-finalize";

const AUTO_APPROVE_ENABLED_KEY = "auto_approve_enabled";
const AUTO_APPROVE_LIMIT_KEY = "auto_approve_daily_limit";

/** X-Admin-Token 共享秘钥：默认 TIANSHU_API_KEY（容器内可读到）。
 *  拿到这个 key 的人已能调 LLM，所以"再开放 admin 运维"不显著扩大攻击面。
 *  生产环境可显式设 TIANGONG_ADMIN_TOKEN 覆盖。 */
function resolveAdminSecret(): string {
  return (process.env.TIANGONG_ADMIN_TOKEN || process.env.TIANSHU_API_KEY || "").trim();
}

function checkAdminSecret(secret: string | null | undefined): boolean {
  const expected = resolveAdminSecret();
  if (!expected || !secret) return false;
  // 长度匹配避免极短秘钥 false-positive；严格相等（短 secret 实际不会部署）
  return secret.length === expected.length && secret === expected;
}

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

  /**
   * X-Admin-Token 旁路：开关自动审批（不需登录 JWT，给 dsh runner / 运维脚本用）
   * header: X-Admin-Token: <TIANGSHU_API_KEY>
   * 复用 setAutoApprove 的输入 schema。
   */
  setAutoApproveBySecret: publicProcedure
    .input(z.object({
      enabled: z.boolean(),
      dailyLimit: z.number().int().min(1).max(100).optional(),
      secret: z.string().min(1),
    }))
    .mutation(async ({ input }) => {
      if (!checkAdminSecret(input.secret)) {
        throw new Error("Unauthorized: X-Admin-Token mismatch");
      }
      await setSetting(AUTO_APPROVE_ENABLED_KEY, input.enabled ? "1" : "0", "auto_approve");
      if (input.dailyLimit !== undefined) {
        await setSetting(AUTO_APPROVE_LIMIT_KEY, String(input.dailyLimit), "auto_approve");
      }
      return { success: true, enabled: input.enabled };
    }),

  /**
   * X-Admin-Token 旁路：批量归档历史 failed 任务（同步：璇玑 lesson + AList）
   * 默认只处理 status=failed lifecycleStatus=failed 的任务（boardStatus 不限，
   * 覆盖 triage/running/done/blocked 等）。带 dryRun 预演。
   */
  archiveFailedTasksBySecret: publicProcedure
    .input(z.object({
      secret: z.string().min(1),
      dryRun: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(500).optional().default(50),
    }))
    .mutation(async ({ input }) => {
      if (!checkAdminSecret(input.secret)) {
        throw new Error("Unauthorized: X-Admin-Token mismatch");
      }
      const db = getDb();
      const rows = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.status, "failed"), ne(tasks.lifecycleStatus, "cancelled")))
        .limit(input.limit);
      if (input.dryRun) {
        return { dryRun: true, candidateCount: rows.length, ids: rows.map((r) => r.id) };
      }
      let archived = 0;
      const errors: Array<{ id: number; err: string }> = [];
      for (const row of rows) {
        try {
          await finalizeFailedTask(db, row);
          archived++;
        } catch (e) {
          errors.push({ id: row.id, err: e instanceof Error ? e.message : String(e) });
        }
      }
      return { dryRun: false, archived, total: rows.length, errors };
    }),
});
