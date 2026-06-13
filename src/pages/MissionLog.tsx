/**
 * 天宫 任务记事板 — MissionLog
 * conversations 表的 UI 面板
 */

import { useState, useMemo } from "react";
import { trpc } from "@/providers/trpc";
import {
  ClipboardList,
  Plus,
  X,
  Eye,
  Archive,
  RotateCcw,
  Trash2,
  MessageSquare,
  Clock,
  ChevronRight,
} from "lucide-react";

// ═══════════════════════ Types ═══════════════════════

interface Conversation {
  id: number;
  title: string;
  type: "mission" | "meeting" | "test" | "ad_hoc";
  status: "active" | "archived";
  participants: string | null; // JSON string of number[]
  summary: string | null;
  createdBy: number | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Message {
  id: number;
  fromAgent: number;
  toAgent: number;
  content: string;
  type: "command" | "response" | "broadcast" | "system";
  status: "sent" | "delivered" | "read";
  readAt: string | null;
  conversationId: number | null;
  createdAt: string;
}

interface Agent {
  id: number;
  name: string;
  agentId: string;
}

// ═══════════════════════ Constants ═══════════════════════

const TYPE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  mission: { label: "任务", color: "var(--accent-cyan)", bg: "rgba(74,158,255,0.1)" },
  meeting: { label: "会议", color: "#a855f7", bg: "rgba(168,85,247,0.1)" },
  test: { label: "测试", color: "var(--success)", bg: "rgba(76,175,125,0.1)" },
  ad_hoc: { label: "临时", color: "var(--text-muted)", bg: "rgba(180,200,255,0.05)" },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  sent: { label: "已发送", color: "var(--text-muted)", bg: "rgba(180,200,255,0.05)" },
  delivered: { label: "已送达", color: "var(--warning)", bg: "var(--accent-glow-gold)" },
  read: { label: "已读", color: "var(--success)", bg: "rgba(76,175,125,0.1)" },
};

const MSG_TYPE_CONFIG: Record<string, string> = {
  command: "指令",
  response: "回复",
  broadcast: "广播",
  system: "系统",
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ═══════════════════════ Components ═══════════════════════

/** 顶部统计卡片 */
function StatsCards({ active, archived }: { active: number; archived: number }) {
  return (
    <div className="grid grid-cols-2 gap-4 max-w-md">
      <div className="glass-panel p-4 sci-border flex items-center gap-3">
        <div
          className="w-10 h-10 rounded flex items-center justify-center"
          style={{ background: "rgba(74,158,255,0.1)" }}
        >
          <ClipboardList size={20} style={{ color: "var(--accent-cyan)" }} />
        </div>
        <div>
          <div className="text-2xl font-bold font-mono" style={{ color: "var(--accent-cyan)" }}>
            {active}
          </div>
          <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            进行中 · ACTIVE
          </div>
        </div>
      </div>
      <div className="glass-panel p-4 sci-border flex items-center gap-3">
        <div
          className="w-10 h-10 rounded flex items-center justify-center"
          style={{ background: "rgba(180,200,255,0.05)" }}
        >
          <Archive size={20} style={{ color: "var(--text-muted)" }} />
        </div>
        <div>
          <div className="text-2xl font-bold font-mono" style={{ color: "var(--text-muted)" }}>
            {archived}
          </div>
          <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            已归档 · ARCHIVED
          </div>
        </div>
      </div>
    </div>
  );
}

/** 记事板卡片 */
function ConversationCard({
  conv,
  agents,
  onView,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  conv: Conversation;
  agents: Agent[];
  onView: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const typeCfg = TYPE_CONFIG[conv.type] || TYPE_CONFIG.ad_hoc;
  const participantIds: number[] = (() => {
    try {
      return JSON.parse(conv.participants || "[]") as number[];
    } catch {
      return [];
    }
  })();
  const participantNames = participantIds
    .map((id) => agents.find((a) => a.id === id)?.name)
    .filter(Boolean);

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
        {conv.status === "active" ? (
          <button
            onClick={onArchive}
            className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(201,168,76,0.1)] flex items-center gap-1"
            style={{ color: "var(--accent-gold)" }}
          >
            <Archive size={12} /> 归档
          </button>
        ) : (
          <button
            onClick={onUnarchive}
            className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(100,181,246,0.1)] flex items-center gap-1"
            style={{ color: "var(--accent-cyan)" }}
          >
            <RotateCcw size={12} /> 恢复
          </button>
        )}
        <button
          onClick={onDelete}
          className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--accent-glow-red)] flex items-center gap-1"
          style={{ color: "var(--accent-red)" }}
        >
          <Trash2 size={12} /> 删除
        </button>
      </div>

      {/* Header: title + type tag */}
      <div className="flex items-center gap-2 mb-2 pr-24">
        <h3 className="text-sm font-bold truncate" style={{ color: "var(--text-primary)" }}>
          {conv.title}
        </h3>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0"
          style={{ background: typeCfg.bg, color: typeCfg.color }}
        >
          {typeCfg.label}
        </span>
      </div>

      {/* Participants */}
      {participantNames.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {participantNames.map((name, i) => (
            <span
              key={i}
              className="text-[10px] px-1.5 py-0.5 rounded font-mono"
              style={{ background: "rgba(255,255,255,0.03)", color: "var(--text-secondary)" }}
            >
              {name}
            </span>
          ))}
        </div>
      )}

      {/* Summary */}
      {conv.summary && (
        <div
          className="text-xs mb-2 line-clamp-2"
          style={{ color: "var(--text-muted)" }}
        >
          {conv.summary}
        </div>
      )}

      {/* Footer: time */}
      <div className="flex items-center gap-2 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
        <Clock size={10} />
        <span>{fmtTime(conv.updatedAt)}</span>
        {conv.archivedAt && (
          <>
            <span>·</span>
            <Archive size={10} />
            <span>{fmtTime(conv.archivedAt)}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** 详情弹窗 — 时间线消息列表 */
function DetailDialog({
  convId,
  agents,
  open,
  onClose,
}: {
  convId: number;
  agents: Agent[];
  open: boolean;
  onClose: () => void;
}) {
  const detailQuery = trpc.conversation.getById.useQuery(
    { id: convId },
    { enabled: open }
  );
  const data = detailQuery.data as (Conversation & { messages: Message[] }) | null;

  if (!open) return null;
  const typeCfg = TYPE_CONFIG[data?.type || "ad_hoc"] || TYPE_CONFIG.ad_hoc;

  // Simple markdown render without DOMPurify (trusted internal data)
  const renderText = (text: string) => {
    if (!text) return "";
    return text.replace(/</g, "&lt;").replace(/\n/g, "<br/>");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[80vh] overflow-hidden rounded-lg flex flex-col"
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          boxShadow: "0 0 60px rgba(0,0,0,0.5), 0 0 20px rgba(74,158,255,0.05)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <MessageSquare size={18} style={{ color: "var(--accent-cyan)" }} />
            <div className="min-w-0">
              <h2 className="text-sm font-bold truncate" style={{ color: "var(--text-primary)" }}>
                {data?.title || "加载中..."}
              </h2>
              {data && (
                <div className="flex items-center gap-2 mt-0.5">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-mono"
                    style={{ background: typeCfg.bg, color: typeCfg.color }}
                  >
                    {typeCfg.label}
                  </span>
                  <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                    {fmtTime(data.createdAt)}
                  </span>
                </div>
              )}
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
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
          {detailQuery.isLoading ? (
            <div className="text-sm font-mono text-center py-12" style={{ color: "var(--text-muted)" }}>
              加载中...
            </div>
          ) : detailQuery.isError ? (
            <div className="text-sm text-center py-12" style={{ color: "var(--accent-red)" }}>
              加载失败: {detailQuery.error?.message}
            </div>
          ) : !data ? (
            <div className="text-sm text-center py-12" style={{ color: "var(--text-muted)" }}>
              记事板不存在
            </div>
          ) : (
            <>
              {/* Summary */}
              {data.summary && (
                <div
                  className="terminal-panel p-4 mb-4 text-xs leading-relaxed"
                  style={{ color: "var(--text-secondary)" }}
                >
                  <div className="section-label mb-2">摘要 · SUMMARY</div>
                  <div
                    className="prose-custom"
                    dangerouslySetInnerHTML={{ __html: renderText(data.summary) }}
                  />
                </div>
              )}

              {/* Message timeline */}
              <div className="section-label mb-3">
                消息时间线 · MESSAGE LOG ({data.messages?.length || 0})
              </div>

              {data.messages && data.messages.length === 0 ? (
                <div className="text-xs font-mono text-center py-8" style={{ color: "var(--text-muted)" }}>
                  暂无消息记录
                </div>
              ) : (
                <div className="relative pl-6" style={{ borderLeft: "1px solid var(--border-default)" }}>
                  {data.messages?.map((msg: Message, i: number) => {
                    const fromAgent = agents.find((a) => a.id === msg.fromAgent);
                    const toAgent = agents.find((a) => a.id === msg.toAgent);
                    const stCfg = STATUS_CONFIG[msg.status] || STATUS_CONFIG.sent;
                    return (
                      <div key={msg.id} className="relative mb-4 last:mb-0">
                        {/* Timeline dot */}
                        <div
                          className="absolute -left-[7px] top-1 w-3 h-3 rounded-full border-2"
                          style={{
                            background: stCfg.bg,
                            borderColor: stCfg.color,
                            boxShadow: `0 0 6px ${stCfg.color}40`,
                          }}
                        />

                        {/* Header */}
                        <div className="flex items-center gap-2 mb-1.5">
                          <span
                            className="text-xs font-bold"
                            style={{ color: "var(--accent-cyan)" }}
                          >
                            {fromAgent?.name || `#${msg.fromAgent}`}
                          </span>
                          <ChevronRight size={10} style={{ color: "var(--text-muted)" }} />
                          <span
                            className="text-xs font-bold"
                            style={{ color: "var(--accent-gold)" }}
                          >
                            {toAgent?.name || `#${msg.toAgent}`}
                          </span>
                          <span
                            className="text-[10px] px-1 py-0 rounded font-mono"
                            style={{ background: "rgba(255,255,255,0.03)", color: "var(--text-muted)" }}
                          >
                            {MSG_TYPE_CONFIG[msg.type] || msg.type}
                          </span>
                          <span
                            className="text-[10px] px-1 py-0 rounded font-mono"
                            style={{ background: stCfg.bg, color: stCfg.color }}
                          >
                            {stCfg.label}
                          </span>
                          <span className="text-[10px] font-mono ml-auto" style={{ color: "var(--text-muted)" }}>
                            {fmtTime(msg.createdAt)}
                          </span>
                        </div>

                        {/* Message content — Markdown */}
                        <div
                          className="terminal-panel p-3 text-xs leading-relaxed"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          <div
                            className="prose-custom"
                            dangerouslySetInnerHTML={{ __html: renderText(msg.content) }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 新建记事板弹窗 */
function CreateDialog({
  open,
  onClose,
  agents,
}: {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<"mission" | "meeting" | "test" | "ad_hoc">("ad_hoc");
  const [summary, setSummary] = useState("");
  const [selectedAgents, setSelectedAgents] = useState<number[]>([]);

  const utils = trpc.useUtils();
  const createMutation = trpc.conversation.create.useMutation({
    onSuccess: () => {
      onClose();
      setTitle("");
      setType("ad_hoc");
      setSummary("");
      setSelectedAgents([]);
      utils.conversation.list.invalidate();
      utils.conversation.stats.invalidate();
    },
  });

  if (!open) return null;

  const toggleAgent = (id: number) => {
    setSelectedAgents((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    createMutation.mutate({
      title: title.trim(),
      type,
      summary: summary.trim() || undefined,
      participants: selectedAgents.length > 0 ? selectedAgents : undefined,
    });
  };

  const typeOptions: Array<{ value: typeof type; label: string }> = [
    { value: "mission", label: "任务" },
    { value: "meeting", label: "会议" },
    { value: "test", label: "测试" },
    { value: "ad_hoc", label: "临时" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg"
        style={{
          background: "var(--bg-secondary)",
          border: "1px solid var(--border-default)",
          boxShadow: "0 0 60px rgba(0,0,0,0.5), 0 0 20px rgba(74,158,255,0.05)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <div className="flex items-center gap-2">
            <Plus size={18} style={{ color: "var(--accent-cyan)" }} />
            <span className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>
              新建记事板
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(180,200,255,0.1)]"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 flex flex-col gap-4">
          {/* Title */}
          <div>
            <label
              className="text-[10px] font-mono mb-1.5 block"
              style={{ color: "var(--text-muted)" }}
            >
              标题 · TITLE *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入记事板标题..."
              required
              className="w-full px-3 py-2 rounded text-sm outline-none transition-all"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) =>
                (e.currentTarget.style.borderColor = "var(--accent-cyan)")
              }
              onBlur={(e) =>
                (e.currentTarget.style.borderColor = "var(--border-default)")
              }
            />
          </div>

          {/* Type */}
          <div>
            <label
              className="text-[10px] font-mono mb-1.5 block"
              style={{ color: "var(--text-muted)" }}
            >
              类型 · TYPE
            </label>
            <div className="flex gap-2">
              {typeOptions.map((opt) => {
                const cfg = TYPE_CONFIG[opt.value];
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setType(opt.value)}
                    className="text-xs px-3 py-1.5 rounded font-mono transition-all"
                    style={{
                      background:
                        type === opt.value ? cfg.bg : "rgba(255,255,255,0.02)",
                      color: type === opt.value ? cfg.color : "var(--text-muted)",
                      border: `1px solid ${
                        type === opt.value ? cfg.color + "40" : "var(--border-default)"
                      }`,
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Summary */}
          <div>
            <label
              className="text-[10px] font-mono mb-1.5 block"
              style={{ color: "var(--text-muted)" }}
            >
              摘要 · SUMMARY (可选)
            </label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="输入摘要内容..."
              rows={3}
              className="w-full px-3 py-2 rounded text-sm outline-none transition-all resize-none"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
              onFocus={(e) =>
                (e.currentTarget.style.borderColor = "var(--accent-cyan)")
              }
              onBlur={(e) =>
                (e.currentTarget.style.borderColor = "var(--border-default)")
              }
            />
          </div>

          {/* Participants */}
          <div>
            <label
              className="text-[10px] font-mono mb-1.5 block"
              style={{ color: "var(--text-muted)" }}
            >
              参与 Agent · PARTICIPANTS (多选)
            </label>
            <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1">
              {agents.map((agent) => {
                const isSelected = selectedAgents.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => toggleAgent(agent.id)}
                    className="text-xs px-2 py-1 rounded font-mono transition-all"
                    style={{
                      background: isSelected
                        ? "rgba(74,158,255,0.15)"
                        : "rgba(255,255,255,0.02)",
                      color: isSelected ? "var(--accent-cyan)" : "var(--text-muted)",
                      border: `1px solid ${
                        isSelected
                          ? "rgba(74,158,255,0.3)"
                          : "var(--border-default)"
                      }`,
                    }}
                  >
                    {agent.name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Error state */}
          {createMutation.isError && (
            <div
              className="text-xs px-2 py-1.5 rounded font-mono"
              style={{
                background: "var(--accent-glow-red)",
                color: "var(--accent-red)",
              }}
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
              disabled={createMutation.isPending || !title.trim()}
              className="text-xs px-4 py-2 rounded font-bold tracking-wide transition-all hover:brightness-110 disabled:opacity-50"
              style={{
                background: "var(--accent-cyan)",
                color: "#fff",
                boxShadow: "0 0 12px rgba(74,158,255,0.2)",
              }}
            >
              {createMutation.isPending ? "创建中..." : "创建"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ═══════════════════════ Page ═══════════════════════

export default function MissionLog() {
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [detailId, setDetailId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const statsQuery = trpc.conversation.stats.useQuery(undefined, { retry: 1 });
  const listQuery = trpc.conversation.list.useQuery(
    { status: tab },
    { retry: 1, staleTime: 10000 }
  );
  const agentQuery = trpc.agent.list.useQuery(undefined, { retry: 1, staleTime: 30000 });

  const utils = trpc.useUtils();

  const archiveMutation = trpc.conversation.archive.useMutation({
    onSuccess: () => {
      utils.conversation.list.invalidate();
      utils.conversation.stats.invalidate();
    },
  });
  const unarchiveMutation = trpc.conversation.unarchive.useMutation({
    onSuccess: () => {
      utils.conversation.list.invalidate();
      utils.conversation.stats.invalidate();
    },
  });
  const deleteMutation = trpc.conversation.delete.useMutation({
    onSuccess: () => {
      utils.conversation.list.invalidate();
      utils.conversation.stats.invalidate();
    },
  });

  const agents = (agentQuery.data || []) as Agent[];
  const conversations = (listQuery.data || []) as Conversation[];
  const stats = statsQuery.data;

  const agentMap = useMemo(() => {
    const map = new Map<number, Agent>();
    agents.forEach((a) => map.set(a.id, a));
    return map;
  }, [agents]);

  return (
    <div
      className="min-h-screen pt-16 px-4 md:px-6 max-w-7xl mx-auto"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-black tracking-widest" style={{ color: "var(--text-primary)" }}>
            任务记事板
          </h1>
          <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
            MISSION LOG · AGENT CONVERSATIONS
          </p>
        </div>
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
          新建记事板
        </button>
      </div>

      {/* Stats */}
      <div className="mb-6">
        <StatsCards
          active={stats?.active ?? 0}
          archived={stats?.archived ?? 0}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setTab("active")}
          className="flex items-center gap-2 px-4 py-2 rounded text-xs font-bold font-mono transition-all"
          style={{
            background:
              tab === "active"
                ? "rgba(74,158,255,0.1)"
                : "rgba(255,255,255,0.02)",
            color: tab === "active" ? "var(--accent-cyan)" : "var(--text-muted)",
            border: `1px solid ${
              tab === "active"
                ? "rgba(74,158,255,0.25)"
                : "var(--border-default)"
            }`,
          }}
        >
          📋 进行中
          {stats?.active !== undefined && (
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(74,158,255,0.15)" }}>
              {stats.active}
            </span>
          )}
        </button>
        <button
          onClick={() => setTab("archived")}
          className="flex items-center gap-2 px-4 py-2 rounded text-xs font-bold font-mono transition-all"
          style={{
            background:
              tab === "archived"
                ? "rgba(180,200,255,0.05)"
                : "rgba(255,255,255,0.02)",
            color: tab === "archived" ? "var(--text-secondary)" : "var(--text-muted)",
            border: `1px solid ${
              tab === "archived"
                ? "rgba(180,200,255,0.2)"
                : "var(--border-default)"
            }`,
          }}
        >
          📦 已归档
          {stats?.archived !== undefined && (
            <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: "rgba(180,200,255,0.08)" }}>
              {stats.archived}
            </span>
          )}
        </button>
      </div>

      {/* List */}
      {listQuery.isLoading ? (
        <div className="text-sm font-mono text-center py-12" style={{ color: "var(--text-muted)" }}>
          加载中...
        </div>
      ) : listQuery.isError ? (
        <div className="text-sm" style={{ color: "var(--accent-red)" }}>
          加载失败: {listQuery.error?.message}
        </div>
      ) : conversations.length === 0 ? (
        <div className="glass-panel p-8 text-center sci-border">
          <MessageSquare size={40} className="mx-auto mb-3 opacity-30" style={{ color: "var(--text-muted)" }} />
          <div className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
            {tab === "active" ? "暂无进行中的记事板" : "暂无已归档的记事板"}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {conversations.map((conv) => (
            <ConversationCard
              key={conv.id}
              conv={conv}
              agents={agents}
              onView={() => setDetailId(conv.id)}
              onArchive={() => archiveMutation.mutate({ id: conv.id })}
              onUnarchive={() => unarchiveMutation.mutate({ id: conv.id })}
              onDelete={() => {
                if (window.confirm(`确定要删除记事板「${conv.title}」吗？`)) {
                  deleteMutation.mutate({ id: conv.id });
                }
              }}
            />
          ))}
        </div>
      )}

      {/* Detail Dialog */}
      {detailId !== null && (
        <DetailDialog
          convId={detailId}
          agents={agents}
          open={detailId !== null}
          onClose={() => setDetailId(null)}
        />
      )}

      {/* Create Dialog */}
      <CreateDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        agents={agents}
      />
    </div>
  );
}
