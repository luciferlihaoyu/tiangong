/**
 * 天宫 Agent 详情页 — AgentDetail
 *
 * 展示 Agent 基本信息、能力列表、运行时统计、Token 用量、任务执行统计
 * 页面路由 /agents/:agentId
 */
import { useParams, useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useEffect } from "react";
import {
  Bot,
  ArrowLeft,
  Activity,
  Zap,
  CheckCircle,
  AlertTriangle,
  Clock,
  Pause,
  RefreshCw,
  Shield,
  Globe,
  FileCode,
  Folder,
  Layers,
  Cpu,
} from "lucide-react";

// ═══════════════════════ Types ═══════════════════════

interface Capability {
  category: string;
  items: string[];
  level: string;
}

interface Agent {
  id: number;
  agentId: string;
  name: string;
  system: string;
  status: "online" | "busy" | "idle";
  model: string | null;
  role: string | null;
  description: string | null;
  source: string | null;
  currentTask: string | null;
  progress: number | null;
  lastHeartbeat: string | null;
  budgetCents: number | null;
  spentCents: number | null;
  canModifyTiangongCore: string | null;
  canSendExternalMessage: string | null;
}

interface RuntimeStats {
  agentId: number;
  agentName: string;
  status: string;
  currentTask: string | null;
  progress: number | null;
  lastHeartbeat: string | null;
  spentCents: number | null;
  budgetCents: number | null;
  tokenUsage: {
    totalCalls: number;
    totalTokens: number;
    totalCostCents: number;
  };
  taskExecution: {
    completed: number;
    failed: number;
    dispatched: number;
    timeout: number;
    running: number;
    done: number;
    failedTasks: number;
    queued: number;
    pending: number;
  };
}

// ═══════════════════════ Constants ═══════════════════════

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  online: { color: "var(--success)", bg: "rgba(76,175,125,0.08)", label: "在线" },
  busy: { color: "var(--warning)", bg: "var(--accent-glow-gold)", label: "忙碌" },
  idle: { color: "var(--text-muted)", bg: "rgba(180,200,255,0.03)", label: "空闲" },
};

const TASK_STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  completed: { label: "已完成", color: "var(--success)", icon: <CheckCircle size={12} /> },
  failed: { label: "失败", color: "var(--accent-red)", icon: <AlertTriangle size={12} /> },
  dispatched: { label: "已派发", color: "var(--accent-cyan)", icon: <Zap size={12} /> },
  timeout: { label: "超时", color: "var(--accent-red)", icon: <Clock size={12} /> },
  running: { label: "执行中", color: "var(--warning)", icon: <Activity size={12} /> },
  done: { label: "已完成", color: "var(--success)", icon: <CheckCircle size={12} /> },
  failedTasks: { label: "失败任务", color: "var(--accent-red)", icon: <AlertTriangle size={12} /> },
  queued: { label: "排队中", color: "var(--accent-cyan)", icon: <Pause size={12} /> },
  pending: { label: "待处理", color: "var(--text-muted)", icon: <Clock size={12} /> },
};

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtCost(cents: number | null) {
  if (cents === null || cents === 0) return "$0.00";
  const usd = cents / 100;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `${cents}¢`;
}

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ═══════════════════════ Components ═══════════════════════

/** 统计小卡片 */
function StatCard({
  label,
  value,
  sub,
  color,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="glass-panel p-3 sci-border flex items-center gap-2">
      <div
        className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
        style={{ background: "rgba(255,255,255,0.03)" }}
      >
        <span style={{ color }}>{icon}</span>
      </div>
      <div className="min-w-0">
        <div className="text-lg font-bold font-mono" style={{ color }}>
          {value}
        </div>
        {sub && (
          <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
            {sub}
          </div>
        )}
        <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
          {label}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════ Page ═══════════════════════

export default function AgentDetail() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();
  const id = Number(agentId);

  const agentQuery = trpc.agent.getById.useQuery(
    { id },
    { enabled: !Number.isNaN(id), retry: 1, staleTime: 5000 }
  );
  const capabilitiesQuery = trpc.agent.getCapabilities.useQuery(
    { agentId: id },
    { enabled: !Number.isNaN(id), retry: 1, staleTime: 10000 }
  );
  const statsQuery = trpc.agent.getRuntimeStats.useQuery(
    { agentId: id },
    { enabled: !Number.isNaN(id), retry: 1, staleTime: 5000 }
  );

  const agent = agentQuery.data as Agent | null | undefined;
  const capabilities = capabilitiesQuery.data as
    | { agentId: number; agentName: string; capabilities: Capability[] }
    | null
    | undefined;
  const stats = statsQuery.data as RuntimeStats | null | undefined;

  const utils = trpc.useUtils();
  const { lastMessage } = useWebSocket();

  useEffect(() => {
    if (!lastMessage) return;
    if (
      lastMessage.type === "agent_update" ||
      lastMessage.type === "task_update" ||
      lastMessage.type === "session_message"
    ) {
      utils.agent.getById.invalidate({ id });
      utils.agent.getRuntimeStats.invalidate({ agentId: id });
    }
  }, [lastMessage, id, utils]);

  const refresh = () => {
    utils.agent.getById.invalidate({ id });
    utils.agent.getCapabilities.invalidate({ agentId: id });
    utils.agent.getRuntimeStats.invalidate({ agentId: id });
  };

  if (Number.isNaN(id)) {
    return (
      <div
        className="min-h-screen pt-16 px-4 md:px-6 max-w-7xl mx-auto"
        style={{ backgroundColor: "var(--bg-primary)" }}
      >
        <div className="text-sm" style={{ color: "var(--accent-red)" }}>
          无效的 Agent ID
        </div>
      </div>
    );
  }

  const sc = STATUS_CONFIG[agent?.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.idle;

  return (
    <div
      className="min-h-screen pt-16 px-4 md:px-6 max-w-7xl mx-auto"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/agents")}
            className="p-2 rounded hover:bg-[rgba(180,200,255,0.05)] transition-colors"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <ArrowLeft size={14} />
          </button>
          <div>
            <h1
              className="text-xl font-black tracking-widest"
              style={{ color: "var(--text-primary)" }}
            >
              {agent?.name || "Agent 详情"}
            </h1>
            <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
              {agent?.agentId ? `${agent.agentId} · ` : ""}
              AGENT DETAIL · RUNTIME STATS
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          className="px-3 py-2 rounded text-xs font-mono transition-colors hover:bg-[rgba(180,200,255,0.05)] flex items-center gap-1"
          style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
        >
          <RefreshCw size={12} /> 刷新
        </button>
      </div>

      {/* Loading */}
      {agentQuery.isLoading && (
        <div className="text-sm font-mono text-center py-12" style={{ color: "var(--text-muted)" }}>
          加载 Agent 详情...
        </div>
      )}

      {/* Not found */}
      {!agentQuery.isLoading && !agent && (
        <div className="glass-panel p-8 text-center sci-border">
          <Bot size={48} className="mx-auto mb-3 opacity-20" style={{ color: "var(--text-muted)" }} />
          <div className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
            未找到 Agent
          </div>
        </div>
      )}

      {agent && (
        <div className="space-y-6">
          {/* Basic Info Card */}
          <div className="glass-panel p-5 sci-border">
            <div className="flex items-start justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                <div
                  className="w-10 h-10 rounded flex items-center justify-center flex-shrink-0"
                  style={{ background: sc.bg }}
                >
                  <Bot size={20} style={{ color: sc.color }} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>
                      {agent.name}
                    </h2>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1"
                      style={{ background: sc.bg, color: sc.color }}
                    >
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: sc.color }} />
                      {sc.label}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono mt-0.5" style={{ color: "var(--text-muted)" }}>
                    {agent.agentId} · {agent.system} · {agent.model || "无模型"}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                  最后心跳
                </div>
                <div className="text-xs font-mono" style={{ color: "var(--text-secondary)" }}>
                  {fmtTime(agent.lastHeartbeat)}
                </div>
              </div>
            </div>

            {/* Status row */}
            <div
              className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4"
              style={{ borderTop: "1px solid var(--border-default)" }}
            >
              <div>
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                  当前任务 · CURRENT TASK
                </div>
                <div
                  className="text-sm font-bold"
                  style={{
                    color: agent.currentTask ? "var(--text-primary)" : "var(--text-muted)",
                  }}
                >
                  {agent.currentTask || "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                  进度 · PROGRESS
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 progress-track" style={{ height: "6px" }}>
                    <div className="progress-fill" style={{ width: `${agent.progress ?? 0}%` }} />
                  </div>
                  <span className="text-xs font-mono" style={{ color: "var(--text-secondary)" }}>
                    {agent.progress ?? 0}%
                  </span>
                </div>
              </div>
              <div>
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                  预算 · BUDGET
                </div>
                <div className="text-sm font-bold font-mono" style={{ color: "var(--accent-gold)" }}>
                  {fmtCost(agent.spentCents)} / {fmtCost(agent.budgetCents)}
                </div>
              </div>
            </div>
          </div>

          {/* Stats Overview Row */}
          {stats && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                label="总调用"
                value={String(stats.tokenUsage.totalCalls)}
                color="var(--accent-cyan)"
                icon={<Zap size={16} />}
              />
              <StatCard
                label="总 Token"
                value={fmtTokens(stats.tokenUsage.totalTokens)}
                color="var(--accent-cyan)"
                icon={<Cpu size={16} />}
              />
              <StatCard
                label="总成本"
                value={fmtCost(stats.tokenUsage.totalCostCents)}
                color="var(--accent-gold)"
                icon={<Layers size={16} />}
              />
              <StatCard
                label="已完成"
                value={String(stats.taskExecution.completed)}
                color="var(--success)"
                icon={<CheckCircle size={16} />}
              />
            </div>
          )}

          {/* Detail Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Token Usage */}
            <div className="glass-panel p-4 sci-border">
              <div
                className="text-[10px] font-mono mb-3 uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                Token 用量 · TOKEN USAGE
              </div>
              {statsQuery.isLoading ? (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  加载中...
                </div>
              ) : stats ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
                      总调用
                    </span>
                    <span className="text-sm font-bold font-mono" style={{ color: "var(--accent-cyan)" }}>
                      {stats.tokenUsage.totalCalls}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
                      总 Token
                    </span>
                    <span className="text-sm font-bold font-mono" style={{ color: "var(--accent-cyan)" }}>
                      {fmtTokens(stats.tokenUsage.totalTokens)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
                      总成本
                    </span>
                    <span className="text-sm font-bold font-mono" style={{ color: "var(--accent-gold)" }}>
                      {fmtCost(stats.tokenUsage.totalCostCents)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  暂无数据
                </div>
              )}
            </div>

            {/* Task Execution */}
            <div className="glass-panel p-4 sci-border">
              <div
                className="text-[10px] font-mono mb-3 uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                任务执行 · TASK EXECUTION
              </div>
              {statsQuery.isLoading ? (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  加载中...
                </div>
              ) : stats ? (
                <div className="space-y-2">
                  {(
                    [
                      { key: "completed", value: stats.taskExecution.completed },
                      { key: "failed", value: stats.taskExecution.failed },
                      { key: "timeout", value: stats.taskExecution.timeout },
                      { key: "queued", value: stats.taskExecution.queued },
                      { key: "running", value: stats.taskExecution.running },
                      { key: "pending", value: stats.taskExecution.pending },
                    ] as { key: string; value: number }[]
                  ).map(({ key, value }) => {
                    const tc = TASK_STATUS_CONFIG[key] || TASK_STATUS_CONFIG.pending;
                    return (
                      <div key={key} className="flex items-center justify-between">
                        <span className="text-[10px] font-mono flex items-center gap-1" style={{ color: tc.color }}>
                          {tc.icon} {tc.label}
                        </span>
                        <span className="text-sm font-bold font-mono" style={{ color: "var(--text-primary)" }}>
                          {value}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  暂无数据
                </div>
              )}
            </div>

            {/* Runtime */}
            <div className="glass-panel p-4 sci-border">
              <div
                className="text-[10px] font-mono mb-3 uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                运行时 · RUNTIME
              </div>
              {statsQuery.isLoading ? (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  加载中...
                </div>
              ) : stats ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
                      状态
                    </span>
                    <span className="text-[11px] font-bold font-mono" style={{ color: sc.color }}>
                      {stats.status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
                      已派发
                    </span>
                    <span className="text-sm font-bold font-mono" style={{ color: "var(--accent-cyan)" }}>
                      {stats.taskExecution.dispatched}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
                      已完成
                    </span>
                    <span className="text-sm font-bold font-mono" style={{ color: "var(--success)" }}>
                      {stats.taskExecution.done}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
                      已花费
                    </span>
                    <span className="text-sm font-bold font-mono" style={{ color: "var(--accent-gold)" }}>
                      {fmtCost(stats.spentCents)}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  暂无数据
                </div>
              )}
            </div>

            {/* Permissions */}
            <div className="glass-panel p-4 sci-border">
              <div
                className="text-[10px] font-mono mb-3 uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                权限 · PERMISSIONS
              </div>
              <div className="space-y-2">
                {(
                  [
                    { label: "修改核心", value: agent.canModifyTiangongCore === "true", icon: <Shield size={12} /> },
                    { label: "外部消息", value: agent.canSendExternalMessage === "true", icon: <Globe size={12} /> },
                    { label: "执行代码", value: false, icon: <FileCode size={12} /> },
                    { label: "访问文件", value: false, icon: <Folder size={12} /> },
                  ] as { label: string; value: boolean; icon: React.ReactNode }[]
                ).map(({ label, value, icon }) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-[11px] flex items-center gap-1" style={{ color: "var(--text-secondary)" }}>
                      {icon} {label}
                    </span>
                    <span
                      className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        background: value ? "rgba(76,175,125,0.1)" : "rgba(180,200,255,0.03)",
                        color: value ? "var(--success)" : "var(--text-muted)",
                      }}
                    >
                      {value ? "YES" : "NO"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Capabilities */}
          <div className="glass-panel p-5 sci-border">
            <div
              className="text-[10px] font-mono mb-4 uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              能力列表 · CAPABILITIES
            </div>
            {capabilitiesQuery.isLoading ? (
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                加载中...
              </div>
            ) : capabilities && capabilities.capabilities.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {capabilities.capabilities.map((cap, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded"
                    style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-default)" }}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold" style={{ color: "var(--text-primary)" }}>
                        {cap.category}
                      </span>
                      <span
                        className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                        style={{
                          background: "rgba(74,158,255,0.08)",
                          color: "var(--accent-cyan)",
                        }}
                      >
                        {cap.level}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {cap.items.map((item, i) => (
                        <span
                          key={i}
                          className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                          style={{
                            background: "rgba(180,200,255,0.05)",
                            color: "var(--text-secondary)",
                            border: "1px solid var(--border-default)",
                          }}
                        >
                          {item}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                暂无能力数据
              </div>
            )}
          </div>

          {/* Meta */}
          <div className="glass-panel p-4 sci-border">
            <div
              className="text-[10px] font-mono mb-3 uppercase tracking-wider"
              style={{ color: "var(--text-muted)" }}
            >
              元数据 · META
            </div>
            <div
              className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs font-mono"
              style={{ color: "var(--text-muted)" }}
            >
              <div>
                <span style={{ color: "var(--text-secondary)" }}>ID:</span> #{agent.id}
              </div>
              <div>
                <span style={{ color: "var(--text-secondary)" }}>System:</span> {agent.system}
              </div>
              <div>
                <span style={{ color: "var(--text-secondary)" }}>Source:</span> {agent.source || "—"}
              </div>
              <div>
                <span style={{ color: "var(--text-secondary)" }}>Role:</span> {agent.role || "—"}
              </div>
              <div className="col-span-2">
                <span style={{ color: "var(--text-secondary)" }}>Description:</span>{" "}
                <span style={{ color: "var(--text-secondary)" }}>{agent.description || "—"}</span>
              </div>
              <div>
                <span style={{ color: "var(--text-secondary)" }}>Model:</span> {agent.model || "—"}
              </div>
              <div>
                <span style={{ color: "var(--text-secondary)" }}>Progress:</span> {agent.progress ?? 0}%
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
