import { useParams, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Target,
  Clock,
  User,
  MessageSquare,
  FileText,
  AlertTriangle,
  CheckCircle,
  ChevronRight,
  Shield,
  RotateCcw,
  XCircle,
} from "lucide-react";

// ═══════════════════════ Types ═══════════════════════

interface ThreadMessage {
  id: number;
  taskId: number;
  threadId: number | null;
  fromAgentId: number | null;
  toAgentId: number | null;
  eventType: string;
  content: string | null;
  metadata: unknown;
  createdAt: string;
}

interface TaskArtifact {
  id: number;
  taskId: number;
  agentId: number | null;
  type: string;
  name: string | null;
  content: string | null;
  jsonPayload: unknown;
  mimeType: string | null;
  createdAt: string;
}

interface TaskDetailData {
  id: number;
  taskId: string;
  name: string;
  agentId: number | null;
  status: string;
  lifecycleStatus: string | null;
  progress: number;
  description: string | null;
  priority: number;
  input: string | null;
  output: string | null;
  error: string | null;
  retryCount: number;
  maxRetries: number;
  parentTaskId: number | null;
  createdAt: string;
  updatedAt: string;
  threadMessages: ThreadMessage[];
  artifacts: TaskArtifact[];
}

// ═══════════════════════ Constants ═══════════════════════

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  pending: { label: "待处理", color: "var(--text-muted)", bg: "rgba(180,200,255,0.03)" },
  queued: { label: "已排队", color: "var(--accent-cyan)", bg: "rgba(74,158,255,0.08)" },
  running: { label: "执行中", color: "var(--warning)", bg: "var(--accent-glow-gold)" },
  done: { label: "已完成", color: "var(--success)", bg: "rgba(76,175,125,0.08)" },
  failed: { label: "失败", color: "var(--accent-red)", bg: "var(--accent-glow-red)" },
};

const LIFECYCLE_STAGES = [
  { key: "created", label: "已创建" },
  { key: "queued", label: "已排队" },
  { key: "dispatched", label: "已投递" },
  { key: "claimed", label: "已认领" },
  { key: "working", label: "工作中" },
  { key: "completed", label: "已完成" },
  { key: "failed", label: "已失败" },
];

const PRIORITY_LABELS: Record<number, string> = {
  0: "普通",
  1: "低",
  2: "中",
  3: "高",
  4: "紧急",
  5: "最高",
};

const PRIORITY_COLORS: Record<number, string> = {
  0: "var(--text-muted)",
  1: "var(--text-secondary)",
  2: "var(--accent-cyan)",
  3: "var(--accent-gold)",
  4: "var(--accent-red)",
  5: "var(--accent-red)",
};

// ═══════════════════════ Helpers ═══════════════════════

function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatJson(value: string | null): string {
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

// ═══════════════════════ Component ═══════════════════════

export default function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const taskIdNum = id ? Number(id) : NaN;

  const taskQuery = trpc.task.getById.useQuery(
    { id: taskIdNum },
    { enabled: !isNaN(taskIdNum) && taskIdNum > 0, retry: 1, staleTime: 5000 }
  );

  const agentQuery = trpc.agent.list.useQuery(undefined, {
    retry: 1,
    staleTime: 30000,
    enabled: taskQuery.isSuccess,
  });

  const task = taskQuery.data as TaskDetailData | null | undefined;
  const agents = (agentQuery.data || []) as { id: number; name: string; agentId: string; status: string }[];

  const assignee = useMemo(() => {
    if (!task?.agentId) return null;
    return agents.find((a) => a.id === task.agentId) || null;
  }, [agents, task?.agentId]);

  const statusConfig = STATUS_CONFIG[task?.status || "pending"] || STATUS_CONFIG.pending;

  // Lifecycle timeline: determine which stages are active/completed
  const lifecycleStage = task?.lifecycleStatus || task?.status || "pending";
  const stageIndex = LIFECYCLE_STAGES.findIndex((s) => s.key === lifecycleStage);
  const isFailed = task?.status === "failed" || lifecycleStage === "failed";
  const isDone = task?.status === "done" || lifecycleStage === "completed";

  const handleBack = () => {
    navigate(-1);
  };

  const utils = trpc.useUtils();
  const [reviewComment, setReviewComment] = useState("");

  const approveMutation = trpc.task.approve.useMutation({
    onSuccess: () => {
      toast.success("任务已审批通过");
      utils.task.getById.invalidate({ id: taskIdNum });
      setReviewComment("");
    },
    onError: (err) => {
      toast.error(`审批失败: ${err.message}`);
    },
  });

  const rejectMutation = trpc.task.reject.useMutation({
    onSuccess: () => {
      toast.success("任务已退回修改");
      utils.task.getById.invalidate({ id: taskIdNum });
      setReviewComment("");
    },
    onError: (err) => {
      toast.error(`操作失败: ${err.message}`);
    },
  });

  const updateProgressMutation = trpc.task.updateProgress.useMutation({
    onSuccess: () => {
      toast.success("任务已拒绝");
      utils.task.getById.invalidate({ id: taskIdNum });
      setReviewComment("");
    },
    onError: (err) => {
      toast.error(`操作失败: ${err.message}`);
    },
  });

  const isReviewing = task?.lifecycleStatus === "reviewing";
  const isActionPending = approveMutation.isPending || rejectMutation.isPending || updateProgressMutation.isPending;

  // Loading state
  if (taskQuery.isLoading) {
    return (
      <div className="min-h-screen pt-16 flex items-center justify-center" style={{ backgroundColor: "var(--bg-primary)" }}>
        <div className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
          加载任务详情...
        </div>
      </div>
    );
  }

  // Error / not found state
  if (taskQuery.isError || !task) {
    return (
      <div className="min-h-screen pt-16 px-4 md:px-6 py-6" style={{ backgroundColor: "var(--bg-primary)" }}>
        <button
          onClick={handleBack}
          className="flex items-center gap-2 text-xs font-mono mb-6 transition-colors hover:brightness-110"
          style={{ color: "var(--text-muted)" }}
        >
          <ArrowLeft size={14} />
          返回
        </button>
        <div className="glass-panel p-8 text-center max-w-md mx-auto sci-border">
          <AlertTriangle size={40} className="mx-auto mb-3 opacity-30" style={{ color: "var(--accent-red)" }} />
          <div className="text-sm font-bold mb-2" style={{ color: "var(--text-primary)" }}>
            {taskQuery.isError ? "加载失败" : "任务不存在"}
          </div>
          <div className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
            {taskQuery.isError
              ? "无法从后端获取任务数据，请检查网络连接或稍后重试。"
              : `未找到 ID 为 ${id} 的任务。`}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-16 px-4 md:px-6 py-6" style={{ backgroundColor: "var(--bg-primary)" }}>
      {/* Back button */}
      <button
        onClick={handleBack}
        className="flex items-center gap-2 text-xs font-mono mb-4 transition-colors hover:brightness-110"
        style={{ color: "var(--text-muted)" }}
      >
        <ArrowLeft size={14} />
        返回
      </button>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 flex-wrap">
          <Target size={24} style={{ color: statusConfig.color }} />
          <h1
            className="text-xl font-black tracking-wider"
            style={{ color: "var(--text-primary)" }}
          >
            {task.name}
          </h1>
          <span
            className="text-[10px] px-2 py-0.5 rounded font-mono flex items-center gap-1"
            style={{
              background: statusConfig.bg,
              color: statusConfig.color,
              border: `1px solid ${statusConfig.color}22`,
            }}
          >
            {task.status === "done" && <CheckCircle size={10} />}
            {statusConfig.label}
          </span>
          <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>
            {task.taskId}
          </span>
        </div>
        <div className="text-xs font-mono mt-1" style={{ color: "var(--text-muted)" }}>
          TASK DETAIL · ID #{task.id}
        </div>
      </div>

      <div className="max-w-4xl">
        {/* Basic Info */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-2">
            <span className="section-label">基础信息</span>
            <div className="flex-1 h-px" style={{ background: "var(--border-default)" }} />
          </div>
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono p-3 rounded glass-panel"
          >
            <div>
              <span style={{ color: "var(--text-muted)" }}>创建时间:</span>{" "}
              <span style={{ color: "var(--text-secondary)" }}>{fmtTime(task.createdAt)}</span>
            </div>
            <div>
              <span style={{ color: "var(--text-muted)" }}>更新时间:</span>{" "}
              <span style={{ color: "var(--text-secondary)" }}>{fmtTime(task.updatedAt)}</span>
            </div>
            <div className="flex items-center gap-1">
              <span style={{ color: "var(--text-muted)" }}>分配给:</span>{" "}
              {assignee ? (
                <span className="flex items-center gap-1">
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      background:
                        assignee.status === "online"
                          ? "var(--success)"
                          : assignee.status === "busy"
                            ? "var(--warning)"
                            : "var(--text-muted)",
                    }}
                  />
                  <span style={{ color: "var(--text-primary)" }}>{assignee.name}</span>
                  <span style={{ color: "var(--text-muted)" }}>({assignee.agentId})</span>
                </span>
              ) : (
                <span style={{ color: "var(--text-muted)" }}>
                  <User size={10} className="inline mr-1" />
                  未指派
                </span>
              )}
            </div>
            <div>
              <span style={{ color: "var(--text-muted)" }}>优先级:</span>{" "}
              <span style={{ color: PRIORITY_COLORS[task.priority] || PRIORITY_COLORS[0] }}>
                P{task.priority} {PRIORITY_LABELS[task.priority] || "普通"}
              </span>
            </div>
            <div className="sm:col-span-2">
              <span style={{ color: "var(--text-muted)" }}>进度:</span>{" "}
              <span style={{ color: "var(--text-secondary)" }}>{task.progress}%</span>
              <div className="progress-track mt-1.5 w-full max-w-xs">
                <div
                  className="progress-fill"
                  style={{ width: `${task.progress}%` }}
                />
              </div>
            </div>
            <div>
              <span style={{ color: "var(--text-muted)" }}>重试:</span>{" "}
              <span style={{ color: "var(--text-secondary)" }}>
                {task.retryCount}/{task.maxRetries}
              </span>
            </div>
          </div>
        </div>

        {/* Lifecycle Timeline */}
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-3">
            <span className="section-label">状态流转</span>
            <div className="flex-1 h-px" style={{ background: "var(--border-default)" }} />
          </div>
          <div className="flex items-start gap-1 overflow-x-auto pb-2">
            {LIFECYCLE_STAGES.map((stage, idx) => {
              const isActive = idx <= stageIndex && stageIndex !== -1;
              const isCurrent = idx === stageIndex;
              const isFailStage = stage.key === "failed" && isFailed;
              const isDoneStage = stage.key === "completed" && isDone;
              const completed = isFailStage || isDoneStage || (isActive && !isFailed && !isDone && idx < stageIndex);
              const current = isCurrent || isFailStage || isDoneStage;

              return (
                <div key={stage.key} className="flex items-center flex-shrink-0">
                  <div className="flex flex-col items-center gap-1 px-1">
                    <div
                      className="w-2.5 h-2.5 rounded-full transition-all"
                      style={{
                        background: completed
                          ? stage.key === "failed"
                            ? "var(--accent-red)"
                            : stage.key === "completed"
                              ? "var(--success)"
                              : "var(--accent-cyan)"
                          : current
                            ? "var(--accent-gold)"
                            : "var(--border-default)",
                        boxShadow: completed || current
                          ? `0 0 8px ${stage.key === "failed" ? "var(--accent-red)" : stage.key === "completed" ? "var(--success)" : "var(--accent-cyan)"}`
                          : "none",
                      }}
                    />
                    <span
                      className="text-[9px] font-mono whitespace-nowrap"
                      style={{
                        color: completed
                          ? stage.key === "failed"
                            ? "var(--accent-red)"
                            : stage.key === "completed"
                              ? "var(--success)"
                              : "var(--accent-cyan)"
                          : current
                            ? "var(--accent-gold)"
                            : "var(--text-muted)",
                      }}
                    >
                      {stage.label}
                    </span>
                  </div>
                  {idx < LIFECYCLE_STAGES.length - 1 && (
                    <div
                      className="w-4 h-px mt-[-8px]"
                      style={{
                        background: completed
                          ? "var(--accent-cyan)"
                          : "var(--border-default)",
                        opacity: completed ? 0.4 : 0.3,
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {task.lifecycleStatus && (
            <div className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              当前生命周期: {task.lifecycleStatus}
            </div>
          )}
        </div>

        {/* Review Panel */}
        {isReviewing && (
          <div className="mb-6 glass-panel p-4 sci-border" style={{ border: "1px solid rgba(74,158,255,0.2)" }}>
            <div className="flex items-center gap-2 mb-3">
              <Shield size={14} style={{ color: "var(--accent-cyan)" }} />
              <span className="section-label" style={{ color: "var(--accent-cyan)" }}>审批操作 · REVIEW</span>
              <div className="flex-1 h-px" style={{ background: "var(--border-default)" }} />
            </div>
            <div className="text-[10px] font-mono mb-3" style={{ color: "var(--text-muted)" }}>
              该任务已提交审批，请选择审批操作并填写意见。
            </div>
            <textarea
              value={reviewComment}
              onChange={(e) => setReviewComment(e.target.value)}
              placeholder="输入审批意见（可选）..."
              rows={2}
              className="w-full px-3 py-2 rounded text-xs outline-none font-mono resize-none mb-3"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => approveMutation.mutate({ id: taskIdNum, comment: reviewComment || undefined })}
                disabled={isActionPending}
                className="px-4 py-2 rounded text-xs font-mono font-bold transition-all hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
                style={{ background: "rgba(76,175,125,0.1)", color: "var(--success)", border: "1px solid rgba(76,175,125,0.2)" }}
              >
                <CheckCircle size={12} /> 通过
              </button>
              <button
                onClick={() => rejectMutation.mutate({ id: taskIdNum, comment: reviewComment || undefined })}
                disabled={isActionPending}
                className="px-4 py-2 rounded text-xs font-mono font-bold transition-all hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
                style={{ background: "rgba(201,168,76,0.1)", color: "var(--accent-gold)", border: "1px solid rgba(201,168,76,0.2)" }}
              >
                <RotateCcw size={12} /> 退回修改
              </button>
              <button
                onClick={() =>
                  updateProgressMutation.mutate({
                    id: taskIdNum,
                    progress: task.progress,
                    status: "failed",
                    lifecycleStatus: "failed",
                    error: reviewComment || undefined,
                  })
                }
                disabled={isActionPending}
                className="px-4 py-2 rounded text-xs font-mono font-bold transition-all hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
                style={{ background: "rgba(194,58,48,0.1)", color: "var(--accent-red)", border: "1px solid rgba(194,58,48,0.2)" }}
              >
                <XCircle size={12} /> 拒绝
              </button>
            </div>
          </div>
        )}

        {/* Review History */}
        {task.threadMessages && task.threadMessages.some((m) =>
          m.eventType === "system" && (
            m.content?.includes("Approved") ||
            m.content?.includes("Rejected") ||
            m.content?.includes("Changes requested") ||
            m.content?.includes("submitted") ||
            (m.metadata && typeof m.metadata === "object" && (m.metadata as any).action)
          )
        ) && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-3">
              <span className="section-label">审批历史</span>
              <div className="flex-1 h-px" style={{ background: "var(--border-default)" }} />
            </div>
            <div className="space-y-2">
              {task.threadMessages
                .filter((m) =>
                  m.eventType === "system" && (
                    m.content?.includes("Approved") ||
                    m.content?.includes("Rejected") ||
                    m.content?.includes("Changes requested") ||
                    m.content?.includes("submitted") ||
                    (m.metadata && typeof m.metadata === "object" && ["approve", "reject", "requestChanges", "submit"].includes((m.metadata as any).action))
                  )
                )
                .map((msg) => {
                  const meta = msg.metadata as Record<string, unknown> | null;
                  const action = meta?.action as string | undefined;
                  const reviewerName = msg.fromAgentId
                    ? agents.find((a) => a.id === msg.fromAgentId)?.name || `Agent #${msg.fromAgentId}`
                    : "系统";
                  return (
                    <div key={msg.id} className="p-3 rounded glass-panel flex items-start gap-3">
                      <div className="mt-0.5">
                        {action === "approve" ? (
                          <CheckCircle size={12} style={{ color: "var(--success)" }} />
                        ) : action === "reject" ? (
                          <XCircle size={12} style={{ color: "var(--accent-red)" }} />
                        ) : action === "requestChanges" ? (
                          <RotateCcw size={12} style={{ color: "var(--accent-gold)" }} />
                        ) : (
                          <Shield size={12} style={{ color: "var(--accent-cyan)" }} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-bold" style={{ color: "var(--text-primary)" }}>
                            {action === "approve"
                              ? "审批通过"
                              : action === "reject"
                                ? "退回修改"
                                : action === "requestChanges"
                                  ? "请求修改"
                                  : action === "submit"
                                    ? "提交审批"
                                    : "状态变更"}
                          </span>
                          <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                            by {reviewerName}
                          </span>
                          <span className="text-[10px] font-mono ml-auto" style={{ color: "var(--text-muted)" }}>
                            <Clock size={9} className="inline mr-1" />
                            {fmtTime(msg.createdAt)}
                          </span>
                        </div>
                        {msg.content && (
                          <div className="text-xs" style={{ color: "var(--text-secondary)" }}>
                            {msg.content}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* Description */}
        {task.description && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="section-label">任务描述</span>
              <div className="flex-1 h-px" style={{ background: "var(--border-default)" }} />
            </div>
            <div
              className="p-3 rounded text-xs leading-relaxed whitespace-pre-wrap glass-panel"
              style={{ color: "var(--text-secondary)" }}
            >
              {task.description}
            </div>
          </div>
        )}

        {/* Input / Output */}
        {(task.input || task.output) && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="section-label">输入 / 输出</span>
              <div className="flex-1 h-px" style={{ background: "var(--border-default)" }} />
            </div>
            {task.input && (
              <div className="mb-3">
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                  输入 (Input)
                </div>
                <pre
                  className="p-3 rounded text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto custom-scrollbar glass-panel"
                  style={{
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {formatJson(task.input)}
                </pre>
              </div>
            )}
            {task.output && (
              <div>
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                  输出 (Output)
                </div>
                <pre
                  className="p-3 rounded text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto custom-scrollbar glass-panel"
                  style={{
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {formatJson(task.output)}
                </pre>
              </div>
            )}
          </div>
        )}

        {/* Error */}
        {task.error && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <span className="section-label" style={{ color: "var(--accent-red)" }}>
                错误
              </span>
              <div className="flex-1 h-px" style={{ background: "rgba(194,58,48,0.2)" }} />
            </div>
            <pre
              className="p-3 rounded text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto custom-scrollbar"
              style={{
                background: "var(--accent-glow-red)",
                border: "1px solid rgba(194,58,48,0.2)",
                color: "var(--accent-red)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {task.error}
            </pre>
          </div>
        )}

        {/* Thread Messages */}
        {task.threadMessages && task.threadMessages.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare size={12} style={{ color: "var(--text-muted)" }} />
              <span className="section-label">任务线程</span>
              <div className="flex-1 h-px" style={{ background: "var(--border-default)" }} />
            </div>
            <div className="space-y-2">
              {task.threadMessages.map((msg) => (
                <div
                  key={msg.id}
                  className="p-3 rounded text-xs glass-panel"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="text-[9px] font-mono px-1 py-0.5 rounded"
                        style={{
                          background:
                            msg.eventType === "system"
                              ? "rgba(74,158,255,0.08)"
                              : msg.eventType === "progress"
                                ? "rgba(201,168,76,0.08)"
                                : "rgba(180,200,255,0.04)",
                          color:
                            msg.eventType === "system"
                              ? "var(--accent-cyan)"
                              : msg.eventType === "progress"
                                ? "var(--accent-gold)"
                                : "var(--text-muted)",
                        }}
                      >
                        {msg.eventType}
                      </span>
                      {msg.fromAgentId && (
                        <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                          Agent #{msg.fromAgentId}
                        </span>
                      )}
                    </div>
                    <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                      <Clock size={9} className="inline mr-1" />
                      {fmtTime(msg.createdAt)}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap" style={{ color: "var(--text-secondary)" }}>
                    {msg.content || "—"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Artifacts */}
        {task.artifacts && task.artifacts.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-2">
              <FileText size={12} style={{ color: "var(--text-muted)" }} />
              <span className="section-label">产出物</span>
              <div className="flex-1 h-px" style={{ background: "var(--border-default)" }} />
            </div>
            <div className="grid grid-cols-1 gap-2">
              {task.artifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  className="p-3 rounded flex items-start gap-3 glass-panel"
                >
                  <ChevronRight size={14} className="mt-0.5 flex-shrink-0" style={{ color: "var(--text-muted)" }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold truncate" style={{ color: "var(--text-primary)" }}>
                      {artifact.name || artifact.type}
                    </div>
                    <div className="text-[10px] font-mono mt-0.5" style={{ color: "var(--text-muted)" }}>
                      {artifact.type} · {artifact.mimeType || "—"} · {fmtTime(artifact.createdAt)}
                    </div>
                    {artifact.content && (
                      <div
                        className="text-[10px] font-mono mt-1.5 p-2 rounded max-h-32 overflow-y-auto custom-scrollbar"
                        style={{
                          background: "var(--bg-terminal)",
                          border: "1px solid var(--border-default)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {artifact.content.length > 200
                          ? artifact.content.slice(0, 200) + "..."
                          : artifact.content}
                      </div>
                    )}
                    {artifact.jsonPayload && (
                      <pre
                        className="text-[10px] font-mono mt-1.5 p-2 rounded max-h-32 overflow-y-auto custom-scrollbar"
                        style={{
                          background: "var(--bg-terminal)",
                          border: "1px solid var(--border-default)",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {JSON.stringify(artifact.jsonPayload, null, 2)}
                      </pre>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
