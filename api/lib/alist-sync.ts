// 天宫 → AList 任务产物同步
//
// 任务完成（status=done 且通过执行审批闸门）后，尽力而为地把任务产出上传到 AList：
//   {basePath}/tasks/{taskId}/output.md      —— 任务输出文本（完整档案，所有任务）
//   {basePath}/tasks/{taskId}/artifacts/...  —— task_artifacts 中的文本/JSON 产物
//   {basePath}/highlights/{日期}-{taskId}-{任务名}.md —— 重要成果精华（任务 2.3）
// basePath 默认为 "/"，即账号在 AList 中的根目录（若账号配置了「基本路径」则自动映射）。
//
// 重要成果分级（任务 2.3）：完整档案之外，importance=important 的任务把 output.md
// 额外复制一份到 highlights/ 精华目录，便于人直接翻阅。判定两级：
//   1) 显式标记：任务 input envelope 的 metadata.importance === "important"（优先）
//   2) 关键词推断兜底：元数据缺失/normal 时，任务名或描述命中重要成果关键词
//
// 非致命保证：与 xuanji-sync 相同 —— AList 不可用 / 超时 / 本地异常一律 catch + log，
// 绝不向完成路径抛出。未配置 ALIST_BASE_URL 时静默 no-op。
// 幂等：上传前检查 task_artifacts 中是否已有 type='alist_sync' 记录，有则跳过。

import { and, eq } from "drizzle-orm";
import { taskArtifacts } from "@db/schema";
import { resolveAlistConfig, alistUpload } from "../connectors/alist";
import { getDb } from "../queries/connection";
import { parseTaskMetadata } from "./task-metadata";

export type Db = ReturnType<typeof getDb>;

export const ALIST_SYNC_ARTIFACT_TYPE = "alist_sync";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 单文件 50MB 上限

/**
 * 重要成果关键词（任务 2.3）：任务名或描述命中其一即推断为 important。
 * 集中在此一处，调整分级口径时只改这个数组。
 */
const IMPORTANCE_KEYWORDS = ["报告", "汇报", "总结", "周报", "日报", "重要", "精华", "复盘"] as const;

export type CompletedTaskForAlist = Readonly<{
  id: number;
  taskId: string;
  name: string;
  output: string | null;
  agentId: number | null;
  /** 任务 input 原文（含 metadata envelope）：解析显式 importance 标记；可选，旧调用方不受影响 */
  input?: string | null;
  /** 任务描述：元数据缺失时的关键词推断兜底来源 */
  description?: string | null;
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

/**
 * 解析任务重要度：显式标记优先，关键词推断兜底。
 *   1) input envelope 的 metadata.importance === "important" → important
 *   2) 元数据缺失 / 标记为 normal 时，任务名或描述命中 IMPORTANCE_KEYWORDS → important
 */
function resolveImportance(task: CompletedTaskForAlist): "normal" | "important" {
  if (parseTaskMetadata(task.input)?.importance === "important") return "important";
  const haystack = `${task.name ?? ""} ${task.description ?? ""}`;
  return IMPORTANCE_KEYWORDS.some((keyword) => haystack.includes(keyword)) ? "important" : "normal";
}

/** 本地日期 YYYY-MM-DD：highlights 文件名前缀，便于按天翻阅 */
function localDateStamp(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
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

      // 2) 重要成果 → highlights/ 精华目录（同一份输出，额外复制便于直接翻阅）
      if (resolveImportance(task) === "important") {
        const fname = `${localDateStamp(new Date())}-${task.taskId}-${sanitizeFileName(task.name)}.md`;
        try {
          const highlight = await alistUpload(cfg, `${prefix}/highlights/${fname}`, Buffer.from(md, "utf-8"));
          uploaded.push(highlight);
        } catch (e) {
          // 精华上传失败不影响主归档（与 artifact 逐文件容错同一风格）
          console.warn(`[alist-sync] highlights upload failed for task ${task.taskId}: ${describeError(e)}`);
        }
      }
    }

    // 3) task_artifacts 中的文本/JSON 产物
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
