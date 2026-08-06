// 天宫 → 璇玑 任务记忆同步 (Xuanji Task Memory Sync)
//
// 任务完成（status=done / lifecycleStatus=completed，且已通过执行审批闸门）后，
// 把任务结果尽力而为地写入璇玑知识库（writeTaskMemory + 可选 linkArtifact），
// 使任务产出沉淀为长期记忆。
//
// 非致命保证：
//   - 璇玑不可用 / 超时 / 校验失败 / 本地 DB 异常 一律在本模块内 catch + log，
//     绝不向完成路径抛出；同步钩子位于完成路径的 DB 更新之后，失败不影响任务完成结果。
//   - 未配置 XUANJI_BASE_URL 时 createXuanjiClient() 返回 null → 静默 no-op，
//     且不触发任何 DB 查询（去重检查在 client 就绪之后才进行）。
//
// 本地去重（best-effort）：
//   - 写入前查询 task_artifacts 中 type='xuanji_memory' 的记录，已存在则跳过写入；
//   - 写入成功后插入该记录并携带 documentId / nodeIds / edgeIds 引用。
//   - 残余风险：检查与插入之间存在 crash window，进程在两者之间崩溃会重复写入。
//     本机制只能收窄、不能完全消除重复；真正幂等需要璇玑侧按 traceId/taskId 去重。

import { and, eq } from "drizzle-orm";
import { taskArtifacts } from "@db/schema";
import type { XuanjiConnectorClient } from "../connectors/xuanji/client";
import { createXuanjiClient } from "../connectors/xuanji/service";
import type { WriteTaskMemoryRequest, WriteTaskMemoryResponse } from "../connectors/xuanji/types";
import { getDb } from "../queries/connection";
import { createTraceId, parseTaskMetadata } from "./task-metadata";
import type { TaskMetadata } from "../contracts/platform";

export type Db = ReturnType<typeof getDb>;

/** 本地去重 artifact 的固定类型 */
export const XUANJI_MEMORY_ARTIFACT_TYPE = "xuanji_memory";
/** 璇玑侧记忆项目命名空间（可用 XUANJI_MEMORY_PROJECT 环境变量覆盖） */
export const XUANJI_MEMORY_PROJECT = process.env.XUANJI_MEMORY_PROJECT ?? "tiangong";

const MAX_NAME = 255;
const MAX_SUMMARY = 5_000;
const MAX_CONTENT = 20_000;
const MAX_TAGS = 8;
const MAX_ARTIFACTS = 20;

/** 完成路径提供给同步钩子的任务视图（与 tasks 表行兼容，status 可覆盖为完成态） */
export type CompletedTaskView = Readonly<{
  id: number;
  taskId: string;
  name: string;
  description: string | null;
  input: string | null;
  output: string | null;
  agentId: number | null;
  status: string;
  lifecycleStatus?: string | null;
}>;

export type XuanjiMemorySyncResult = Readonly<{
  synced: boolean;
  reason: "not_configured" | "duplicate" | "duplicate_check_failed" | "write_failed" | "written" | "unexpected_failure";
  documentId?: number;
  nodeIds?: readonly number[];
  artifactId?: number;
  linkedArtifact?: boolean;
}>;

/** 尽力而为地把已完成任务写入璇玑记忆。永不抛错：一切失败都被捕获并返回结果。 */
export async function syncTaskMemoryToXuanji(
  db: Db,
  task: CompletedTaskView
): Promise<XuanjiMemorySyncResult> {
  try {
    return await syncTaskMemory(db, task);
  } catch (error) {
    console.warn(`[xuanji-sync] unexpected failure for task ${task.taskId}: ${describeError(error)}`);
    return { synced: false, reason: "unexpected_failure" };
  }
}

async function syncTaskMemory(db: Db, task: CompletedTaskView): Promise<XuanjiMemorySyncResult> {
  let client: XuanjiConnectorClient | null;
  try {
    client = createXuanjiClient();
  } catch (error) {
    console.warn(`[xuanji-sync] client construction failed for task ${task.taskId}: ${describeError(error)}`);
    return { synced: false, reason: "not_configured" };
  }
  if (!client) {
    return { synced: false, reason: "not_configured" };
  }

  const metadata = parseTaskMetadata(task.input);
  const trace = buildTrace(task, metadata);

  let existing: ReadonlyArray<{ id: number }>;
  try {
    existing = await db
      .select({ id: taskArtifacts.id })
      .from(taskArtifacts)
      .where(and(eq(taskArtifacts.taskId, task.id), eq(taskArtifacts.type, XUANJI_MEMORY_ARTIFACT_TYPE)))
      .limit(1);
  } catch (error) {
    console.warn(`[xuanji-sync] dedup check failed for task ${task.taskId}: ${describeError(error)}`);
    return { synced: false, reason: "duplicate_check_failed" };
  }
  if (existing.length > 0) {
    return { synced: false, reason: "duplicate" };
  }

  let response: WriteTaskMemoryResponse;
  try {
    response = await client.writeTaskMemory(buildRequest(task, metadata, trace));
  } catch (error) {
    console.warn(`[xuanji-sync] writeTaskMemory failed for task ${task.taskId}: ${describeError(error)}`);
    return { synced: false, reason: "write_failed" };
  }

  let artifactId: number | undefined;
  try {
    artifactId = extractInsertId(
      await db.insert(taskArtifacts).values({
        taskId: task.id,
        agentId: task.agentId,
        type: XUANJI_MEMORY_ARTIFACT_TYPE,
        name: `xuanji-memory-${task.taskId}`.slice(0, MAX_NAME),
        jsonPayload: JSON.stringify({
          documentId: response.documentId,
          nodeIds: response.nodeIds,
          edgeIds: response.edgeIds,
        }),
        mimeType: "application/json",
      })
    );
  } catch (error) {
    console.warn(`[xuanji-sync] dedup artifact insert failed for task ${task.taskId}: ${describeError(error)}`);
  }

  let linkedArtifact = false;
  try {
    linkedArtifact = await tryLinkArtifact(client, task, metadata, trace, response.documentId);
  } catch (error) {
    console.warn(`[xuanji-sync] linkArtifact failed for task ${task.taskId}: ${describeError(error)}`);
  }

  return {
    synced: true,
    reason: "written",
    documentId: response.documentId,
    nodeIds: response.nodeIds,
    artifactId,
    linkedArtifact,
  };
}

function buildRequest(
  task: CompletedTaskView,
  metadata: TaskMetadata | null,
  trace: WriteTaskMemoryRequest["trace"]
): WriteTaskMemoryRequest {
  return {
    task: {
      taskId: task.taskId.slice(0, 64),
      traceId: trace.traceId,
      name: (task.name.trim().length > 0 ? task.name : task.taskId).slice(0, MAX_NAME),
      type: metadata?.taskType ?? "triage_task",
      status: task.status.slice(0, 100),
      agentId: trace.agentId,
    },
    memory: {
      project: XUANJI_MEMORY_PROJECT,
      title: `完成记录：${task.name}`.slice(0, MAX_NAME),
      summary: buildSummary(task),
      contentMarkdown: buildContentMarkdown(task, metadata, trace),
      tags: buildTags(metadata),
      decisions: buildDecisions(metadata),
      artifacts: buildArtifacts(metadata),
    },
    trace,
  };
}

function buildTrace(
  task: CompletedTaskView,
  metadata: TaskMetadata | null
): WriteTaskMemoryRequest["trace"] {
  return {
    traceId: metadata?.traceId ?? createTraceId(),
    taskId: task.taskId.slice(0, 64),
    agentId: (task.agentId !== null ? String(task.agentId) : "system").slice(0, 100),
    originSystem: "tiangong",
  };
}

function buildSummary(task: CompletedTaskView): string {
  const parts: string[] = [];
  const description = task.description?.trim();
  if (description) parts.push(description);
  const output = task.output?.trim();
  if (output) parts.push(`完成输出：${output}`);
  if (parts.length === 0) parts.push(`任务 ${task.taskId} 已完成。`);
  return truncate(parts.join("\n"), MAX_SUMMARY);
}

function buildContentMarkdown(
  task: CompletedTaskView,
  metadata: TaskMetadata | null,
  trace: WriteTaskMemoryRequest["trace"]
): string {
  const lines = [
    `# ${task.name}`,
    "",
    `- taskId: ${task.taskId}`,
    `- status: ${task.status}`,
    `- lifecycleStatus: ${task.lifecycleStatus ?? "completed"}`,
    `- traceId: ${trace.traceId}`,
    `- agentId: ${trace.agentId}`,
  ];
  const description = task.description?.trim();
  if (description) lines.push("", "## 任务描述", description);
  const output = task.output?.trim();
  if (output) lines.push("", "## 任务输出", output);
  const approval = metadata?.approval;
  if (approval) {
    lines.push("", "## 审批", `- decision: ${approval.decision}`, `- riskType: ${approval.riskType}`, `- target: ${approval.target}`);
  }
  return truncate(lines.join("\n"), MAX_CONTENT);
}

function buildTags(metadata: TaskMetadata | null): string[] {
  const tags = ["tiangong", "task-completed"];
  for (const risk of metadata?.routing.riskTypes ?? []) {
    if (tags.length >= MAX_TAGS) break;
    tags.push(risk);
  }
  return tags;
}

function buildDecisions(metadata: TaskMetadata | null): WriteTaskMemoryRequest["memory"]["decisions"] {
  const approval = metadata?.approval;
  if (!approval) return [];
  return [
    {
      title: `审批决定：${approval.decision}`,
      reason: truncate(`风险类型 ${approval.riskType}；目标 ${approval.target}`, 2000),
    },
  ];
}

function buildArtifacts(metadata: TaskMetadata | null): WriteTaskMemoryRequest["memory"]["artifacts"] {
  return (metadata?.artifactRefs ?? [])
    .slice(0, MAX_ARTIFACTS)
    .map((ref) => ({
      type: ref.artifactType.slice(0, 100),
      name: ref.ref.slice(0, MAX_NAME),
      artifactRef: ref.ref.slice(0, 500),
    }));
}

/** 可选：把任务元数据中的首个非 inline artifact 链接到记忆文档。失败由调用方捕获。 */
async function tryLinkArtifact(
  client: XuanjiConnectorClient,
  task: CompletedTaskView,
  metadata: TaskMetadata | null,
  trace: WriteTaskMemoryRequest["trace"],
  documentId: number
): Promise<boolean> {
  const ref = (metadata?.artifactRefs ?? []).find((candidate) => candidate.storage !== "inline");
  if (!ref) return false;
  await client.linkArtifact({
    documentId,
    artifact: {
      artifactRef: ref.ref.slice(0, 500),
      ...(ref.mimeType ? { mimeType: ref.mimeType } : {}),
    },
    trace,
  });
  return true;
}

function extractInsertId(result: unknown): number | undefined {
  const value = Array.isArray(result) ? result[0] : result;
  if (value === null || typeof value !== "object") return undefined;
  const insertId = (value as { insertId?: number | bigint | null }).insertId;
  return insertId === undefined || insertId === null ? undefined : Number(insertId);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
