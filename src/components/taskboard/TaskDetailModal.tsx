import { useState, useMemo } from "react";
import { trpc } from "@/providers/trpc";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  X,
  Target,
  User,
  Clock,
  MessageSquare,
  FileText,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import type { Task, TaskDetail, Agent, BoardStatus } from "./types";
import {
  BOARD_STATUS_CONFIG,
  PRIORITY_COLORS,
  PRIORITY_LABELS,
  STATUS_ACTIONS,
  fmtTime,
} from "./types";

interface TaskDetailModalProps {
  task: TaskDetail | null;
  agents: Agent[];
  allTasks: Task[];
  open: boolean;
  onClose: () => void;
}

export function TaskDetailModal({
  task,
  agents,
  allTasks,
  open,
  onClose,
}: TaskDetailModalProps) {
  const [blockReason, setBlockReason] = useState("");
  const [showBlockInput, setShowBlockInput] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actingAgentId, setActingAgentId] = useState<number | null>(null);

  const utils = trpc.useUtils();

  const assignee = useMemo(
    () => agents.find((a) => a.id === task?.agentId),
    [agents, task?.agentId]
  );

  const reviewer = useMemo(
    () => agents.find((a) => a.id === task?.reviewerId),
    [agents, task?.reviewerId]
  );

  const subtasks = useMemo(
    () => allTasks.filter((t) => t.parentTaskId === task?.id),
    [allTasks, task?.id]
  );

  const labels = useMemo(() => task?.boardLabels || [], [task?.boardLabels]);

  const currentStatus = (task?.boardStatus || "triage") as BoardStatus;
  const statusConfig = BOARD_STATUS_CONFIG[currentStatus];
  const actions = STATUS_ACTIONS[currentStatus] || [];

  const updateStatusMutation = trpc.taskboard.updateStatus.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.taskboard.get.invalidate({ id: task?.id ?? 0 });
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
  });

  const claimMutation = trpc.taskboard.claim.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.taskboard.get.invalidate({ id: task?.id ?? 0 });
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
  });

  const submitMutation = trpc.taskboard.submit.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.taskboard.get.invalidate({ id: task?.id ?? 0 });
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
  });

  const approveMutation = trpc.taskboard.approve.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.taskboard.get.invalidate({ id: task?.id ?? 0 });
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
  });

  const rejectMutation = trpc.taskboard.reject.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.taskboard.get.invalidate({ id: task?.id ?? 0 });
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
  });

  const blockMutation = trpc.taskboard.block.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.taskboard.get.invalidate({ id: task?.id ?? 0 });
      setBlockReason("");
      setShowBlockInput(false);
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
  });

  const unblockMutation = trpc.taskboard.unblock.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.taskboard.get.invalidate({ id: task?.id ?? 0 });
      setActionError(null);
    },
    onError: (err) => setActionError(err.message),
  });

  const getEffectiveAgentId = (): number | null => {
    if (actingAgentId) return actingAgentId;
    if (task?.agentId) return task.agentId;
    const first = agents.find((a) => a.status === "online");
    return first?.id ?? agents[0]?.id ?? null;
  };

  const handleAction = (action: (typeof actions)[number]) => {
    if (!task) return;
    const agentId = getEffectiveAgentId();
    if (!agentId) {
      setActionError("无可用的 Agent，请先创建 Agent");
      return;
    }
    setActionError(null);

    if (action.api === "block") {
      setShowBlockInput(true);
      return;
    }

    if (action.api === "claim") {
      claimMutation.mutate({ taskId: task.id, agentId });
      return;
    }
    if (action.api === "submit") {
      submitMutation.mutate({ taskId: task.id, agentId });
      return;
    }
    if (action.api === "approve") {
      approveMutation.mutate({ taskId: task.id, agentId });
      return;
    }
    if (action.api === "reject") {
      rejectMutation.mutate({ taskId: task.id, agentId });
      return;
    }
    if (action.api === "unblock") {
      unblockMutation.mutate({ taskId: task.id, agentId });
      return;
    }
    if (action.api === "updateStatus") {
      updateStatusMutation.mutate({ taskId: task.id, agentId, boardStatus: action.to });
      return;
    }
  };

  const handleBlockSubmit = () => {
    if (!task || !blockReason.trim()) return;
    const agentId = getEffectiveAgentId();
    if (!agentId) {
      setActionError("无可用的 Agent，请先创建 Agent");
      return;
    }
    blockMutation.mutate({ taskId: task.id, agentId, reason: blockReason.trim() });
  };

  const isActionPending =
    updateStatusMutation.isPending ||
    claimMutation.isPending ||
    submitMutation.isPending ||
    approveMutation.isPending ||
    rejectMutation.isPending ||
    blockMutation.isPending ||
    unblockMutation.isPending;

  if (!open || !task) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-3xl max-h-[90vh] overflow-hidden p-0 gap-0"
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          boxShadow: "0 0 80px rgba(0,0,0,0.5), 0 0 20px rgba(74,158,255,0.08)",
        }}
      >
        {/* Header */}
        <DialogHeader className="px-5 py-3 flex-shrink-0" style={{ borderBottom: "1px solid var(--border-default)" }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <Target size={18} style={{ color: statusConfig.color }} />
              <div className="min-w-0">
                <DialogTitle
                  className="text-sm font-bold truncate"
                  style={{ color: "var(--text-primary)" }}
                >
                  {task.name}
                </DialogTitle>
                <div className="flex items-center gap-2 mt-1">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1"
                    style={{
                      background: statusConfig.bgColor,
                      color: statusConfig.color,
                      border: `1px solid ${statusConfig.borderColor}`,
                    }}
                  >
                    {statusConfig.label}
                  </span>
                  <span
                    className="text-[10px] font-mono"
                    style={{ color: "var(--accent-gold)" }}
                  >
                    {task.taskId}
                  </span>
                  <span
                    className="text-[10px] font-mono"
                    style={{ color: "var(--text-muted)" }}
                  >
                    P{task.priority}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col overflow-hidden" style={{ maxHeight: "calc(90vh - 60px)" }}>
          <ScrollArea className="flex-1 px-5 py-4">
            {/* Actions */}
            {actions.length > 0 && (
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                    操作
                  </span>
                  <Separator className="flex-1" style={{ background: "var(--border-default)" }} />
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                  {actions.map((action) => (
                    <button
                      key={`${action.api}-${action.to}`}
                      onClick={() => handleAction(action)}
                      disabled={isActionPending}
                      className="text-[11px] px-3 py-1.5 rounded font-bold transition-all hover:brightness-110 disabled:opacity-50"
                      style={{
                        background:
                          action.api === "claim"
                            ? "rgba(74,158,255,0.1)"
                            : action.api === "approve"
                              ? "rgba(76,175,125,0.1)"
                              : action.api === "reject"
                                ? "rgba(194,58,48,0.1)"
                                : action.api === "block"
                                  ? "rgba(194,58,48,0.08)"
                                  : "rgba(180,200,255,0.04)",
                        color:
                          action.api === "claim"
                            ? "var(--accent-cyan)"
                            : action.api === "approve"
                              ? "var(--success)"
                              : action.api === "reject" || action.api === "block"
                                ? "var(--accent-red)"
                                : "var(--text-secondary)",
                        border: `1px solid ${
                          action.api === "claim"
                            ? "rgba(74,158,255,0.2)"
                            : action.api === "approve"
                              ? "rgba(76,175,125,0.2)"
                              : action.api === "reject" || action.api === "block"
                                ? "rgba(194,58,48,0.2)"
                                : "var(--border-default)"
                        }`,
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
                {showBlockInput && (
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      type="text"
                      value={blockReason}
                      onChange={(e) => setBlockReason(e.target.value)}
                      placeholder="输入阻塞原因..."
                      className="flex-1 px-3 py-1.5 rounded text-xs outline-none"
                      style={{
                        background: "rgba(0,0,0,0.2)",
                        border: "1px solid var(--border-default)",
                        color: "var(--text-primary)",
                      }}
                      onKeyDown={(e) => e.key === "Enter" && handleBlockSubmit()}
                    />
                    <button
                      onClick={handleBlockSubmit}
                      disabled={!blockReason.trim() || blockMutation.isPending}
                      className="text-[11px] px-3 py-1.5 rounded font-bold transition-all hover:brightness-110 disabled:opacity-50"
                      style={{
                        background: "var(--accent-red)",
                        color: "#fff",
                      }}
                    >
                      确认阻塞
                    </button>
                    <button
                      onClick={() => {
                        setShowBlockInput(false);
                        setBlockReason("");
                      }}
                      className="text-[11px] px-3 py-1.5 rounded font-mono"
                      style={{
                        color: "var(--text-muted)",
                        border: "1px solid var(--border-default)",
                      }}
                    >
                      取消
                    </button>
                  </div>
                )}
                {actionError && (
                  <div
                    className="text-[11px] px-2 py-1.5 rounded font-mono"
                    style={{ background: "var(--accent-glow-red)", color: "var(--accent-red)" }}
                  >
                    <AlertTriangle size={10} className="inline mr-1" />
                    {actionError}
                  </div>
                )}
                {/* Agent selector when needed */}
                {(!task.agentId || task.boardStatus === "ready" || task.boardStatus === "blocked") && (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                      执行 Agent:
                    </span>
                    <select
                      value={actingAgentId ?? task.agentId ?? ""}
                      onChange={(e) => setActingAgentId(e.target.value ? Number(e.target.value) : null)}
                      className="px-2 py-1 rounded text-[10px] outline-none font-mono"
                      style={{
                        background: "rgba(0,0,0,0.2)",
                        border: "1px solid var(--border-default)",
                        color: "var(--text-primary)",
                      }}
                    >
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          #{a.id} {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            {/* Basic Info */}
            <div className="mb-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                  基础信息
                </span>
                <Separator className="flex-1" style={{ background: "var(--border-default)" }} />
              </div>
              <div
                className="grid grid-cols-2 gap-2 text-xs font-mono p-3 rounded"
                style={{ background: "var(--bg-card)", border: "1px solid var(--border-default)" }}
              >
                <div>
                  <span style={{ color: "var(--text-muted)" }}>优先级:</span>{" "}
                  <span style={{ color: PRIORITY_COLORS[task.priority] || PRIORITY_COLORS[0] }}>
                    P{task.priority} {PRIORITY_LABELS[task.priority] || "普通"}
                  </span>
                </div>
                <div>
                  <span style={{ color: "var(--text-muted)" }}>状态:</span>{" "}
                  <span style={{ color: statusConfig.color }}>{statusConfig.label}</span>
                </div>
                <div>
                  <span style={{ color: "var(--text-muted)" }}>进度:</span>{" "}
                  <span style={{ color: "var(--text-secondary)" }}>{task.progress}%</span>
                </div>
                <div>
                  <span style={{ color: "var(--text-muted)" }}>重试:</span>{" "}
                  <span style={{ color: "var(--text-secondary)" }}>
                    {task.retryCount}/{task.maxRetries}
                  </span>
                </div>
                <div className="col-span-2">
                  <span style={{ color: "var(--text-muted)" }}>创建:</span>{" "}
                  <span style={{ color: "var(--text-secondary)" }}>{fmtTime(task.createdAt)}</span>
                </div>
                <div className="col-span-2">
                  <span style={{ color: "var(--text-muted)" }}>更新:</span>{" "}
                  <span style={{ color: "var(--text-secondary)" }}>{fmtTime(task.updatedAt)}</span>
                </div>
                {labels.length > 0 && (
                  <div className="col-span-2 flex items-center gap-1.5 flex-wrap">
                    <span style={{ color: "var(--text-muted)" }}>标签:</span>
                    {labels.map((l) => (
                      <span
                        key={l}
                        className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: "rgba(201,168,76,0.08)",
                          color: "var(--accent-gold)",
                          border: "1px solid rgba(201,168,76,0.15)",
                        }}
                      >
                        {l}
                      </span>
                    ))}
                  </div>
                )}
                {task.boardNotes && (
                  <div className="col-span-2">
                    <span style={{ color: "var(--text-muted)" }}>备注:</span>{" "}
                    <span style={{ color: "var(--text-secondary)" }}>{task.boardNotes}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Description */}
            {task.description && (
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                    描述
                  </span>
                  <Separator className="flex-1" style={{ background: "var(--border-default)" }} />
                </div>
                <div
                  className="p-3 rounded text-xs leading-relaxed whitespace-pre-wrap"
                  style={{
                    background: "var(--bg-card)",
                    border: "1px solid var(--border-default)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {task.description}
                </div>
              </div>
            )}

            {/* Assignee */}
            <div className="mb-5">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                  指派
                </span>
                <Separator className="flex-1" style={{ background: "var(--border-default)" }} />
              </div>
              <div
                className="p-3 rounded flex items-center gap-3"
                style={{
                  background: "var(--bg-card)",
                  border: "1px solid var(--border-default)",
                }}
              >
                {assignee ? (
                  <>
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{
                        background:
                          assignee.status === "online"
                            ? "var(--success)"
                            : assignee.status === "busy"
                              ? "var(--warning)"
                              : "var(--text-muted)",
                      }}
                    />
                    <div>
                      <span className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
                        {assignee.name}
                      </span>
                      <span className="text-[10px] font-mono ml-2" style={{ color: "var(--text-muted)" }}>
                        {assignee.agentId}
                      </span>
                    </div>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded font-mono ml-auto"
                      style={{
                        background:
                          assignee.status === "online"
                            ? "rgba(76,175,125,0.1)"
                            : assignee.status === "busy"
                              ? "var(--accent-glow-gold)"
                              : "rgba(180,200,255,0.03)",
                        color:
                          assignee.status === "online"
                            ? "var(--success)"
                            : assignee.status === "busy"
                              ? "var(--warning)"
                              : "var(--text-muted)",
                      }}
                    >
                      {assignee.status}
                    </span>
                  </>
                ) : (
                  <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                    <User size={12} className="inline mr-1" />
                    未指派
                  </span>
                )}
              </div>
              {reviewer && (
                <div className="mt-2 flex items-center gap-2 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                  <span>审核者:</span>
                  <span style={{ color: "var(--text-secondary)" }}>{reviewer.name}</span>
                  {task.reviewResult && (
                    <span
                      className="px-1 py-0.5 rounded"
                      style={{
                        background:
                          task.reviewResult === "approved"
                            ? "rgba(76,175,125,0.1)"
                            : "rgba(194,58,48,0.1)",
                        color:
                          task.reviewResult === "approved"
                            ? "var(--success)"
                            : "var(--accent-red)",
                      }}
                    >
                      {task.reviewResult}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Input / Output */}
            {(task.input || task.output) && (
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                    输入 / 输出
                  </span>
                  <Separator className="flex-1" style={{ background: "var(--border-default)" }} />
                </div>
                {task.input && (
                  <div className="mb-2">
                    <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                      输入
                    </div>
                    <pre
                      className="p-3 rounded text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto custom-scrollbar"
                      style={{
                        background: "var(--bg-terminal)",
                        border: "1px solid var(--border-default)",
                        color: "var(--text-secondary)",
                        fontFamily: "monospace",
                      }}
                    >
                      {task.input}
                    </pre>
                  </div>
                )}
                {task.output && (
                  <div>
                    <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                      输出
                    </div>
                    <pre
                      className="p-3 rounded text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto custom-scrollbar"
                      style={{
                        background: "var(--bg-terminal)",
                        border: "1px solid var(--border-default)",
                        color: "var(--text-secondary)",
                        fontFamily: "monospace",
                      }}
                    >
                      {task.output}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {task.error && (
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-mono" style={{ color: "var(--accent-red)" }}>
                    错误
                  </span>
                  <Separator className="flex-1" style={{ background: "rgba(194,58,48,0.2)" }} />
                </div>
                <pre
                  className="p-3 rounded text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto custom-scrollbar"
                  style={{
                    background: "var(--accent-glow-red)",
                    border: "1px solid rgba(194,58,48,0.2)",
                    color: "var(--accent-red)",
                    fontFamily: "monospace",
                  }}
                >
                  {task.error}
                </pre>
              </div>
            )}

            {/* Task Thread Messages */}
            {task.threadMessages && task.threadMessages.length > 0 && (
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <MessageSquare size={12} style={{ color: "var(--text-muted)" }} />
                  <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                    任务线程
                  </span>
                  <Separator className="flex-1" style={{ background: "var(--border-default)" }} />
                </div>
                <div className="space-y-2">
                  {task.threadMessages.map((msg) => (
                    <div
                      key={msg.id}
                      className="p-2.5 rounded text-xs"
                      style={{
                        background: "var(--bg-card)",
                        border: "1px solid var(--border-default)",
                      }}
                    >
                      <div className="flex items-center justify-between mb-1">
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
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <FileText size={12} style={{ color: "var(--text-muted)" }} />
                  <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                    Artifacts
                  </span>
                  <Separator className="flex-1" style={{ background: "var(--border-default)" }} />
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {task.artifacts.map((artifact) => (
                    <div
                      key={artifact.id}
                      className="p-2.5 rounded flex items-center gap-2"
                      style={{
                        background: "var(--bg-card)",
                        border: "1px solid var(--border-default)",
                      }}
                    >
                      <ChevronRight size={12} style={{ color: "var(--text-muted)" }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-bold truncate" style={{ color: "var(--text-primary)" }}>
                          {artifact.name || artifact.type}
                        </div>
                        <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                          {artifact.type} · {artifact.mimeType || "—"} · {fmtTime(artifact.createdAt)}
                        </div>
                      </div>
                      {artifact.content && (
                        <div className="text-[10px] font-mono max-h-20 overflow-y-auto custom-scrollbar flex-1 text-right" style={{ color: "var(--text-secondary)" }}>
                          {artifact.content.length > 60
                            ? artifact.content.slice(0, 60) + "..."
                            : artifact.content}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Subtasks */}
            {subtasks.length > 0 && (
              <div className="mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                    子任务
                  </span>
                  <Separator className="flex-1" style={{ background: "var(--border-default)" }} />
                </div>
                <div className="space-y-2">
                  {subtasks.map((st) => {
                    const sc = BOARD_STATUS_CONFIG[st.boardStatus as BoardStatus] || BOARD_STATUS_CONFIG.triage;
                    return (
                      <div
                        key={st.id}
                        className="p-2.5 rounded flex items-center gap-2"
                        style={{
                          background: "var(--bg-card)",
                          border: "1px solid var(--border-default)",
                        }}
                      >
                        <span
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ background: sc.color }}
                        />
                        <span className="text-xs font-bold truncate flex-1" style={{ color: "var(--text-primary)" }}>
                          {st.name}
                        </span>
                        <span
                          className="text-[9px] font-mono px-1 py-0.5 rounded"
                          style={{ background: sc.bgColor, color: sc.color, border: `1px solid ${sc.borderColor}` }}
                        >
                          {sc.label}
                        </span>
                        <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                          {st.taskId}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
