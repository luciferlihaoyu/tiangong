/**
 * 任务输出格式校验 + 自动汇总
 *
 * 功能：
 * - 校验任务输出是否符合 expectedOutputSchema（JSON Schema）
 * - 协作任务完成后自动汇总子任务结果
 */
import { getDb } from "../queries/connection";
import { tasks, taskDependencies, agents } from "@db/schema";
import { eq, and, inArray, asc } from "drizzle-orm";
import { wsManager } from "../ws-manager";

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

/**
 * 自动汇总协作子任务结果
 * 当所有子任务完成或失败时，生成汇总报告
 */
export async function autoSummarizeCollab(parentTaskId: number): Promise<CollabSummaryResult | null> {
  const db = getDb();

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
