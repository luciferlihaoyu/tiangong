/**
 * 任务详情抽屉 — 自 src/pages/TaskCenter.tsx 逐段搬迁（原 L351-908），行为保持。
 * 注：taskMutation（taskboard.progress）在原文件中即无调用点，逐字保留以维持行为。
 */
import { useState } from "react";
import { TASK_STATUS_CONFIG as STATUS_CONFIG } from "@/lib/taskStatus";
import { fmtTime } from "@/lib/format";
import { trpc } from "@/providers/trpc";
import { AGENT_STATUS_COLORS, AGENT_STATUS_LABELS } from "./constants";
import { Bot, Clock, FileText, Target, X } from "lucide-react";
import type { Agent, Conversation, Task } from "./types";

/** 任务详情抽屉 */
export function TaskDetailDrawer({
  task,
  agents,
  conversations,
  open,
  onClose,
}: {
  task: Task;
  agents: Agent[];
  conversations: Conversation[];
  open: boolean;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const agent = agents.find((a) => a.id === task.agentId);
  const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;

  // 加载完整任务详情（含 threadMessages、artifacts、timeLine）
  const detailQuery = trpc.taskboard.get.useQuery(
    { id: task.id },
    { enabled: open, retry: 1, staleTime: 10000 }
  );
  const detailData = detailQuery.data as TaskDetailData | null | undefined;
  const threadMessages = (detailData?.threadMessages || []) as ThreadMessageData[];
  const artifacts = (detailData?.artifacts || []) as TaskArtifactData[];

  type ThreadMessageData = {
    id: number;
    taskId: number;
    fromAgentId: number | null;
    toAgentId: number | null;
    eventType: string;
    content: string | null;
    createdAt: string;
  };

  type TaskArtifactData = {
    id: number;
    taskId: number;
    agentId: number | null;
    type: string;
    name: string | null;
    content: string | null;
    createdAt: string;
  };

  type TaskDetailData = {
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
    threadMessages: ThreadMessageData[];
    artifacts: TaskArtifactData[];
  };

  // 状态更新 mutation
  const statusMutation = trpc.orch.updateStatus.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.orch.getOverview.invalidate();
    },
  });
  const taskMutation = trpc.taskboard.progress.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
    },
  });

  // 写入记事板
  const [selectedConv, setSelectedConv] = useState<number | null>(null);
  const [writingToBoard, setWritingToBoard] = useState(false);
  const [boardError, setBoardError] = useState<string | null>(null);
  const convMutation = trpc.conversation.appendTaskOutput.useMutation({
    onSuccess: () => {
      setWritingToBoard(false);
      setBoardError(null);
      utils.conversation.list.invalidate();
      utils.conversation.stats.invalidate();
    },
    onError: (err) => {
      setWritingToBoard(false);
      setBoardError("写入记事板失败：" + err.message);
    },
  });

  const handleStatusChange = (newStatus: "queued" | "running" | "done" | "failed") => {
    statusMutation.mutate({ id: task.id, status: newStatus });
  };

  const handleWriteToBoard = () => {
    if (!selectedConv || !agent || !task.output) return;
    setWritingToBoard(true);
    setBoardError(null);
    convMutation.mutate({
      conversationId: selectedConv,
      fromAgentId: agent.id,
      taskName: task.name,
      taskId: task.taskId,
      output: task.output,
    });
  };

  // Word wrapping for pre blocks
  const renderText = (text: string | null) => {
    if (!text) return "—";
    return text.replace(/</g, "&lt;");
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
      style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] overflow-hidden rounded-lg flex flex-col"
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          boxShadow: "0 0 80px rgba(0,0,0,0.5), 0 0 20px rgba(74,158,255,0.08)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <Target size={18} style={{ color: sc.color }} />
            <div className="min-w-0">
              <h2 className="text-sm font-bold truncate" style={{ color: "var(--text-primary)" }}>
                {task.name}
              </h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1"
                  style={{ background: sc.bg, color: sc.color }}
                >
                  {sc.icon} {sc.label}
                </span>
                <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>
                  {task.taskId}
                </span>
                <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                  P{task.priority} · 重试 {task.retryCount}/{task.maxRetries}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(180,200,255,0.1)]"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
          {/* Quick Actions */}
          <div className="flex flex-wrap gap-2 mb-5">
            <span className="text-[10px] font-mono mr-1 self-center" style={{ color: "var(--text-muted)" }}>
              操作:
            </span>
            {task.status === "pending" && (
              <button
                onClick={() => handleStatusChange("queued")}
                className="text-[11px] px-3 py-1.5 rounded font-bold transition-colors hover:brightness-110"
                style={{ background: "rgba(74,158,255,0.1)", color: "var(--accent-cyan)", border: "1px solid rgba(74,158,255,0.2)" }}
                disabled={statusMutation.isPending}
              >
                ▶ 加入队列
              </button>
            )}
            {(task.status === "pending" || task.status === "queued") && (
              <button
                onClick={() => handleStatusChange("running")}
                className="text-[11px] px-3 py-1.5 rounded font-bold transition-colors hover:brightness-110"
                style={{ background: "var(--accent-glow-gold)", color: "var(--accent-gold)", border: "1px solid rgba(201,168,76,0.2)" }}
                disabled={statusMutation.isPending}
              >
                ⚡ 开始执行
              </button>
            )}
            {task.status === "running" && (
              <button
                onClick={() => handleStatusChange("done")}
                className="text-[11px] px-3 py-1.5 rounded font-bold transition-colors hover:brightness-110"
                style={{ background: "rgba(76,175,125,0.1)", color: "var(--success)", border: "1px solid rgba(76,175,125,0.2)" }}
                disabled={statusMutation.isPending}
              >
                ✓ 标记完成
              </button>
            )}
            {(task.status === "running" || task.status === "queued") && (
              <button
                onClick={() => handleStatusChange("failed")}
                className="text-[11px] px-3 py-1.5 rounded font-bold transition-colors hover:brightness-110"
                style={{ background: "var(--accent-glow-red)", color: "var(--accent-red)", border: "1px solid rgba(194,58,48,0.2)" }}
                disabled={statusMutation.isPending}
              >
                ✕ 标记失败
              </button>
            )}
            {task.status === "failed" && (
              <button
                onClick={() => handleStatusChange("queued")}
                className="text-[11px] px-3 py-1.5 rounded font-bold transition-colors hover:brightness-110"
                style={{ background: "rgba(74,158,255,0.1)", color: "var(--accent-cyan)", border: "1px solid rgba(74,158,255,0.2)" }}
                disabled={statusMutation.isPending}
              >
                ↻ 重新排队
              </button>
            )}
          </div>

          {/* Agent */}
          <div className="mb-4">
            <div className="section-label mb-2">执行 Agent · EXECUTOR</div>
            {agent ? (
              <div className="glass-panel p-3 sci-border flex items-center gap-3">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ background: AGENT_STATUS_COLORS[agent.status] || "var(--text-muted)" }}
                />
                <div>
                  <span className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
                    {agent.name}
                  </span>
                  <span className="text-[10px] font-mono ml-2" style={{ color: "var(--text-muted)" }}>
                    {agent.agentId}
                  </span>
                </div>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-mono ml-auto"
                  style={{
                    background:
                      agent.status === "online"
                        ? "rgba(76,175,125,0.1)"
                        : agent.status === "busy"
                          ? "var(--accent-glow-gold)"
                          : "rgba(180,200,255,0.03)",
                    color: AGENT_STATUS_COLORS[agent.status],
                  }}
                >
                  {AGENT_STATUS_LABELS[agent.status]}
                </span>
              </div>
            ) : (
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                未指派
              </div>
            )}
          </div>

          {/* Description */}
          {task.description && (
            <div className="mb-4">
              <div className="section-label mb-2">描述 · DESCRIPTION</div>
              <div
                className="terminal-panel p-3 text-xs leading-relaxed"
                style={{ color: "var(--text-secondary)" }}
              >
                <div
                  className="prose-custom whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{
                    __html: renderText(task.description).replace(/\n/g, "<br/>"),
                  }}
                />
              </div>
            </div>
          )}

          {/* Input */}
          {task.input && (
            <div className="mb-4">
              <div className="section-label mb-2">输入 · INPUT</div>
              <pre
                className="terminal-panel p-3 text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto custom-scrollbar"
                style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}
              >
                {task.input}
              </pre>
            </div>
          )}

          {/* Output */}
          {task.output && (
            <div className="mb-4">
              <div className="section-label mb-2">输出 · OUTPUT</div>
              <pre
                className="terminal-panel p-3 text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto custom-scrollbar"
                style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}
              >
                {task.output}
              </pre>
            </div>
          )}

          {/* Error */}
          {task.error && (
            <div className="mb-4">
              <div
                className="section-label mb-2"
                style={{ color: "var(--accent-red)" }}
              >
                错误 · ERROR
              </div>
              <pre
                className="p-3 text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto custom-scrollbar rounded"
                style={{
                  background: "var(--accent-glow-red)",
                  color: "var(--accent-red)",
                  fontFamily: "monospace",
                  border: "1px solid rgba(194,58,48,0.2)",
                }}
              >
                {task.error}
              </pre>
            </div>
          )}

          {/* P5: Runner execution info */}
          {(task.status === "done" || task.status === "failed" || task.status === "running") && (
            <div className="mb-4">
              <div className="section-label mb-2">
                <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <Bot size={11} /> RUNNER · AUTO EXECUTION
                </span>
              </div>
              <div
                className="glass-panel p-3 sci-border text-xs font-mono"
                style={{ color: "var(--text-muted)" }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-1.5 h-1.5 rounded-full" style={{
                    background: task.status === "running" ? "var(--warning)" :
                               task.status === "done" ? "var(--success)" : "var(--accent-red)"
                  }} />
                  <span style={{ color: "var(--text-secondary)" }}>
                    {task.status === "running" ? "Runner picked up this task and is executing it" :
                     task.status === "done" ? "Runner completed this task automatically" :
                     "Runner attempted this task but it failed"}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Write to board — 写入任务记事板 */}
          {task.output && task.status === "done" && (
            <div className="mb-4">
              <div className="section-label mb-2">写入记事板 · APPEND TO MISSION LOG</div>
              {conversations.length === 0 ? (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  暂无记事板，请先在
                  <span style={{ color: "var(--accent-cyan)" }}>任务记事板</span>
                  创建
                </div>
              ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  <select
                    value={selectedConv ?? ""}
                    onChange={(e) => setSelectedConv(e.target.value ? Number(e.target.value) : null)}
                    className="px-3 py-2 rounded text-xs outline-none"
                    style={{
                      background: "rgba(0,0,0,0.2)",
                      border: "1px solid var(--border-default)",
                      color: "var(--text-primary)",
                    }}
                  >
                    <option value="">— 选择记事板 —</option>
                    {conversations.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleWriteToBoard}
                    disabled={!selectedConv || writingToBoard}
                    className="text-[11px] px-4 py-2 rounded font-bold transition-all hover:brightness-110 disabled:opacity-50"
                    style={{
                      background: "var(--accent-cyan)",
                      color: "#fff",
                      boxShadow: "0 0 12px rgba(74,158,255,0.2)",
                    }}
                  >
                    {writingToBoard ? "写入中..." : "写入记事板"}
                  </button>
                  {convMutation.isSuccess && (
                    <span className="text-[11px]" style={{ color: "var(--success)" }}>
                      ✓ 已写入
                    </span>
                  )}
                  {boardError && (
                    <div
                      className="w-full px-3 py-2 rounded text-xs cursor-pointer"
                      style={{
                        background: "rgba(220,38,38,0.12)",
                        border: "1px solid rgba(220,38,38,0.35)",
                        color: "#fca5a5",
                      }}
                      onClick={() => setBoardError(null)}
                    >
                      {boardError}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Meta */}
          <div className="section-label mb-2">元数据 · META</div>
          <div
            className="glass-panel p-3 sci-border text-xs font-mono grid grid-cols-2 gap-2"
            style={{ color: "var(--text-muted)" }}
          >
            <div>
              <span style={{ color: "var(--text-secondary)" }}>状态:</span> {task.status}
            </div>
            <div>
              <span style={{ color: "var(--text-secondary)" }}>生命周期:</span> {task.lifecycleStatus || "—"}
            </div>
            <div>
              <span style={{ color: "var(--text-secondary)" }}>优先级:</span> P{task.priority}
            </div>
            <div>
              <span style={{ color: "var(--text-secondary)" }}>进度:</span> {task.progress}%
            </div>
            <div>
              <span style={{ color: "var(--text-secondary)" }}>重试:</span> {task.retryCount}/{task.maxRetries}
            </div>
            <div className="col-span-2">
              <span style={{ color: "var(--text-secondary)" }}>创建:</span> {fmtTime(task.createdAt)}
            </div>
            <div className="col-span-2">
              <span style={{ color: "var(--text-secondary)" }}>更新:</span> {fmtTime(task.updatedAt)}
            </div>
          </div>

          {/* 生命周期时间线 */}
          {threadMessages.length > 0 && (
            <div className="mt-4">
              <div className="section-label mb-2">
                <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <Clock size={11} /> 生命周期 · TIMELINE
                </span>
              </div>
              <div className="glass-panel p-3 sci-border">
                <div className="relative">
                  {threadMessages.map((msg, i) => (
                    <div key={msg.id} className="flex gap-3 pb-2 last:pb-0">
                      <div className="flex flex-col items-center">
                        <div
                          className="w-2 h-2 rounded-full flex-shrink-0 mt-1"
                          style={{
                            background:
                              msg.eventType === "submitted" || msg.eventType === "approved"
                                ? "var(--success)"
                                : msg.eventType === "failed"
                                  ? "var(--accent-red)"
                                  : "var(--accent-cyan)",
                          }}
                        />
                        {i < threadMessages.length - 1 && (
                          <div className="w-px h-full" style={{ background: "var(--border-default)" }} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0 pb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] font-bold" style={{ color: "var(--text-primary)" }}>
                            {msg.eventType}
                          </span>
                          <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                            {fmtTime(msg.createdAt)}
                          </span>
                          {msg.fromAgentId && (
                            <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                              Agent#{msg.fromAgentId}
                            </span>
                          )}
                        </div>
                        {msg.content && (
                          <div
                            className="text-[10px] mt-0.5 leading-relaxed whitespace-pre-wrap"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            {msg.content.length > 200 ? msg.content.slice(0, 200) + "..." : msg.content}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 工件列表 */}
          {artifacts.length > 0 && (
            <div className="mt-4">
              <div className="section-label mb-2">
                <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                  <FileText size={11} /> 工件 · ARTIFACTS
                </span>
              </div>
              <div className="glass-panel p-3 sci-border text-xs font-mono space-y-2">
                {artifacts.map((art) => (
                  <div key={art.id} className="p-2 rounded" style={{ background: "var(--bg-tertiary)" }}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold" style={{ color: "var(--text-primary)" }}>
                        {art.name || `Artifact#${art.id}`}
                      </span>
                      <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                        {art.type}
                      </span>
                      <span className="text-[9px]" style={{ color: "var(--text-muted)" }}>
                        {fmtTime(art.createdAt)}
                      </span>
                    </div>
                    {art.content && (
                      <div
                        className="text-[9px] leading-relaxed whitespace-pre-wrap max-h-24 overflow-y-auto"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {art.content.length > 300 ? art.content.slice(0, 300) + "..." : art.content}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
