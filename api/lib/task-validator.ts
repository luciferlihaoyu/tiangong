/**
 * 任务输出格式校验 + 自动汇总
 *
 * 功能：
 * - 校验任务输出是否符合 expectedOutputSchema（JSON Schema）
 * - 协作任务完成后自动汇总子任务结果
 */
import { getDb } from "../queries/connection";
import { tasks, taskArtifacts, agents } from "@db/schema";
import { eq, and, inArray, asc } from "drizzle-orm";
import { wsManager } from "../ws-manager";
import { summarizeCollabWithTianshu } from "./summarizer";
import { recordExternalUsage } from "./external-usage";

/* ═══════════════════════════════════════════
   输出格式校验
   ═══════════════════════════════════════════ */

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * 校验任务输出是否符合 expectedOutputSchema
 * schema 格式：JSON Schema 子集
 *
 * 支持：
 * - type: "string" | "number" | "boolean" | "array" | "object"
 * - minLength / maxLength (string)
 * - minItems / maxItems (array)
 * - required (object)
 * - properties (object)
 */
export function validateOutput(output: string, schema: string): ValidationResult {
  const errors: string[] = [];

  let parsedSchema: any;
  let parsedOutput: any;

  try {
    parsedSchema = JSON.parse(schema);
  } catch {
    return { valid: false, errors: ["Schema 不是有效的 JSON"] };
  }

  // 如果 schema 是空对象，跳过校验
  if (Object.keys(parsedSchema).length === 0) {
    return { valid: true, errors: [] };
  }

  // 尝试解析 output 为 JSON
  try {
    parsedOutput = JSON.parse(output);
  } catch {
    // output 不是 JSON，按字符串处理
    parsedOutput = output;
  }

  const expectedType = parsedSchema.type;

  // type 校验
  if (expectedType) {
    const actualType = Array.isArray(parsedOutput) ? "array" : typeof parsedOutput;
    if (actualType !== expectedType) {
      errors.push(`类型不匹配: 期望 ${expectedType}, 实际 ${actualType}`);
    }
  }

  // string 校验
  if (expectedType === "string" || typeof parsedOutput === "string") {
    const str = String(parsedOutput);
    if (parsedSchema.minLength && str.length < parsedSchema.minLength) {
      errors.push(`字符串长度不足: 最小 ${parsedSchema.minLength}, 实际 ${str.length}`);
    }
    if (parsedSchema.maxLength && str.length > parsedSchema.maxLength) {
      errors.push(`字符串超长: 最大 ${parsedSchema.maxLength}, 实际 ${str.length}`);
    }
  }

  // array 校验
  if (Array.isArray(parsedOutput)) {
    if (parsedSchema.minItems && parsedOutput.length < parsedSchema.minItems) {
      errors.push(`数组元素不足: 最小 ${parsedSchema.minItems}, 实际 ${parsedOutput.length}`);
    }
    if (parsedSchema.maxItems && parsedOutput.length > parsedSchema.maxItems) {
      errors.push(`数组元素过多: 最大 ${parsedSchema.maxItems}, 实际 ${parsedOutput.length}`);
    }
  }

  // object 校验
  if (parsedOutput && typeof parsedOutput === "object" && !Array.isArray(parsedOutput)) {
    if (parsedSchema.required && Array.isArray(parsedSchema.required)) {
      for (const field of parsedSchema.required) {
        if (!(field in parsedOutput)) {
          errors.push(`缺少必需字段: ${field}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 校验并更新任务输出状态
 */
export async function validateAndUpdateTask(taskId: number): Promise<ValidationResult> {
  const db = getDb();
  const task = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .then((rows) => rows[0]);

  if (!task) return { valid: false, errors: ["任务不存在"] };
  if (!task.expectedOutputSchema || !task.output) {
    return { valid: true, errors: [] };
  }

  const result = validateOutput(task.output, task.expectedOutputSchema);

  await db
    .update(tasks)
    .set({ outputValid: result.valid ? "true" : "false" })
    .where(eq(tasks.id, taskId));

  return result;
}

/* ═══════════════════════════════════════════
   任务结果自动汇总
   ═══════════════════════════════════════════ */

interface CollabSummaryResult {
  parentTaskId: number;
  overallStatus: string;
  totalSubtasks: number;
  completed: number;
  failed: number;
  summary: string;
  outputs: Array<{
    taskId: number;
    taskKey: string;
    agentName: string | null;
    output: string | null;
    status: string;
  }>;
}

/** 协作汇总报告在 task_artifacts 中的固定类型（幂等闸标记 + AList 归档通道） */
export const COLLAB_SUMMARY_ARTIFACT_TYPE = "collab_summary";

const MAX_ARTIFACT_NAME = 255;

/**
 * 自动汇总协作子任务结果
 * 当所有子任务完成或失败时，生成汇总报告
 *
 * 触发与归档（任务 1.3）：由 task-finalize.ts 的 maybeSummarizeParent 在每个
 * 子任务完成路径末尾调用；尚有子任务未终态时返回 null（天然防误触发）。
 * 汇总生成后写一条 collab_summary artifact 并对父任务走统一 finalize 入口，
 * 使汇总报告自动双归档（璇玑记忆 + AList tasks/{父taskId}/output.md 与
 * artifacts/collab-summary-*.md）。
 */
export async function autoSummarizeCollab(parentTaskId: number): Promise<CollabSummaryResult | null> {
  const db = getDb();

  // 幂等闸：父任务已有 collab_summary artifact 则直接返回，防止多个子任务并发
  // 完成时重复汇总/重复广播/重复归档。check-then-insert 与 xuanji-sync / alist-sync
  // 两个模块同一模式——检查与插入之间存在竞态窗口，并发双双通过闸门只会多写一份
  // 内容确定性相同的汇总，无破坏性后果，窗口可接受。
  const existingSummary = await db
    .select({ id: taskArtifacts.id })
    .from(taskArtifacts)
    .where(and(eq(taskArtifacts.taskId, parentTaskId), eq(taskArtifacts.type, COLLAB_SUMMARY_ARTIFACT_TYPE)))
    .limit(1)
    .then((rows) => rows[0]);
  if (existingSummary) return null;

  const parent = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, parentTaskId))
    .then((rows) => rows[0]);

  if (!parent) return null;

  const childRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(asc(tasks.createdAt));

  if (childRows.length === 0) return null;

  const agentIds = Array.from(new Set(childRows.map((t) => t.agentId).filter((id): id is number => id !== null)));
  const agentRows = agentIds.length > 0
    ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
    : [];
  const agentMap = new Map(agentRows.map((a) => [a.id, a.name]));

  const done = childRows.filter((t) => t.status === "done").length;
  const failed = childRows.filter((t) => t.status === "failed").length;
  const total = childRows.length;
  const terminal = done + failed;

  if (terminal < total) return null; // 还有未完成的子任务

  const overallStatus = failed > 0 ? "failed" : "done";

  // 生成汇总文本
  const summaryLines: string[] = [
    `## 协作任务汇总: ${parent.name}`,
    `状态: ${overallStatus === "done" ? "✅ 全部完成" : "⚠️ 部分失败"}`,
    `子任务: ${done}/${total} 完成, ${failed} 失败`,
    "",
  ];

  // 任务 3.2：可选 LLM 总结增强（默认关闭）
  // 开关严格等于 "true" 才走 LLM 路径——避免对现有部署产生非预期行为与额外成本。
  // 任何失败（未配置 / 超时 / 解析失败 / 抛错）一律降级到上面的原机械模板，零失败风险。
  // 记账走 recordExternalUsage（任务 1.4 公共 helper），归因到父任务 agentId（汇总场景
  // 无固定 agent；父任务无 agent 时归属 0，与 memory-compensation sweeper 同口径）。
  //
  // 子任务数 > 50 跳过 LLM 路径（3.2 评审 minor 防御）：经验阈值——
  //   1) 子任务再多，LLM 一段总结的信息密度边际下降
  //   2) prompt 体积随子任务数线性放大，超过一定量会撞天枢单 prompt token 上限
  //   3) 单次 LLM 调用的成本与时延对大 N 场景不可接受
  // 降级走与"未配置返回 null"同模式的 return，调用方按 null 走原机械模板，零破坏性。
  if (process.env.TIANGONG_SUMMARY_LLM_ENABLED === "true" && childRows.length > 50) {
    console.warn(
      `[task-validator] 子任务数 ${childRows.length} > 50，跳过 LLM 总结，沿用原机械模板`
    );
  } else if (process.env.TIANGONG_SUMMARY_LLM_ENABLED === "true") {
    try {
      const childSummaries = childRows.map((c) => ({
        taskId: c.taskId,
        name: c.name,
        status: (c.status === "done" || c.status === "failed" ? c.status : "done") as "done" | "failed",
        output: c.output,
        error: c.error,
      }));
      const llmResult = await summarizeCollabWithTianshu(childSummaries);
      if (llmResult) {
        // AI 总结段插在标题之后、状态计数之前，让读者先看核心结论再看细节
        summaryLines.splice(1, 0, `## AI 总结\n\n${llmResult.text}\n`);
        // 记账：与 recordExternalUsage 同款 source 字段标记为 "summary_llm"，便于用量页按来源归因
        // 防御性处理 usage：summarizer 接口约定 LlmUsage，但 mock 或未来接口变化可能传 null/undefined
        const usage = llmResult.usage ?? { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
        try {
          await recordExternalUsage(db, {
            taskId: parent.id,
            agentId: parent.agentId ?? 0,
            model: llmResult.model,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            cachedPromptTokens: usage.cachedPromptTokens,
            source: "summary_llm",
          });
        } catch (e) {
          // 尽力而为：记账失败绝不影响汇总主流程
          console.warn(
            `[task-validator] summary LLM usage record failed for parent ${parent.taskId}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }
    } catch (e) {
      // LLM 路径任何异常（抛错、解析失败等）一律降级到原模板
      console.warn(
        `[task-validator] summary LLM failed for parent ${parent.taskId}, falling back to template: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  for (const child of childRows) {
    const agentName = child.agentId ? agentMap.get(child.agentId) || `#${child.agentId}` : "未分配";
    const statusIcon = child.status === "done" ? "✅" : child.status === "failed" ? "❌" : "⏳";
    summaryLines.push(`### ${child.name} ${statusIcon}`);
    summaryLines.push(`Agent: ${agentName}`);
    summaryLines.push(`状态: ${child.status}`);
    if (child.output) {
      summaryLines.push(`输出: ${child.output.slice(0, 500)}`);
    }
    if (child.error) {
      summaryLines.push(`错误: ${child.error}`);
    }
    summaryLines.push("");
  }

  const summary = summaryLines.join("\n");

  // 更新父任务 output 为汇总
  await db
    .update(tasks)
    .set({
      output: summary,
      status: overallStatus,
      progress: 100,
    })
    .where(eq(tasks.id, parentTaskId));

  // 广播事件
  wsManager.broadcastToDashboard({
    type: "collab_summary",
    parentTaskId,
    overallStatus,
    done,
    failed,
    total,
    timestamp: new Date().toISOString(),
  });

  // 归档①：汇总报告写一条 task_artifacts。用 content（正文）而非 jsonPayload，
  // 这样 alist-sync 遍历 task_artifacts 时会按 mimeType=text/markdown 上传为
  // artifacts/collab-summary-{taskId}.md（它只跳过 alist_sync / xuanji_memory 两类标记）。
  // 该记录同时是函数开头的幂等闸标记，必须在 finalize 之前落库。
  await db.insert(taskArtifacts).values({
    taskId: parent.id,
    agentId: parent.agentId,
    type: COLLAB_SUMMARY_ARTIFACT_TYPE,
    name: `collab-summary-${parent.taskId}`.slice(0, MAX_ARTIFACT_NAME),
    content: summary,
    mimeType: "text/markdown",
  });

  // 归档②：对父任务走统一 finalize 入口（写璇玑记忆 + 上传 AList，含刚插入的
  // 汇总 artifact → tasks/{父taskId}/output.md + artifacts/collab-summary-*.md）。
  // 视图用 update 前读出的父任务行 + 汇总后的 output/status 覆盖构造，避免再查
  // 一次库；保留行内 parentTaskId——多级 DAG 时 finalize 内部会继续向上汇总，
  // 根任务的 parentTaskId 为 null 则自然 no-op。
  //
  // 循环依赖说明：task-finalize.ts 静态 import 本模块（编排方向固定为
  // finalize → validator），这里若再静态 import task-finalize 会形成加载期循环；
  // 故用动态 import 把取模块推迟到调用期——此时两个模块均已完成初始化，
  // vitest（vite-node）与 esbuild/tsc 均支持该写法。
  const { finalizeCompletedTask } = await import("./task-finalize");
  await finalizeCompletedTask(db, {
    ...parent,
    output: summary,
    status: overallStatus,
  });

  return {
    parentTaskId,
    overallStatus,
    totalSubtasks: total,
    completed: done,
    failed,
    summary,
    outputs: childRows.map((t) => ({
      taskId: t.id,
      taskKey: t.taskId,
      agentName: t.agentId ? agentMap.get(t.agentId) || null : null,
      output: t.output,
      status: t.status,
    })),
  };
}
