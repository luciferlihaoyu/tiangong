/**
 * 天宫 Agent 列表页 — AgentList
 *
 * 展示所有 Agent 卡片，支持点击跳转到详情页
 * 页面路由 /agents
 */
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useEffect } from "react";
import {
  Bot,
  Activity,
  Clock,
  RefreshCw,
  ArrowRight,
} from "lucide-react";

// ═══════════════════════ Types ═══════════════════════

interface Agent {
  id: number;
  agentId: string;
  name: string;
  status: "online" | "busy" | "idle";
  model: string | null;
  role: string | null;
  currentTask: string | null;
  progress: number | null;
  lastHeartbeat: string | null;
}

// ═══════════════════════ Constants ═══════════════════════

const STATUS_CONFIG: Record<string, { color: string; bg: string; label: string }> = {
  online: { color: "var(--success)", bg: "rgba(76,175,125,0.08)", label: "在线" },
  busy: { color: "var(--warning)", bg: "var(--accent-glow-gold)", label: "忙碌" },
  idle: { color: "var(--text-muted)", bg: "rgba(180,200,255,0.03)", label: "空闲" },
};

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ═══════════════════════ Components ═══════════════════════

/** Agent 卡片 */
function AgentCard({ agent }: { agent: Agent }) {
  const navigate = useNavigate();
  const sc = STATUS_CONFIG[agent.status] || STATUS_CONFIG.idle;

  return (
    <button
      onClick={() => navigate(`/agents/${agent.id}`)}
      className="w-full text-left glass-panel p-4 sci-border transition-all hover:border-[var(--accent-cyan)]/20 group"
    >
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
            style={{ background: sc.bg }}
          >
            <Bot size={16} style={{ color: sc.color }} />
          </div>
          <div>
            <h3 className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
              {agent.name}
            </h3>
            <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
              {agent.agentId}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1"
            style={{ background: sc.bg, color: sc.color }}
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: sc.color }} />
            {sc.label}
          </span>
          <ArrowRight
            size={14}
            className="opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: "var(--accent-cyan)" }}
          />
        </div>
      </div>

      <div className="space-y-2 text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
        {agent.model && (
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--text-muted)" }}>模型</span>
            <span>{agent.model}</span>
          </div>
        )}
        {agent.role && (
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--text-muted)" }}>角色</span>
            <span>{agent.role}</span>
          </div>
        )}
        {agent.currentTask && (
          <div className="flex items-center gap-2">
            <Activity size={10} style={{ color: "var(--warning)" }} />
            <span className="truncate">{agent.currentTask}</span>
          </div>
        )}
        {agent.progress !== null && agent.progress > 0 && (
          <div className="flex items-center gap-2">
            <div className="flex-1 progress-track" style={{ height: "4px" }}>
              <div className="progress-fill" style={{ width: `${agent.progress}%` }} />
            </div>
            <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              {agent.progress}%
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Clock size={10} style={{ color: "var(--text-muted)" }} />
          <span style={{ color: "var(--text-muted)" }}>
            心跳 {fmtTime(agent.lastHeartbeat)}
          </span>
        </div>
      </div>
    </button>
  );
}

// ═══════════════════════ Page ═══════════════════════

export default function AgentList() {
  const agentQuery = trpc.agent.list.useQuery(undefined, { retry: 1, staleTime: 15000 });
  const agents = (agentQuery.data || []) as Agent[];
  const utils = trpc.useUtils();

  const { lastMessage } = useWebSocket();
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "agent_update" || lastMessage.type === "task_update") {
      utils.agent.list.invalidate();
    }
  }, [lastMessage, utils]);

  const refresh = () => {
    utils.agent.list.invalidate();
  };

  return (
    <div
      className="min-h-screen pt-16 px-4 md:px-6 max-w-7xl mx-auto"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-black tracking-widest" style={{ color: "var(--text-primary)" }}>
            Agent 列表
          </h1>
          <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
            AGENTS · RUNTIME ENGINE
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
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
          <button
            onClick={refresh}
            className="px-3 py-2 rounded text-xs font-mono transition-colors hover:bg-[rgba(180,200,255,0.05)] flex items-center gap-1"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={12} /> 刷新
          </button>
        </div>
      </div>

      {/* Loading */}
      {agentQuery.isLoading && (
        <div className="text-sm font-mono text-center py-12" style={{ color: "var(--text-muted)" }}>
          加载 Agent 列表...
        </div>
      )}

      {/* Error */}
      {agentQuery.isError && (
        <div className="text-sm" style={{ color: "var(--accent-red)" }}>
          加载失败: {agentQuery.error?.message}
        </div>
      )}

      {/* Empty */}
      {!agentQuery.isLoading && !agentQuery.isError && agents.length === 0 && (
        <div className="glass-panel p-8 text-center sci-border">
          <Bot size={48} className="mx-auto mb-3 opacity-20" style={{ color: "var(--text-muted)" }} />
          <div className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
            暂无 Agent
          </div>
        </div>
      )}

      {/* Agent Grid */}
      {agents.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
