/**
 * 天宫 任务指挥中心 — TaskCenter (P4)
 *
 * 整合执行引擎、任务创建/查询/状态更新、任务记事板
 * 页面路由 /missions 已由 MissionLog 占用，本文件作为新页面
 * 同时创建独立的 /task-center 路由入口
 */
import { useState, useCallback, useEffect } from "react";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";
import {
  Target,
  Plus,
  X,
  Eye,
  Trash2,
  MessageSquare,
  Clock,
  Search,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  Play,
  Pause,
  Zap,
} from "lucide-react";

// ═══════════════════════ Types ═══════════════════════

interface Agent {
  id: number;
  agentId: string;
  name: string;
  source: string;
  model: string | null;
  role: string | null;
  capabilities: string | null;
  status: "online" | "busy" | "idle";
  departmentId: number | null;
}

interface Task {
  id: number;
  taskId: string;
  name: string;
  agentId: number | null;
  status: "pending" | "queued" | "running" | "done" | "failed";
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
}

interface Conversation {
  id: number;
  title: string;
  status: string;
}

// ═══════════════════════ Constants ═══════════════════════

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  pending: { label: "待处理", color: "var(--text-muted)", bg: "rgba(180,200,255,0.03)", icon: <Clock size={12} /> },
  queued: { label: "已排队", color: "var(--accent-cyan)", bg: "rgba(74,158,255,0.08)", icon: <Pause size={12} /> },
  running: { label: "执行中", color: "var(--warning)", bg: "var(--accent-glow-gold)", icon: <Play size={12} /> },
  done: { label: "已完成", color: "var(--success)", bg: "rgba(76,175,125,0.08)", icon: <CheckCircle size={12} /> },
  failed: { label: "失败", color: "var(--accent-red)", bg: "var(--accent-glow-red)", icon: <AlertTriangle size={12} /> },
};

const PRIORITY_LABELS: Record<number, string> = {
  0: "普通",
  1: "低",
  2: "中",
  3: "高",
  4: "紧急",
  5: "最高",
};

const AGENT_STATUS_COLORS: Record<string, string> = {
  online: "var(--success)",
  busy: "var(--warning)",
  idle: "var(--text-muted)",
};

const AGENT_STATUS_LABELS: Record<string, string> = {
  online: "在线",
  busy: "忙碌",
  idle: "空闲",
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ═══════════════════════ Components ═══════════════════════

/** 顶部统计卡片行 */
function StatsRow({ tasks }: { tasks: Task[] }) {
  const counts = {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    queued: tasks.filter((t) => t.status === "queued").length,
    running: tasks.filter((t) => t.status === "running").length,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
  };

  const cards = [
    { key: "total", label: "任务总数", count: counts.total, color: "var(--text-primary)", bg: "rgba(255,255,255,0.02)", icon: <Target size={16} /> },
    { key: "running", label: "执行中", count: counts.running, color: "var(--warning)", bg: "var(--accent-glow-gold)", icon: <Zap size={16} /> },
    { key: "queued", label: "排队中", count: counts.queued + counts.pending, color: "var(--accent-cyan)", bg: "rgba(74,158,255,0.08)", icon: <Pause size={16} /> },
    { key: "done", label: "已完成", count: counts.done, color: "var(--success)", bg: "rgba(76,175,125,0.06)", icon: <CheckCircle size={16} /> },
    { key: "failed", label: "失败", count: counts.failed, color: "var(--accent-red)", bg: "var(--accent-glow-red)", icon: <AlertTriangle size={16} /> },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      {cards.map((c) => (
        <div
          key={c.key}
          className="glass-panel p-3 sci-border flex items-center gap-2"
        >
          <div
            className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
            style={{ background: c.bg }}
          >
            <span style={{ color: c.color }}>{c.icon}</span>
          </div>
          <div className="min-w-0">
            <div
              className="text-lg font-bold font-mono"
              style={{ color: c.color }}
            >
              {c.count}
            </div>
            <div
              className="text-[10px] font-mono"
              style={{ color: "var(--text-muted)" }}
            >
              {c.label}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 任务卡片 */
function TaskCard({
  task,
  agents,
  onView,
  onDelete,
}: {
  task: Task;
  agents: Agent[];
  onView: () => void;
  onDelete: () => void;
}) {
  const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const agent = agents.find((a) => a.id === task.agentId);

  return (
    <div className="glass-panel p-4 sci-border transition-all group relative hover:border-[var(--accent-cyan)]/20">
      {/* Hover actions */}
      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
        <button
          onClick={onView}
          className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(100,181,246,0.1)] flex items-center gap-1"
          style={{ color: "var(--accent-cyan)" }}
        >
          <Eye size={12} /> 详情
        </button>
        <button
          onClick={onDelete}
          className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--accent-glow-red)] flex items-center gap-1"
          style={{ color: "var(--accent-red)" }}
        >
          <Trash2 size={12} /> 删除
        </button>
      </div>

      {/* Status + taskId */}
      <div className="flex items-center gap-2 mb-2 pr-20">
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1 flex-shrink-0"
          style={{ background: sc.bg, color: sc.color }}
        >
          {sc.icon} {sc.label}
        </span>
        <span
          className="text-[10px] font-mono"
          style={{ color: "var(--accent-gold)" }}
        >
          {task.taskId}
        </span>
        {task.priority > 0 && (
          <span
            className="text-[10px] px-1 py-0 rounded font-mono"
            style={{ background: "rgba(201, 168, 76, 0.1)", color: "var(--accent-gold)" }}
          >
            P{task.priority}
          </span>
        )}
      </div>

      {/* Title */}
      <h3
        className="text-sm font-bold truncate mb-2"
        style={{ color: "var(--text-primary)" }}
      >
        {task.name}
      </h3>

      {/* Agent */}
      {agent && (
        <div className="flex items-center gap-2 mb-2">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: AGENT_STATUS_COLORS[agent.status] || "var(--text-muted)" }}
          />
          <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
            {agent.name}
          </span>
          <span
            className="text-[9px] font-mono"
            style={{ color: "var(--text-muted)" }}
          >
            {agent.model || agent.source}
          </span>
        </div>
      )}

      {/* Progress bar */}
      <div className="mb-2">
        <div
          className="progress-track"
          style={{ height: "4px" }}
        >
          <div
            className="progress-fill"
            style={{
              width: `${task.progress}%`,
              background:
                task.status === "failed"
                  ? "var(--accent-red)"
                  : task.status === "done"
                    ? "var(--success)"
                    : "var(--accent-cyan)",
            }}
          />
        </div>
        <div
          className="text-right text-[10px] font-mono mt-0.5"
          style={{ color: "var(--text-muted)" }}
        >
          {task.progress}%
        </div>
      </div>

      {/* Footer */}
      <div
        className="flex items-center gap-2 text-[10px] font-mono"
        style={{ color: "var(--text-muted)" }}
      >
        <Clock size={10} />
        <span>{fmtTime(task.updatedAt)}</span>
        {task.error && (
          <>
            <span>·</span>
            <AlertTriangle size={10} style={{ color: "var(--accent-red)" }} />
            <span style={{ color: "var(--accent-red)" }}>有错误</span>
          </>
        )}
      </div>
    </div>
  );
}

/** 任务详情抽屉 */
function TaskDetailDrawer({
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

  // 状态更新 mutation
  const statusMutation = trpc.orch.updateStatus.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
      utils.orch.getOverview.invalidate();
    },
  });
  const taskMutation = trpc.task.updateProgress.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
    },
  });

  // 写入记事板
  const [selectedConv, setSelectedConv] = useState<number | null>(null);
  const [writingToBoard, setWritingToBoard] = useState(false);
  const convMutation = trpc.conversation.appendTaskOutput.useMutation({
    onSuccess: () => {
      setWritingToBoard(false);
      utils.conversation.list.invalidate();
      utils.conversation.stats.invalidate();
    },
    onError: () => setWritingToBoard(false),
  });

  const handleStatusChange = (newStatus: "queued" | "running" | "done" | "failed") => {
    statusMutation.mutate({ id: task.id, status: newStatus });
  };

  const handleWriteToBoard = () => {
    if (!selectedConv || !agent || !task.output) return;
    setWritingToBoard(true);
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
                  {convMutation.isError && (
                    <span className="text-[11px]" style={{ color: "var(--accent-red)" }}>
                      写入失败: {convMutation.error?.message}
                    </span>
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
        </div>
      </div>
    </div>
  );
}

/** 创建任务弹窗 */
function CreateTaskDialog({
  open,
  onClose,
  agents,
}: {
  open: boolean;
  agents: Agent[];
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentId, setAgentId] = useState<number | null>(null);
  const [priority, setPriority] = useState(0);
  const [input, setInput] = useState("");
  const [queueNow, setQueueNow] = useState(true);

  const utils = trpc.useUtils();

  // 获取自动生成的 taskId
  const taskIdQuery = trpc.task.nextTaskId.useQuery(undefined, {
    enabled: open,
    refetchOnMount: true,
    staleTime: 0,
  });

  const createMutation = trpc.orch.createTask.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        onClose();
        setName("");
        setDescription("");
        setAgentId(null);
        setPriority(0);
        setInput("");
        setQueueNow(true);
        utils.task.list.invalidate();
        utils.orch.getOverview.invalidate();
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const tid = taskIdQuery.data?.taskId ?? `TG-${Date.now().toString(36).slice(-6).toUpperCase()}`;
    createMutation.mutate({
      taskId: tid,
      name: name.trim(),
      description: description.trim() || undefined,
      agentId: agentId ?? undefined,
      priority,
      input: input.trim() || undefined,
      status: queueNow ? "queued" : "pending",
    });
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
      style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl rounded-lg"
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          boxShadow: "0 0 80px rgba(0,0,0,0.5), 0 0 20px rgba(74,158,255,0.08)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <div className="flex items-center gap-2">
            <Target size={18} style={{ color: "var(--accent-cyan)" }} />
            <span className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
              创建新任务
            </span>
            {taskIdQuery.data && (
              <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>
                {taskIdQuery.data.taskId}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(180,200,255,0.1)]"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-4 max-h-[75vh] overflow-y-auto custom-scrollbar">
          {/* Name */}
          <div>
            <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
              任务名称 · NAME *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入任务名称..."
              required
              autoFocus
              className="w-full px-3 py-2 rounded text-sm outline-none transition-all"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent-cyan)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
            />
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
              描述 · DESCRIPTION
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="描述任务内容..."
              rows={2}
              className="w-full px-3 py-2 rounded text-sm outline-none transition-all resize-none"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent-cyan)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
            />
          </div>

          {/* Agent + Priority row */}
          <div className="grid grid-cols-2 gap-3">
            {/* Agent */}
            <div>
              <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                指派 Agent · ASSIGN
              </label>
              <select
                value={agentId ?? ""}
                onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : null)}
                className="w-full px-3 py-2 rounded text-xs outline-none"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="">— 不指定（通用任务）—</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({AGENT_STATUS_LABELS[a.status]})
                  </option>
                ))}
              </select>
            </div>

            {/* Priority */}
            <div>
              <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
                优先级 · PRIORITY
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                className="w-full px-3 py-2 rounded text-xs outline-none"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                {[0, 1, 2, 3, 4, 5].map((p) => (
                  <option key={p} value={p}>
                    P{p} — {PRIORITY_LABELS[p] || "普通"}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Input */}
          <div>
            <label className="text-[10px] font-mono mb-1.5 block" style={{ color: "var(--text-muted)" }}>
              输入内容 · INPUT
            </label>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="任务输入内容，如需要处理的文本、指令等..."
              rows={4}
              className="w-full px-3 py-2 rounded text-sm outline-none transition-all resize-none"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = "var(--accent-cyan)")}
              onBlur={(e) => (e.currentTarget.style.borderColor = "var(--border-default)")}
            />
          </div>

          {/* Queue Now */}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="queueNow"
              checked={queueNow}
              onChange={(e) => setQueueNow(e.target.checked)}
              className="accent-[var(--accent-cyan)]"
            />
            <label htmlFor="queueNow" className="text-xs cursor-pointer" style={{ color: "var(--text-secondary)" }}>
              立即加入队列（否则为待处理状态）
            </label>
          </div>

          {/* Error */}
          {createMutation.isError && (
            <div
              className="text-xs px-2 py-1.5 rounded font-mono"
              style={{ background: "var(--accent-glow-red)", color: "var(--accent-red)" }}
            >
              {createMutation.error?.message}
            </div>
          )}

          {/* Submit */}
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-4 py-2 rounded font-mono transition-colors hover:bg-[rgba(180,200,255,0.05)]"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || !name.trim()}
              className="text-xs px-5 py-2 rounded font-bold tracking-wide transition-all hover:brightness-110 disabled:opacity-50 flex items-center gap-1"
              style={{
                background: "var(--accent-cyan)",
                color: "#fff",
                boxShadow: "0 0 12px rgba(74,158,255,0.2)",
              }}
            >
              <Plus size={14} />
              {createMutation.isPending ? "创建中..." : "创建任务"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ═══════════════════════ Page ═══════════════════════

export default function TaskCenter() {
  const [showCreate, setShowCreate] = useState(false);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterAgentId, setFilterAgentId] = useState<number | undefined>();
  const [keyword, setKeyword] = useState("");

  const agentQuery = trpc.agent.list.useQuery(undefined, { retry: 1, staleTime: 15000 });
  const agents = (agentQuery.data || []) as Agent[];

  const taskQuery = trpc.task.list.useQuery(
    {
      status: (filterStatus || undefined) as Task["status"] | undefined,
      agentId: filterAgentId,
      keyword: keyword || undefined,
    },
    { retry: 1, staleTime: 5000 }
  );
  const tasks = (taskQuery.data || []) as Task[];

  const convQuery = trpc.conversation.list.useQuery(
    { status: "active" },
    { retry: 1, staleTime: 30000 }
  );
  const conversations = (convQuery.data || []) as Conversation[];

  const utils = trpc.useUtils();
  const deleteMutation = trpc.task.delete.useMutation({
    onSuccess: () => {
      utils.task.list.invalidate();
    },
  });

  // Dashboard WebSocket: backend broadcasts task_update when tasks are created/updated.
  const { connected: wsConnected, lastMessage } = useWebSocket();
  useEffect(() => {
    if (lastMessage?.type !== "task_update") return;
    utils.task.list.invalidate();
    utils.orch.getOverview.invalidate();
  }, [lastMessage, utils]);

  const refresh = useCallback(() => {
    utils.task.list.invalidate();
  }, [utils]);

  const handleDelete = (task: Task) => {
    if (window.confirm(`确定要删除任务「${task.name}」(${task.taskId}) 吗？`)) {
      deleteMutation.mutate({ id: task.id });
    }
  };

  return (
    <div
      className="min-h-screen pt-16 px-4 md:px-6 max-w-7xl mx-auto"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1
            className="text-xl font-black tracking-widest"
            style={{ color: "var(--text-primary)" }}
          >
            任务指挥中心
          </h1>
          <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
            TASK CENTER · CREATE / ASSIGN / TRACK
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="px-3 py-2 rounded text-xs font-mono transition-colors hover:bg-[rgba(180,200,255,0.05)] flex items-center gap-1"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={12} /> 刷新
          </button>
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 rounded text-xs font-bold tracking-wide transition-all hover:brightness-110 flex items-center gap-2"
            style={{
              background: "var(--accent-cyan)",
              color: "#fff",
              boxShadow: "0 0 16px rgba(74,158,255,0.25)",
            }}
          >
            <Plus size={14} />
            创建任务
          </button>
        </div>
      </div>

      {/* Stats */}
      <StatsRow tasks={tasks} />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Search */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded" style={{ background: "rgba(0,0,0,0.15)", border: "1px solid var(--border-default)" }}>
          <Search size={14} style={{ color: "var(--text-muted)" }} />
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索标题/描述..."
            className="bg-transparent text-xs outline-none w-48"
            style={{ color: "var(--text-primary)" }}
          />
        </div>

        {/* Status filter */}
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-1.5 rounded text-xs outline-none font-mono"
          style={{
            background: "rgba(0,0,0,0.15)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
          }}
        >
          <option value="">全部状态</option>
          {Object.entries(STATUS_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>

        {/* Agent filter */}
        <select
          value={filterAgentId ?? ""}
          onChange={(e) => setFilterAgentId(e.target.value ? Number(e.target.value) : undefined)}
          className="px-3 py-1.5 rounded text-xs outline-none font-mono"
          style={{
            background: "rgba(0,0,0,0.15)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
          }}
        >
          <option value="">全部 Agent</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        {/* Online filter */}
        <div className="flex items-center gap-2 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} />
            在线 {agents.filter((a) => a.status === "online").length}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--warning)" }} />
            忙碌 {agents.filter((a) => a.status === "busy").length}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--text-muted)" }} />
            空闲 {agents.filter((a) => a.status === "idle").length}
          </span>
        </div>
      </div>

      {/* Loading */}
      {taskQuery.isLoading && (
        <div
          className="text-sm font-mono text-center py-12"
          style={{ color: "var(--text-muted)" }}
        >
          加载任务列表...
        </div>
      )}

      {/* Error */}
      {taskQuery.isError && (
        <div className="text-sm" style={{ color: "var(--accent-red)" }}>
          加载失败: {taskQuery.error?.message}
        </div>
      )}

      {/* Empty */}
      {!taskQuery.isLoading && !taskQuery.isError && tasks.length === 0 && (
        <div className="glass-panel p-8 text-center sci-border">
          <Target
            size={48}
            className="mx-auto mb-3 opacity-20"
            style={{ color: "var(--text-muted)" }}
          />
          <div className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
            {keyword || filterStatus || filterAgentId
              ? "没有匹配的任务"
              : "暂无任务，点击「创建任务」开始"}
          </div>
        </div>
      )}

      {/* Task Grid */}
      {tasks.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agents={agents}
              onView={() => setDetailTask(task)}
              onDelete={() => handleDelete(task)}
            />
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <CreateTaskDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        agents={agents}
      />

      {/* Detail Drawer */}
      {detailTask && (
        <TaskDetailDrawer
          task={detailTask}
          agents={agents}
          conversations={conversations}
          open={detailTask !== null}
          onClose={() => setDetailTask(null)}
        />
      )}
    </div>
  );
}
