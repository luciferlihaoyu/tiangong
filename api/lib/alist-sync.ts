// 天宫 → AList 任务产物同步
//
// 任务完成（status=done 且通过执行审批闸门）后，尽力而为地把任务产出上传到 AList：
//   {basePath}/tasks/{taskId}/output.md      —— 任务输出文本
//   {basePath}/tasks/{taskId}/artifacts/...  —— task_artifacts 中的文本/JSON 产物
// basePath 默认为 "/"，即账号在 AList 中的根目录（若账号配置了「基本路径」则自动映射）。
//
// 非致命保证：与 xuanji-sync 相同 —— AList 不可用 / 超时 / 本地异常一律 catch + log，
// 绝不向完成路径抛出。未配置 ALIST_BASE_URL 时静默 no-op。
// 幂等：上传前检查 task_artifacts 中是否已有 type='alist_sync' 记录，有则跳过。

import { and, eq } from "drizzle-orm";
import { taskArtifacts } from "@db/schema";
import { resolveAlistConfig, alistUpload } from "../connectors/alist";
import { getDb } from "../queries/connection";

export type Db = ReturnType<typeof getDb>;

export const ALIST_SYNC_ARTIFACT_TYPE = "alist_sync";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 单文件 50MB 上限

export type CompletedTaskForAlist = Readonly<{
  id: number;
  taskId: string;
  name: string;
  output: string | null;
  agentId: number | null;
}>;

export type AlistSyncResult = Readonly<{
  synced: boolean;
  reason: "not_configured" | "disabled" | "duplicate" | "nothing_to_upload" | "uploaded" | "upload_failed" | "unexpected_failure";
  uploaded?: readonly string[];
  /** 失败时的具体错误信息（便于无日志环境下诊断） */
  error?: string;
}>;

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").replace(/^\.+/, "").trim();
  return cleaned.slice(0, 100) || "artifact";
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function syncTaskArtifactsToAlist(db: Db, task: CompletedTaskForAlist): Promise<AlistSyncResult> {
  try {
    const cfg = await resolveAlistConfig();
    if (!cfg) return { synced: false, reason: "not_configured" };
    if (!cfg.autoUpload) return { synced: false, reason: "disabled" };

    // 幂等：已同步过则跳过
    const existing = await db
      .select({ id: taskArtifacts.id })
      .from(taskArtifacts)
      .where(and(eq(taskArtifacts.taskId, task.id), eq(taskArtifacts.type, ALIST_SYNC_ARTIFACT_TYPE)))
      .then((rows) => rows[0]);
    if (existing) return { synced: false, reason: "duplicate" };

    const prefix = cfg.basePath === "/" ? "" : cfg.basePath;
    const base = `${prefix}/tasks/${task.taskId}`;
    const uploaded: string[] = [];

    // 1) 任务输出 → output.md
    if (task.output && task.output.trim()) {
      const md = `# ${task.name}\n\n- taskId: ${task.taskId}\n- 完成时间: ${new Date().toISOString()}\n\n## 任务输出\n\n${task.output}\n`;
      const target = await alistUpload(cfg, `${base}/output.md`, Buffer.from(md, "utf-8"));
      uploaded.push(target);
    }

    // 2) task_artifacts 中的文本/JSON 产物
    const rows = await db
      .select()
      .from(taskArtifacts)
      .where(eq(taskArtifacts.taskId, task.id));

    for (const row of rows) {
      if (row.type === ALIST_SYNC_ARTIFACT_TYPE || row.type === "xuanji_memory") continue;
      const body = row.content ?? row.jsonPayload;
      if (!body || !body.trim()) continue;
      const buf = Buffer.from(body, "utf-8");
      if (buf.length > MAX_UPLOAD_BYTES) continue;
      const ext = row.jsonPayload && !row.content ? ".json" : (row.mimeType?.includes("markdown") ? ".md" : ".txt");
      const fname = sanitizeFileName(row.name || `${row.type}-${row.id}`) + ext;
      try {
        const target = await alistUpload(cfg, `${base}/artifacts/${fname}`, buf);
        uploaded.push(target);
      } catch (e) {
        console.warn(`[alist-sync] artifact ${row.id} upload failed: ${describeError(e)}`);
      }
    }

    if (uploaded.length === 0) return { synced: false, reason: "nothing_to_upload" };

    // 记录同步标记（幂等 + 可审计）
    await db.insert(taskArtifacts).values({
      taskId: task.id,
      agentId: task.agentId ?? null,
      type: ALIST_SYNC_ARTIFACT_TYPE,
      name: `AList: ${base}`,
      jsonPayload: JSON.stringify({ uploaded, at: new Date().toISOString() }),
    });

    return { synced: true, reason: "uploaded", uploaded };
  } catch (e) {
    console.warn(`[alist-sync] unexpected failure for task ${task.taskId}: ${describeError(e)}`);
    return { synced: false, reason: "unexpected_failure", error: describeError(e) };
  }
}
