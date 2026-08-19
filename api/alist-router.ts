/**
 * AList 网盘管理路由：状态、文件浏览、手动上传任务产物
 */
import { z } from "zod";
import { createRouter, userQuery, adminQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks } from "@db/schema";
import { eq } from "drizzle-orm";
import {
  getAlistConfig,
  alistConfigured,
  alistBaseUrlHost,
  alistList,
  alistDownloadUrl,
  alistTestConnection,
} from "./connectors/alist";
import { syncTaskArtifactsToAlist, ALIST_SYNC_ARTIFACT_TYPE } from "./lib/alist-sync";
import { taskArtifacts } from "@db/schema";
import { and } from "drizzle-orm";

export const alistRouter = createRouter({
  /** 配置与连接状态 */
  status: userQuery.query(async () => {
    const cfg = getAlistConfig();
    if (!cfg) {
      return { configured: false as const, connected: false, baseUrlHost: "", basePath: "", autoUpload: false, message: "未配置 ALIST_BASE_URL / ALIST_USERNAME / ALIST_PASSWORD" };
    }
    const test = await alistTestConnection(cfg);
    return {
      configured: true as const,
      connected: test.success,
      baseUrlHost: alistBaseUrlHost(),
      basePath: cfg.basePath,
      autoUpload: cfg.autoUpload,
      message: test.message,
    };
  }),

  /** 浏览 AList 目录 */
  browse: userQuery
    .input(z.object({ path: z.string().max(1000).default("/") }))
    .query(async ({ input }) => {
      const cfg = getAlistConfig();
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
      const cfg = getAlistConfig();
      if (!cfg) return { ok: false as const, error: "AList 未配置", url: null as string | null };
      const url = await alistDownloadUrl(cfg, input.path);
      return { ok: true as const, url };
    }),

  /** 手动上传指定任务的产物到 AList（忽略自动开关与幂等标记，强制重新上传） */
  uploadTask: adminQuery
    .input(z.object({ taskId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const cfg = getAlistConfig();
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
        error: result.synced ? undefined : result.reason,
        uploaded: result.uploaded ?? [],
      };
    }),
});
