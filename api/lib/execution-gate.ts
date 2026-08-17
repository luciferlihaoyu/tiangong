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
 * 从任务 input 中提取"可被审批策略评估的自然语言文本"。
 * input 可能是 { payload, metadata } envelope、纯 JSON，或纯文本。
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

/** 用既有审批策略评估任务是否要求人工审批 */
export function evaluateTaskExecution(task: TaskLike): ExecutionDecision {
  const payload = extractTaskPayload(task.input);
  const targetText = (task.description ?? payload ?? "").slice(0, MAX_TARGET);
  const previewText = (payload ?? task.description ?? task.name ?? "task").slice(0, MAX_PREVIEW);
  const decision = evaluateApproval({
    action: (task.name || task.description || task.taskId || "task").slice(0, MAX_ACTION),
    ...(targetText.length > 0 ? { target: targetText } : {}),
    ...(previewText.length > 0 ? { preview: previewText } : {}),
  });
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
  const payload = extractTaskPayload(task.input);
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
  await db
    .update(tasks)
    .set({
      status: "pending",
      boardStatus: "blocked",
      boardNotes: `⏳ Pending human approval: ${decision.riskTypes.join(", ")}`,
      input: mergeTaskMetadata(task.input, buildApprovalPatch(task, decision)),
      blockedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tasks.id, task.id));
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
