/**
 * AI 助手路由：模型查看/切换、消息/任务系统接口
 * - getModel / setModel：助手模型（admin）
 * - getAutoApprove / setAutoApprove：自动审批状态/开关（admin）
 * - archiveFailedTasks：批量归档失败任务（admin）
 */
import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { createRouter, publicQuery, adminQuery } from "./middleware";
import { getAssistantModel, ASSISTANT_MODEL_KEY, ASSISTANT_NAME } from "./lib/ai-assistant";
import { getSetting, setSetting } from "./lib/settings";
import { getDb } from "./queries/connection";
import { tasks} from "@db/schema";
import { finalizeFailedTask } from "./lib/task-finalize";

const AUTO_APPROVE_ENABLED_KEY = "auto_approve_enabled";
const AUTO_APPROVE_LIMIT_KEY = "auto_approve_daily_limit";
const OPEN_WEBUI_URL_KEY = "openwebui_url";
/** 默认与首页 AppHub 外部应用卡片「Open Web UI」同地址（AppHub.tsx 硬编码，
 *  改动时两处同步）；system_settings(openwebui_url) 可覆盖 */
const DEFAULT_OPEN_WEBUI_URL = "https://oll199h.zeabur.app/";

/** 批量归档 failed 任务的实现：写璇玑 lesson + AList + 协作汇总（幂等由各 sync 自持） */
async function runArchiveFailedTasks(
  opts: { dryRun: boolean; limit: number; ids?: number[] }
): Promise<{
  dryRun: boolean;
  candidateCount?: number;
  ids?: number[];
  archived?: number;
  total?: number;
  errors?: Array<{ id: number; err: string }>;
}> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.status, "failed"),
        ne(tasks.lifecycleStatus, "cancelled"),
        // 看板已放弃（cancelled）的任务属于用户主动废弃，不归档
        ne(tasks.boardStatus, "cancelled")
      )
    )
    .limit(opts.limit);
  const filtered = opts.ids && opts.ids.length > 0 ? rows.filter((r) => opts.ids!.includes(r.id)) : rows;
  if (opts.dryRun) {
    return { dryRun: true, candidateCount: filtered.length, ids: filtered.map((r) => r.id) };
  }
  let archived = 0;
  const errors: Array<{ id: number; err: string }> = [];
  for (const row of filtered) {
    try {
      await finalizeFailedTask(db, row);
      archived++;
    } catch (e) {
      errors.push({ id: row.id, err: e instanceof Error ? e.message : String(e) });
    }
  }
  return { dryRun: false, archived, total: filtered.length, errors };
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

  /** Open WebUI 嵌入地址（公开读，首页消息面板 iframe 用；空 = 未配置） */
  getOpenWebUi: publicQuery.query(async () => ({
    url:
      ((await getSetting(OPEN_WEBUI_URL_KEY).catch(() => null)) || "").trim() ||
      DEFAULT_OPEN_WEBUI_URL,
  })),

  /** 设置 Open WebUI 嵌入地址（admin；传空字符串清除） */
  setOpenWebUiUrl: adminQuery
    .input(z.object({ url: z.string().max(500) }))
    .mutation(async ({ input }) => {
      const url = input.url.trim();
      if (url && !/^https?:\/\//.test(url)) {
        throw new Error("URL 必须以 http(s):// 开头");
      }
      await setSetting(OPEN_WEBUI_URL_KEY, url, "assistant");
      return { success: true, url };
    }),

  /** 批量归档失败任务（UI 用，admin 登录） */
  archiveFailedTasks: adminQuery
    .input(z.object({
      dryRun: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(500).optional().default(100),
      ids: z.array(z.number().int()).optional(),
    }))
    .mutation(async ({ input }) => runArchiveFailedTasks(input)),
});
