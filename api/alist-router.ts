/**
 * AList 网盘管理路由：状态、文件浏览、手动上传任务产物
 */
import { z } from "zod";
import { createRouter, userQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks } from "@db/schema";
import { eq } from "drizzle-orm";
import {
  resolveAlistConfig,
  getAlistDbConfig,
  saveAlistDbConfig,
  clearAlistDbConfig,
  alistConfigSource,
  alistBaseUrlHostOf,
  alistList,
  alistDownloadUrl,
  alistTestConnection,
} from "./connectors/alist";
import { syncTaskArtifactsToAlist, ALIST_SYNC_ARTIFACT_TYPE } from "./lib/alist-sync";
import { taskArtifacts } from "@db/schema";
import { and } from "drizzle-orm";

export const alistRouter = createRouter({
  /** 配置与连接状态（含真实读写探测；密码永不返回） */
  status: userQuery.query(async () => {
    const [cfg, source] = await Promise.all([resolveAlistConfig(), alistConfigSource()]);
    if (!cfg) {
      return { configured: false as const, connected: false, source: null as "ui" | "env" | null, baseUrl: "", baseUrlHost: "", username: "", basePath: "/", autoUpload: true, message: "未配置：在下方「连接配置」填写，或设置环境变量 ALIST_BASE_URL / ALIST_USERNAME / ALIST_PASSWORD" };
    }
    const test = await alistTestConnection(cfg);
    return {
      configured: true as const,
      connected: test.success,
      source,
      baseUrl: cfg.baseUrl, // 非敏感，用于前端表单回填
      baseUrlHost: alistBaseUrlHostOf(cfg),
      username: cfg.username,
      basePath: cfg.basePath,
      autoUpload: cfg.autoUpload,
      message: test.message,
    };
  }),

  /** 保存连接配置（管理员）。password 留空 = 保留原密码 */
  saveConfig: adminQuery
    .input(z.object({
      baseUrl: z.string().min(1).max(500),
      username: z.string().min(1).max(100),
      password: z.string().max(200).optional(),
      basePath: z.string().max(300).optional(),
      autoUpload: z.boolean().optional(),
    }))
    .mutation(async ({ input }) => {
      const prev = await getAlistDbConfig();
      const password = input.password?.trim() ? input.password : (prev?.password ?? "");
      if (!password) return { success: false as const, error: "首次保存必须填写密码" };
      if (!/^https?:\/\//i.test(input.baseUrl.trim())) return { success: false as const, error: "地址必须以 http:// 或 https:// 开头" };
      await saveAlistDbConfig({
        baseUrl: input.baseUrl,
        username: input.username,
        password,
        basePath: input.basePath,
        autoUpload: input.autoUpload,
      });
      // 立即用新配置做读写探测
      const cfg = await resolveAlistConfig();
      const test = cfg ? await alistTestConnection(cfg) : { success: false, message: "配置无效" };
      return { success: true as const, connected: test.success, message: test.message };
    }),

  /** 清除界面配置，回退到环境变量 */
  clearConfig: adminQuery.mutation(async () => {
    await clearAlistDbConfig();
    return { success: true as const };
  }),

  /** 浏览 AList 目录 */
  browse: userQuery
    .input(z.object({ path: z.string().max(1000).default("/") }))
    .query(async ({ input }) => {
      const cfg = await resolveAlistConfig();
      if (!cfg) return { ok: false as const, error: "AList 未配置", files: [] as Array<{ name: string; path: string; isDir: boolean; size: number; modified?: string }> };
      try {
        const files = await alistList(cfg, input.path);
        return { ok: true as const, files };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message : "读取失败", files: [] as Array<{ name: string; path: string; isDir: boolean; size: number; modified?: string }> };
      }
    }),

  /** 获取文件下载地址 */
  getDownloadUrl: userQuery
    .input(z.object({ path: z.string().min(1).max(1000) }))
    .query(async ({ input }) => {
      const cfg = await resolveAlistConfig();
      if (!cfg) return { ok: false as const, error: "AList 未配置", url: null as string | null };
      const url = await alistDownloadUrl(cfg, input.path);
      return { ok: true as const, url };
    }),

  /** 手动上传指定任务的产物到 AList（忽略自动开关与幂等标记，强制重新上传） */
  uploadTask: adminQuery
    .input(z.object({ taskId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const cfg = await resolveAlistConfig();
      if (!cfg) return { success: false as const, error: "AList 未配置" };
      const db = getDb();
      const task = await db.select().from(tasks).where(eq(tasks.id, input.taskId)).then((rows) => rows[0]);
      if (!task) return { success: false as const, error: "任务不存在" };

      // 清除幂等标记以允许重新上传
      await db.delete(taskArtifacts).where(and(eq(taskArtifacts.taskId, task.id), eq(taskArtifacts.type, ALIST_SYNC_ARTIFACT_TYPE)));

      const result = await syncTaskArtifactsToAlist(db, {
        id: task.id,
        taskId: task.taskId,
        name: task.name,
        output: task.output,
        agentId: task.agentId,
      });
      return {
        success: result.synced,
        error: result.synced ? undefined : (result.error ? `${result.reason}: ${result.error}` : result.reason),
        uploaded: result.uploaded ?? [],
      };
    }),
});
