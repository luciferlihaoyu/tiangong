// 天宫 → 璇玑 任务记忆同步 (Xuanji Task Memory Sync)
//
// 任务完成（status=done / lifecycleStatus=completed，且已通过执行审批闸门）后，
// 把任务结果尽力而为地写入璇玑知识库（writeTaskMemory + 可选 linkArtifact），
// 使任务产出沉淀为长期记忆。
//
// 失败教训（kind=lesson，任务 3.1 质量反哺）：终态失败 / 人工驳回的任务经
// syncTaskLessonToXuanji 写入失败教训记忆——失败原因、驳回意见进知识库，
// 后续同类任务的 search_xuanji 才能检索到教训、避免重复踩坑。教训与成功记录
// 使用互相独立的幂等标记（type='xuanji_lesson' vs 'xuanji_memory'），同一任务
// 失败后重试成功可先后留下教训与完成记录两条；kind 语义由 title（"失败教训："）
// 与 tags（lesson/failed）承载，璇玑侧不区分 writeTaskMemory 的调用来源。
// 检索方式：search_xuanji 以 filters.tags=["lesson"] 过滤，或以"失败教训"+任务名
// 关键词命中（title 含"失败教训"前缀与任务名）。
//
// 非致命保证：
//   - 璇玑不可用 / 超时 / 校验失败 / 本地 DB 异常 一律在本模块内 catch + log，
//     绝不向完成路径抛出；同步钩子位于完成路径的 DB 更新之后，失败不影响任务完成结果。
//   - 未配置 XUANJI_BASE_URL 时 createXuanjiClient() 返回 null → 静默 no-op，
//     且不触发任何 DB 查询（去重检查在 client 就绪之后才进行）。
//
// 本地去重（best-effort）：
//   - 写入前查询 task_artifacts 中对应类型的记录（成功记忆 'xuanji_memory'、
//     失败教训 'xuanji_lesson'，各自独立检查），已存在则跳过写入；
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

/** 成功记忆（完成记录）本地去重 artifact 的固定类型 */
export const XUANJI_MEMORY_ARTIFACT_TYPE = "xuanji_memory";
/** 失败教训本地去重 artifact 的固定类型（与成功记忆互相独立，见头注释） */
export const XUANJI_LESSON_ARTIFACT_TYPE = "xuanji_lesson";
/** 璇玑侧记忆项目命名空间（可用 XUANJI_MEMORY_PROJECT 环境变量覆盖） */
export const XUANJI_MEMORY_PROJECT = process.env.XUANJI_MEMORY_PROJECT ?? "tiangong";

const MAX_NAME = 255;
const MAX_SUMMARY = 5_000;
const MAX_CONTENT = 20_000;
const MAX_TAGS = 8;
const MAX_ARTIFACTS = 20;
/** 教训记录中 input 提示词摘要的截断长度 */
const MAX_PROMPT_EXCERPT = 2_000;

/**
 * 同步钩子的任务视图（与 tasks 表行兼容，status 由调用方按终态覆盖）。
 * error 为失败教训专用可选字段：调用方从 tasks 行 error 列或失败/驳回上下文取；
 * 成功完成路径不传，行为不变。
 */
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
  /** 终态失败原因（失败教训记录用；成功记录忽略该字段） */
  error?: string | null;
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

/**
 * 尽力而为地把终态失败任务写入璇玑失败教训记忆（kind=lesson 语义由
 * title/tags 承载，与成功记录走同一个 writeTaskMemory 调用）。
 * 幂等标记独立使用 type='xuanji_lesson'，与成功记录互不影响。
 * 永不抛错：一切失败都被捕获并返回结果（非致命保证与 syncTaskMemoryToXuanji 一致）。
 */
export async function syncTaskLessonToXuanji(
  db: Db,
  task: CompletedTaskView
): Promise<XuanjiMemorySyncResult> {
  try {
    return await syncTaskLesson(db, task);
  } catch (error) {
    console.warn(`[xuanji-sync] unexpected lesson failure for task ${task.taskId}: ${describeError(error)}`);
    return { synced: false, reason: "unexpected_failure" };
  }
}

async function syncTaskMemory(db: Db, task: CompletedTaskView): Promise<XuanjiMemorySyncResult> {
  const client = readyClient(`task ${task.taskId}`);
  if (!client) {
    return { synced: false, reason: "not_configured" };
  }

  const metadata = parseTaskMetadata(task.input);
  const trace = buildTrace(task, metadata);

  const dedup = await checkDedupMarker(db, task, XUANJI_MEMORY_ARTIFACT_TYPE);
  if (dedup !== "clear") {
    return { synced: false, reason: dedup };
  }

  let response: WriteTaskMemoryResponse;
  try {
    response = await client.writeTaskMemory(buildRequest(task, metadata, trace));
  } catch (error) {
    console.warn(`[xuanji-sync] writeTaskMemory failed for task ${task.taskId}: ${describeError(error)}`);
    return { synced: false, reason: "write_failed" };
  }

  const artifactId = await insertDedupMarker(db, task, XUANJI_MEMORY_ARTIFACT_TYPE, "xuanji-memory", response);

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

async function syncTaskLesson(db: Db, task: CompletedTaskView): Promise<XuanjiMemorySyncResult> {
  const client = readyClient(`lesson ${task.taskId}`);
  if (!client) {
    return { synced: false, reason: "not_configured" };
  }

  const metadata = parseTaskMetadata(task.input);
  const trace = buildTrace(task, metadata);

  const dedup = await checkDedupMarker(db, task, XUANJI_LESSON_ARTIFACT_TYPE);
  if (dedup !== "clear") {
    return { synced: false, reason: dedup };
  }

  let response: WriteTaskMemoryResponse;
  try {
    response = await client.writeTaskMemory(buildLessonRequest(task, metadata, trace));
  } catch (error) {
    console.warn(`[xuanji-sync] lesson writeTaskMemory failed for task ${task.taskId}: ${describeError(error)}`);
    return { synced: false, reason: "write_failed" };
  }

  const artifactId = await insertDedupMarker(db, task, XUANJI_LESSON_ARTIFACT_TYPE, "xuanji-lesson", response);

  // 教训记录不携带 artifacts（失败产物无归档价值），因此不做 linkArtifact。

  return {
    synced: true,
    reason: "written",
    documentId: response.documentId,
    nodeIds: response.nodeIds,
    artifactId,
  };
}

/** 构造璇玑 client；未配置或构造失败返回 null（调用方按 not_configured 处理）。 */
function readyClient(taskKey: string): XuanjiConnectorClient | null {
  try {
    return createXuanjiClient();
  } catch (error) {
    console.warn(`[xuanji-sync] client construction failed for ${taskKey}: ${describeError(error)}`);
    return null;
  }
}

/** 幂等检查：本地已存在指定类型标记返回 "duplicate"，检查失败返回 "duplicate_check_failed"，可写返回 "clear"。 */
async function checkDedupMarker(
  db: Db,
  task: CompletedTaskView,
  type: string
): Promise<"clear" | "duplicate" | "duplicate_check_failed"> {
  let existing: ReadonlyArray<{ id: number }>;
  try {
    existing = await db
      .select({ id: taskArtifacts.id })
      .from(taskArtifacts)
      .where(and(eq(taskArtifacts.taskId, task.id), eq(taskArtifacts.type, type)))
      .limit(1);
  } catch (error) {
    console.warn(`[xuanji-sync] dedup check failed for task ${task.taskId}: ${describeError(error)}`);
    return "duplicate_check_failed";
  }
  return existing.length > 0 ? "duplicate" : "clear";
}

/** 写入幂等标记（best-effort，失败仅告警不回滚璇玑写入）。返回插入的 artifact id。 */
async function insertDedupMarker(
  db: Db,
  task: CompletedTaskView,
  type: string,
  namePrefix: string,
  response: WriteTaskMemoryResponse
): Promise<number | undefined> {
  try {
    return extractInsertId(
      await db.insert(taskArtifacts).values({
        taskId: task.id,
        agentId: task.agentId,
        type,
        name: `${namePrefix}-${task.taskId}`.slice(0, MAX_NAME),
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
    return undefined;
  }
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

/** 失败教训专用请求构造：不走"完成记录"模板，title/tags/正文均按 lesson 语义组织。 */
function buildLessonRequest(
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
      // 终态失败照实传（调用方传 status="failed"，不伪装成完成态）
      status: task.status.slice(0, 100),
      agentId: trace.agentId,
    },
    memory: {
      project: XUANJI_MEMORY_PROJECT,
      title: `失败教训：${task.name}`.slice(0, MAX_NAME),
      summary: buildLessonSummary(task),
      contentMarkdown: buildLessonContentMarkdown(task, trace),
      tags: buildLessonTags(metadata),
      decisions: [],
      artifacts: [],
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

/** 教训摘要：失败原因优先（检索命中教训的首要线索），其次补任务描述。 */
function buildLessonSummary(task: CompletedTaskView): string {
  const parts: string[] = [];
  const error = task.error?.trim();
  if (error) parts.push(`失败原因：${error}`);
  const description = task.description?.trim();
  if (description) parts.push(description);
  if (parts.length === 0) parts.push(`任务 ${task.taskId} 终态失败，未记录失败原因。`);
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

/** 教训正文：任务上下文 + 完整失败原因 + input 提示词摘要 + 教训反思引导语。 */
function buildLessonContentMarkdown(
  task: CompletedTaskView,
  trace: WriteTaskMemoryRequest["trace"]
): string {
  const lines = [
    `# 失败教训：${task.name}`,
    "",
    `- taskId: ${task.taskId}`,
    `- status: ${task.status}`,
    `- lifecycleStatus: ${task.lifecycleStatus ?? "failed"}`,
    `- traceId: ${trace.traceId}`,
    `- agentId: ${trace.agentId}`,
  ];
  const description = task.description?.trim();
  if (description) lines.push("", "## 任务描述", description);
  // 完整失败原因（仅受整篇 MAX_CONTENT 上限约束）
  lines.push("", "## 失败原因", task.error?.trim() || "（未记录失败原因）");
  const prompt = buildPromptExcerpt(task);
  if (prompt) lines.push("", "## 输入提示词摘要", prompt);
  lines.push(
    "",
    "## 教训反思",
    "本记录由天宫在任务终态失败/人工驳回后自动归档（tags 含 lesson/failed）。",
    "执行同类任务前请先检索本教训：核对上述失败原因与输入提示词，判断是否存在同类风险",
    "（环境缺失、参数错误、外部依赖不可用等），优先规避再开工。"
  );
  return truncate(lines.join("\n"), MAX_CONTENT);
}

/** 从任务 input 提取提示词摘要：{ payload, metadata } envelope 取 payload，否则按原文；统一截断。 */
function buildPromptExcerpt(task: CompletedTaskView): string | null {
  const raw = task.input?.trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const payload = (parsed as Record<string, unknown>).payload;
      if (typeof payload === "string" && payload.trim().length > 0) {
        return truncate(payload.trim(), MAX_PROMPT_EXCERPT);
      }
    }
  } catch {
    // 非 JSON 的 input 原文即提示词
  }
  return truncate(raw, MAX_PROMPT_EXCERPT);
}

function buildTags(metadata: TaskMetadata | null): string[] {
  const tags = ["tiangong", "task-completed"];
  for (const risk of metadata?.routing.riskTypes ?? []) {
    if (tags.length >= MAX_TAGS) break;
    tags.push(risk);
  }
  return tags;
}

/** 教训 tags：lesson/failed 基础标签 + 任务类型（检索方用 filters.tags 命中）。 */
function buildLessonTags(metadata: TaskMetadata | null): string[] {
  const tags = ["tiangong", "lesson", "failed"];
  if (metadata?.taskType && tags.length < MAX_TAGS) {
    tags.push(metadata.taskType);
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
