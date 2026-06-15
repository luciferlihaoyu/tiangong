/**
 * P10.2: 统一事件总线
 *
 * 标准化所有事件格式，通过 traceId 串联完整链路。
 *
 * 事件类型：
 * - agent.* — Agent 状态变化
 * - task.* — 任务状态变化
 * - message.* — 消息事件
 * - model.* — 模型调用事件
 * - fusion.* — Fusion 审查事件
 * - system.* — 系统事件
 */
import { wsManager } from "../ws-manager";

/* ═══════════════════════════════════════════
   事件类型定义
   ═══════════════════════════════════════════ */

export type EventType =
  // Agent 事件
  | "agent.online"
  | "agent.offline"
  | "agent.busy"
  | "agent.idle"
  | "agent.heartbeat"
  // 任务事件
  | "task.created"
  | "task.queued"
  | "task.started"
  | "task.progress"
  | "task.completed"
  | "task.failed"
  | "task.unblocked"
  // 消息事件
  | "message.sent"
  | "message.delivered"
  | "message.read"
  | "message.acked"
  | "message.expired"
  // 模型调用事件
  | "model.call.started"
  | "model.call.completed"
  | "model.call.failed"
  | "model.high_cost_alert"
  | "model.budget_exceeded"
  // Fusion 审查事件
  | "fusion.submitted"
  | "fusion.review_completed"
  | "fusion.judge_completed"
  | "fusion.completed"
  // 协作事件
  | "collab.delegated"
  | "collab.unblocked"
  | "collab.summary"
  // 系统事件
  | "system.startup"
  | "system.shutdown"
  | "system.error"
  | "system.migration";

/* ═══════════════════════════════════════════
   统一 Event Envelope
   ═══════════════════════════════════════════ */

export interface EventEnvelope {
  /** 事件类型 */
  type: EventType;
  /** 事件唯一 ID */
  eventId: string;
  /** 链路追踪 ID（串联任务、消息、模型调用） */
  traceId?: string;
  /** 来源 Agent ID */
  sourceAgentId?: number;
  /** 目标 Agent ID */
  targetAgentId?: number;
  /** 关联的任务 ID */
  taskId?: number;
  /** 关联的消息 ID */
  messageId?: number;
  /** 关联的模型调用 ID */
  modelCallId?: number;
  /** 来源系统 */
  sourceSystem?: "openclaw" | "arkclaw" | "hermes-agent" | "manual" | "system";
  /** 事件时间 */
  timestamp: string;
  /** 事件负载 */
  payload?: Record<string, unknown>;
}

/* ═══════════════════════════════════════════
   事件总线
   ═══════════════════════════════════════════ */

function generateEventId(): string {
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emit(event: EventEnvelope): void {
  // 广播给所有 Dashboard 客户端
  wsManager.broadcastToDashboard(event);
}

/* ═══════════════════════════════════════════
   便捷发射函数
   ═══════════════════════════════════════════ */

export function emitAgentOnline(agentId: number, payload?: Record<string, unknown>): void {
  emit({
    type: "agent.online",
    eventId: generateEventId(),
    sourceAgentId: agentId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

export function emitAgentOffline(agentId: number, payload?: Record<string, unknown>): void {
  emit({
    type: "agent.offline",
    eventId: generateEventId(),
    sourceAgentId: agentId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

export function emitAgentBusy(agentId: number, taskId?: number, payload?: Record<string, unknown>): void {
  emit({
    type: "agent.busy",
    eventId: generateEventId(),
    sourceAgentId: agentId,
    taskId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

export function emitAgentIdle(agentId: number, payload?: Record<string, unknown>): void {
  emit({
    type: "agent.idle",
    eventId: generateEventId(),
    sourceAgentId: agentId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

export function emitTaskCreated(
  taskId: number,
  name: string,
  agentId?: number,
  traceId?: string,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "task.created",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: agentId,
    taskId,
    timestamp: new Date().toISOString(),
    payload: { name, ...payload },
  });
}

export function emitTaskStarted(
  taskId: number,
  agentId?: number,
  traceId?: string,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "task.started",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: agentId,
    taskId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

export function emitTaskCompleted(
  taskId: number,
  agentId?: number,
  traceId?: string,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "task.completed",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: agentId,
    taskId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

export function emitTaskFailed(
  taskId: number,
  error: string,
  agentId?: number,
  traceId?: string,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "task.failed",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: agentId,
    taskId,
    timestamp: new Date().toISOString(),
    payload: { error, ...payload },
  });
}

export function emitModelCallStarted(
  model: string,
  agentId?: number,
  traceId?: string,
  taskId?: number,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "model.call.started",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: agentId,
    taskId,
    timestamp: new Date().toISOString(),
    payload: { model, ...payload },
  });
}

export function emitModelCallCompleted(
  model: string,
  totalTokens: number,
  costCents: number,
  agentId?: number,
  traceId?: string,
  taskId?: number,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "model.call.completed",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: agentId,
    taskId,
    timestamp: new Date().toISOString(),
    payload: { model, totalTokens, costCents, ...payload },
  });
}

export function emitHighCostAlert(
  model: string,
  costCents: number,
  agentId?: number,
  traceId?: string,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "model.high_cost_alert",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: agentId,
    timestamp: new Date().toISOString(),
    payload: { model, costCents, ...payload },
  });
}

export function emitFusionSubmitted(
  traceId: string,
  subject: string,
  reviewerCount: number,
  agentId?: number,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "fusion.submitted",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: agentId,
    timestamp: new Date().toISOString(),
    payload: { subject, reviewerCount, ...payload },
  });
}

export function emitFusionReviewCompleted(
  traceId: string,
  reviewerId: number,
  reviewerName: string,
  confidence: number,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "fusion.review_completed",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: reviewerId,
    timestamp: new Date().toISOString(),
    payload: { reviewerName, confidence, ...payload },
  });
}

export function emitFusionCompleted(
  traceId: string,
  finalVerdict: string,
  confidence: number,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "fusion.completed",
    eventId: generateEventId(),
    traceId,
    timestamp: new Date().toISOString(),
    payload: { finalVerdict, confidence, ...payload },
  });
}

export function emitMessageSent(
  messageId: number,
  fromAgent: number,
  toAgent: number,
  traceId?: string,
  taskId?: number,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "message.sent",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: fromAgent,
    targetAgentId: toAgent,
    messageId,
    taskId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

export function emitMessageDelivered(
  messageId: number,
  toAgent: number,
  traceId?: string,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "message.delivered",
    eventId: generateEventId(),
    traceId,
    targetAgentId: toAgent,
    messageId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

export function emitMessageAcked(
  messageId: number,
  fromAgent: number,
  traceId?: string,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "message.acked",
    eventId: generateEventId(),
    traceId,
    sourceAgentId: fromAgent,
    messageId,
    timestamp: new Date().toISOString(),
    payload,
  });
}

export function emitSystemError(
  error: string,
  source?: string,
  traceId?: string,
  payload?: Record<string, unknown>
): void {
  emit({
    type: "system.error",
    eventId: generateEventId(),
    traceId,
    timestamp: new Date().toISOString(),
    payload: { error, source, ...payload },
  });
}

export function emitSystemMigration(
  results: string[],
  payload?: Record<string, unknown>
): void {
  emit({
    type: "system.migration",
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    payload: { results, ...payload },
  });
}
