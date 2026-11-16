/**
 * 天宫：服务端执行审批闸门 (Execution Gate)
 *
 * 统一的服务端执行决策服务，被任务认领路径（agent.claimTask / agent.updateHeartbeat /
 * taskboard.claim / TaskRunner tick）与完成路径（task.updateProgress / a2a.review /
 * taskboard.updateStatus / task.approve）共同使用：
 *   - 高风险任务（github push/merge/release、zeabur deploy/restart/delete、storage 删除、
 *     newapi 写入、mcp key 变更、外部发送、webhook 调用）在真正执行前被拦下，标记为待人工审批；
 *   - 低风险任务照常执行并自动完成；
 *   - 高风险任务不得通过 connector 无条件 self-approve 或强制完成。
 *
 * 审批状态存放在任务既有字段中（无 schema 迁移）：
 *   - tasks.input 内的 TaskMetadata envelope：routing.approvalRequired / routing.riskTypes /
 *     approval.decision (pending|approved|rejected)
 *   - tasks.status = "pending"（不再 claimable）
 *   - tasks.boardStatus = "blocked"（任务面板可见，供管理员通过 taskboard.approve 审批后重新排队）
 */

import { eq } from "drizzle-orm";
import { tasks } from "@db/schema";
import { getDb } from "../queries/connection";
import { createApprovalRequest, evaluateApproval } from "./approval-policy";
import { mergeTaskMetadata, parseTaskMetadata, type TaskMetadataPatch } from "./task-metadata";
import { applyTaskTransition } from "./task-transition";
import type { ApprovalRiskType } from "../contracts/platform";

export type Db = ReturnType<typeof getDb>;

/** 任务最小投影（认领/完成闸门只需要这些字段） */
export type TaskLike = Readonly<{
  id: number;
  taskId: string;
  name: string;
  description: string | null;
  input: string | null;
  agentId: number | null;
  status: "running" | "pending" | "done" | "failed" | "queued";
  boardStatus: string | null;
  priority?: number | null;
}>;

export type ExecutionDecision = Readonly<{
  requiresApproval: boolean;
  riskTypes: readonly ApprovalRiskType[];
}>;

export type ApprovalState = Readonly<{
  required: boolean;
  decision: "pending" | "approved" | "rejected" | null;
  riskTypes: readonly ApprovalRiskType[];
}>;

export type GateCheck =
  | Readonly<{ status: "allowed" }>
  | Readonly<{ status: "blocked"; reason: string; riskTypes: readonly ApprovalRiskType[] }>;

const MAX_ACTION = 2000;
const MAX_TARGET = 500;
const MAX_PREVIEW = 5000;

/**
 * p2.5-e：从任务 input 中只提取**人类语义文本**，供风险分类器使用。
 *
 * 为什么必须收窄（生产实锤 #216/#217）：分类器原先吃的是"整个 input 的序列化文本"。
 * 凡经 mjs / escalation 建的单，input 必带 metadata.origin.system:"mcp" 与
 * payload.idempotencyKey —— camelCase 转小写后天然含 "key"，于是 approval-policy 的
 * mcp_key_change 规则（要求同时命中 "mcp" 与 key/token/rotate/... 任一动作词）**必然误命中**，
 * TaskRunner 每轮 tick 把这些普通文案单 park 成"待人工审批"，新单全卡。
 * 同类形状对 storage_delete / newapi_write / webhook_call 等 containsAll 规则一样成立
 * （结构字段名本身就是英文词根：idempotencyKey / apikey / token / channel / budget）。
 *
 * 本函数只取人写的自然语言：ticket.content.summary/detail、acceptance.checks、notes、
 * 以及自由文本 payload；**metadata / routing / trace / origin / policies / refs /
 * importance / idempotencyKey / deliverable.path / source.eventId / executor / initiator
 * 等系统结构字段一律不进**。动词表本身一字未动——收紧词表是另一层决策，避免把真高危漏掉。
 */
export function extractRiskText(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return trimmed;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (parsed === null || typeof parsed !== "object") return trimmed;
  if (Array.isArray(parsed)) return null; // 数组无固定人类语义字段，宁可不喂

  const record = parsed as Record<string, unknown>;
  const parts: string[] = [];
  const payload = record.payload;

  if (typeof payload === "string") {
    parts.push(payload);
  } else if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const payloadRecord = payload as Record<string, unknown>;
    const ticket = payloadRecord.ticket;
    if (ticket !== null && typeof ticket === "object" && !Array.isArray(ticket)) {
      // ticket-v2（tg-create-task.mjs / escalation 建单）：只有 content / acceptance / notes 是人写的
      const t = ticket as Record<string, unknown>;
      const content = t.content;
      if (content !== null && typeof content === "object" && !Array.isArray(content)) {
        for (const key of ["summary", "detail"] as const) {
          const value = (content as Record<string, unknown>)[key];
          if (typeof value === "string") parts.push(value);
        }
      }
      const acceptance = t.acceptance;
      if (acceptance !== null && typeof acceptance === "object" && !Array.isArray(acceptance)) {
        const checks = (acceptance as Record<string, unknown>).checks;
        if (Array.isArray(checks)) {
          for (const check of checks) if (typeof check === "string") parts.push(check);
        }
      }
      if (typeof t.notes === "string") parts.push(t.notes);
    } else {
      // 通用对象 payload：只认明确的人写字段名，其余键（含 *Key/*Token 类结构字段）不猜
      for (const key of ["prompt", "task", "text", "goal", "summary", "description", "content"] as const) {
        const value = payloadRecord[key];
        if (typeof value === "string") parts.push(value);
      }
    }
  } else if (typeof record.input === "string") {
    parts.push(record.input);
  } else if (typeof record.task === "string") {
    parts.push(record.task);
  } else if (typeof record.prompt === "string") {
    parts.push(record.prompt);
  } else if (typeof record.description === "string") {
    parts.push(record.description);
  }

  const joined = parts.join(" ").trim();
  return joined.length > 0 ? joined : null;
}

/**
 * 从任务 input 中提取"可展示/可存档的任务正文文本"（供人工审批预览与预审阅读）。
 * ⚠️ 不得用于风险分类——那会重犯 p2.5-e 的全量文本误伤；分类请用 extractRiskText。
 */
export function extractTaskPayload(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (typeof record.payload === "string") return record.payload;
        if (typeof record.input === "string") return record.input;
        if (typeof record.task === "string") return record.task;
        if (typeof record.prompt === "string") return record.prompt;
      }
      return trimmed;
    } catch {
      // 非 JSON，回落为原始文本
    }
  }
  return trimmed;
}

/** 读取任务 input 中已存储的审批状态（未评估则 required=false） */
export function getApprovalState(input: string | null | undefined): ApprovalState {
  const metadata = parseTaskMetadata(input ?? null);
  if (!metadata) {
    return { required: false, decision: null, riskTypes: [] };
  }
  return {
    required: metadata.routing.approvalRequired,
    decision: metadata.approval?.decision ?? null,
    riskTypes: metadata.routing.riskTypes,
  };
}

/**
 * 用既有审批策略评估任务是否要求人工审批。
 *
 * p2.5-e：喂给规则引擎的文本 = name + description（人写的）+ extractRiskText(input)
 * （input 里的人类语义部分）。序列化后的整段 input / metadata / origin /
 * idempotencyKey 等系统结构字段**不进分类器**（#216/#217 全卡事故根因）。
 */
export function evaluateTaskExecution(task: TaskLike): ExecutionDecision {
  const riskText = extractRiskText(task.input);
  const combinedAction = [task.name, task.description ?? "", riskText ?? ""]
    .filter((part) => part.length > 0)
    .join(" ")
    .slice(0, MAX_ACTION);
  const decision = evaluateApproval({ action: combinedAction || "task" });
  return { requiresApproval: decision.approvalRequired, riskTypes: decision.riskTypes };
}

/**
 * 执行闸门：任务能否开始执行。
 * 若 metadata 已标记需审批，则已批准才放行；否则用审批策略实时评估。
 */
export function checkExecutionGate(task: TaskLike): GateCheck {
  const state = getApprovalState(task.input);
  if (state.required) {
    if (state.decision === "approved") {
      return { status: "allowed" };
    }
    return {
      status: "blocked",
      reason: `Task requires human approval before execution (${state.riskTypes.join(", ") || "high risk"})`,
      riskTypes: state.riskTypes,
    };
  }
  const decision = evaluateTaskExecution(task);
  if (decision.requiresApproval) {
    return {
      status: "blocked",
      reason: `Task requires human approval before execution (${decision.riskTypes.join(", ")})`,
      riskTypes: decision.riskTypes,
    };
  }
  return { status: "allowed" };
}

/**
 * 完成闸门：任务能否被置为 done / completed。
 * 高风险任务只有在人工已批准（approval.decision === "approved"）后才能完成；
 * 否则任何 self-approve / force-complete 都被拒绝。
 */
export function checkCompletionGate(task: TaskLike): GateCheck {
  const state = getApprovalState(task.input);
  if (state.required && state.decision !== "approved") {
    return {
      status: "blocked",
      reason: `Task requires human approval before completion (${state.riskTypes.join(", ") || "high risk"})`,
      riskTypes: state.riskTypes,
    };
  }
  const decision = evaluateTaskExecution(task);
  if (decision.requiresApproval && state.decision !== "approved") {
    return {
      status: "blocked",
      reason: `Task requires human approval before completion (${decision.riskTypes.join(", ")})`,
      riskTypes: decision.riskTypes,
    };
  }
  return { status: "allowed" };
}

/** 构造"待审批"的 TaskMetadata 补丁（decision = pending） */
export function buildApprovalPatch(task: TaskLike, decision: ExecutionDecision): TaskMetadataPatch {
  // p2.5-e：给人工审批看的 preview 优先用**人类语义文本**（分类同源、可读），
  // 整段序列化 input 只作兜底——ticket envelope 原样塞进预览既不可读，也是旧误伤的来源形状。
  const humanText = extractRiskText(task.input);
  const payload = humanText ?? extractTaskPayload(task.input);
  const approval = createApprovalRequest({
    riskType: decision.riskTypes[0],
    requestedByTaskId: task.taskId,
    requestedByAgentId: task.agentId !== null ? String(task.agentId) : "system",
    target: (task.name || task.taskId).slice(0, MAX_TARGET),
    preview: (payload ?? task.description ?? task.name ?? "task").slice(0, MAX_PREVIEW),
  });
  return {
    routing: { approvalRequired: true, riskTypes: [...decision.riskTypes] },
    approval,
  };
}

/** 将任务的审批标记为已批准（用于管理员审批后重新排队） */
export function approveTaskMetadata(input: string | null | undefined): string {
  const metadata = parseTaskMetadata(input ?? null);
  if (!metadata?.approval) return input ?? "";
  const patch: TaskMetadataPatch = {
    routing: { approvalRequired: true, riskTypes: [...metadata.routing.riskTypes] },
    approval: { ...metadata.approval, decision: "approved" },
  };
  return mergeTaskMetadata(input ?? null, patch);
}

/**
 * 将高风险任务"停放"为待审批：不再 claimable，任务面板以 blocked 展示，
 * 并把风险原因写入 tasks.input 的 metadata 与 boardNotes。
 */
export async function parkTaskForApproval(db: Db, task: TaskLike, decision: ExecutionDecision): Promise<void> {
  // §3-3：停放是状态变更（pending + blocked），走转移服务递增修订号。
  // 失败（并发推进）只告警不抛：park 的调用方（闸门/Runner）不 catch，抛错会打断扫描主流程。
  const parked = await applyTaskTransition(db as never, {
    taskId: task.id,
    status: "pending",
    boardStatus: "blocked",
    at: new Date(),
    extra: {
      boardNotes: `⏳ Pending human approval: ${decision.riskTypes.join(", ")}`,
      input: mergeTaskMetadata(task.input, buildApprovalPatch(task, decision)),
      blockedAt: new Date(),
    },
  });
  if (!parked.ok) {
    console.warn(`[execution-gate] park lost race for task ${task.id}: ${parked.reason}`);
  }
}

/** 从候选任务中选出第一个可执行（未拦下）的任务，并把沿途高风险任务停放待审批。 */
export async function selectExecutableTask(db: Db, candidates: readonly TaskLike[]): Promise<TaskLike | null> {
  const sorted = [...candidates].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const task of sorted) {
    const state = getApprovalState(task.input);
    if (state.required) {
      if (state.decision === "approved") return task;
      // 尚未批准：确保保持停放状态，并跳过
      if (task.status === "queued" || task.boardStatus !== "blocked") {
        await parkTaskForApproval(db, task, { requiresApproval: true, riskTypes: state.riskTypes });
      }
      continue;
    }
    const decision = evaluateTaskExecution(task);
    if (decision.requiresApproval) {
      await parkTaskForApproval(db, task, decision);
      continue;
    }
    return task;
  }
  return null;
}
