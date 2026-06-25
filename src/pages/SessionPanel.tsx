/**
 * 天宫 共享会话面板 — SessionPanel
 *
 * 多 Agent 共享会话管理：查看会话列表、消息历史、发送消息、创建新会话
 * 页面路由 /sessions
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";
import { toast } from "sonner";
import {
  MessageSquare,
  RefreshCw,
  Send,
  Plus,
  Clock,
  Users,
  X,
  ChevronRight,
  Hash,
  MessageCircle,
  Bot,
  User,
  Settings,
  Radio,
} from "lucide-react";

// ═══════════════════════ Types ═══════════════════════

interface Agent {
  id: number;
  agentId: string;
  name: string;
  status: "online" | "busy" | "idle";
}

interface SharedSession {
  id: number;
  title: string;
  sessionKey: string;
  type: "collaboration" | "handoff" | "meeting" | "review" | "adhoc";
  status: "active" | "archived";
  participants: string | null;
  summary: string | null;
  context: string | null;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
}

interface SessionMessage {
  id: number;
  sessionId: number;
  fromAgentId: number | null;
  toAgentId: number | null;
  role: "user" | "assistant" | "system";
  content: string;
  metadata: string | null;
  createdAt: string;
}

// ═══════════════════════ Constants ═══════════════════════

const TYPE_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  collaboration: { label: "协作", color: "var(--accent-cyan)", bg: "rgba(74,158,255,0.08)" },
  handoff: { label: "交接", color: "var(--accent-gold)", bg: "rgba(201,168,76,0.08)" },
  meeting: { label: "会议", color: "var(--success)", bg: "rgba(76,175,125,0.08)" },
  review: { label: "审查", color: "var(--accent-red)", bg: "rgba(194,58,48,0.08)" },
  adhoc: { label: "临时", color: "var(--text-muted)", bg: "rgba(180,200,255,0.05)" },
};

const ROLE_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  user: { label: "用户", color: "var(--accent-cyan)", bg: "rgba(74,158,255,0.08)", icon: <User size={10} /> },
  assistant: { label: "助手", color: "var(--success)", bg: "rgba(76,175,125,0.08)", icon: <Bot size={10} /> },
  system: { label: "系统", color: "var(--accent-gold)", bg: "rgba(201,168,76,0.08)", icon: <Settings size={10} /> },
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseParticipants(parts: string | null): number[] {
  if (!parts) return [];
  try {
    const parsed = JSON.parse(parts);
    if (Array.isArray(parsed)) return parsed.filter((n): n is number => typeof n === "number");
  } catch {
    // ignore
  }
  return [];
}

// ═══════════════════════ Components ═══════════════════════

/** 会话列表项 */
function SessionListItem({
  session,
  isSelected,
  agents,
  onClick,
}: {
  session: SharedSession;
  isSelected: boolean;
  agents: Agent[];
  onClick: () => void;
}) {
  const tc = TYPE_CONFIG[session.type] || TYPE_CONFIG.adhoc;
  const participantIds = parseParticipants(session.participants);
  const participantCount = participantIds.length;

  return (
    <button
      onClick={onClick}
      className="w-full text-left transition-all group"
      style={{
        padding: "12px 14px",
        borderBottom: "1px solid var(--border-default)",
        background: isSelected ? "rgba(74,158,255,0.06)" : "transparent",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1.5">
            <span
              className="text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0"
              style={{ background: tc.bg, color: tc.color }}
            >
              {tc.label}
            </span>
            {isSelected && (
              <ChevronRight size={12} style={{ color: "var(--accent-cyan)" }} className="flex-shrink-0" />
            )}
          </div>
          <h3
            className="text-xs font-bold truncate mb-1"
            style={{ color: "var(--text-primary)" }}
          >
            {session.title}
          </h3>
          <div className="flex items-center gap-3 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            <span className="flex items-center gap-1">
              <Users size={10} />
              {participantCount}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {fmtTime(session.updatedAt)}
            </span>
          </div>
        </div>
      </div>
    </button>
  );
}

/** 消息气泡 */
function MessageBubble({
  msg,
  agents,
}: {
  msg: SessionMessage;
  agents: Agent[];
}) {
  const rc = ROLE_CONFIG[msg.role] || ROLE_CONFIG.assistant;
  const sender = msg.fromAgentId
    ? agents.find((a) => a.id === msg.fromAgentId)
    : null;
  const senderName = sender?.name || (msg.role === "user" ? "用户" : msg.role === "system" ? "系统" : "未知");

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1 flex-shrink-0"
          style={{ background: rc.bg, color: rc.color }}
        >
          {rc.icon} {rc.label}
        </span>
        <span className="text-[11px] font-bold" style={{ color: "var(--text-secondary)" }}>
          {senderName}
        </span>
        <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
          {fmtDateTime(msg.createdAt)}
        </span>
      </div>
      <div
        className="text-xs leading-relaxed whitespace-pre-wrap"
        style={{ color: "var(--text-secondary)" }}
      >
        {msg.content}
      </div>
    </div>
  );
}

/** 新建会话对话框 */
function NewSessionDialog({
  open,
  onClose,
  agents,
}: {
  open: boolean;
  onClose: () => void;
  agents: Agent[];
}) {
  const [title, setTitle] = useState("");
  const [type, setType] = useState<"collaboration" | "handoff" | "meeting" | "review" | "adhoc">("adhoc");
  const [selectedAgentIds, setSelectedAgentIds] = useState<number[]>([]);

  const utils = trpc.useUtils();
  const createMutation = trpc.session.create.useMutation({
    onSuccess: (data) => {
      toast.success("会话创建成功");
      utils.session.list.invalidate();
      setTitle("");
      setSelectedAgentIds([]);
      setType("adhoc");
      onClose();
      // Auto-select the new session would need parent state lift, handled by list refresh + user click
    },
    onError: (err) => {
      toast.error(`创建失败: ${err.message}`);
    },
  });

  if (!open) return null;

  const toggleAgent = (id: number) => {
    setSelectedAgentIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4"
      style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg flex flex-col"
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
          <h3 className="text-sm font-bold flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
            <MessageSquare size={14} style={{ color: "var(--accent-cyan)" }} />
            新建会话
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[rgba(180,200,255,0.1)]"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
              标题 · TITLE
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="输入会话标题..."
              className="w-full px-3 py-2 rounded text-xs outline-none font-mono"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
              类型 · TYPE
            </label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as typeof type)}
              className="w-full px-3 py-2 rounded text-xs outline-none font-mono"
              style={{
                background: "rgba(0,0,0,0.2)",
                border: "1px solid var(--border-default)",
                color: "var(--text-primary)",
              }}
            >
              {Object.entries(TYPE_CONFIG).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>

          {/* Participants */}
          <div>
            <label className="block text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
              参与者 · PARTICIPANTS ({selectedAgentIds.length})
            </label>
            <div className="flex flex-wrap gap-2">
              {agents.map((agent) => {
                const selected = selectedAgentIds.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    onClick={() => toggleAgent(agent.id)}
                    className="text-[10px] px-2 py-1 rounded font-mono transition-colors flex items-center gap-1"
                    style={{
                      background: selected ? "rgba(74,158,255,0.15)" : "rgba(0,0,0,0.15)",
                      border: `1px solid ${selected ? "var(--accent-cyan)" : "var(--border-default)"}`,
                      color: selected ? "var(--accent-cyan)" : "var(--text-muted)",
                    }}
                  >
                    <Bot size={10} />
                    {agent.name}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex justify-end gap-2 px-5 py-3 flex-shrink-0"
          style={{ borderTop: "1px solid var(--border-default)" }}
        >
          <button
            onClick={onClose}
            className="px-3 py-2 rounded text-xs font-mono transition-colors"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            取消
          </button>
          <button
            onClick={() => {
              if (!title.trim()) {
                toast.error("请输入会话标题");
                return;
              }
              createMutation.mutate({
                title: title.trim(),
                type,
                participants: selectedAgentIds.length > 0 ? selectedAgentIds : undefined,
              });
            }}
            disabled={createMutation.isPending}
            className="px-4 py-2 rounded text-xs font-mono transition-colors flex items-center gap-1 disabled:opacity-50"
            style={{ background: "var(--accent-cyan)", color: "#000" }}
          >
            {createMutation.isPending ? (
              <>
                <RefreshCw size={12} className="animate-spin" /> 创建中...
              </>
            ) : (
              <>
                <Plus size={12} /> 创建会话
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════ Page ═══════════════════════

export default function SessionPanel() {
  const [selectedSessionId, setSelectedSessionId] = useState<number | null>(null);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [inputText, setInputText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agentQuery = trpc.agent.list.useQuery(undefined, { retry: 1, staleTime: 15000 });
  const agents = (agentQuery.data || []) as Agent[];

  const sessionListQuery = trpc.session.list.useQuery({ status: "active" }, { retry: 1, staleTime: 5000 });
  const sessions = (sessionListQuery.data || []) as SharedSession[];

  const messagesQuery = trpc.session.getMessages.useQuery(
    { sessionId: selectedSessionId || 0, limit: 100 },
    { enabled: selectedSessionId !== null, retry: 1, staleTime: 3000 }
  );
  const rawMessages = (messagesQuery.data || []) as SessionMessage[];
  // Backend returns desc order; reverse to chronological for display
  const messages = [...rawMessages].reverse();

  const utils = trpc.useUtils();

  const sendMutation = trpc.session.sendMessage.useMutation({
    onSuccess: () => {
      setInputText("");
      utils.session.getMessages.invalidate({ sessionId: selectedSessionId || 0, limit: 100 });
      utils.session.list.invalidate();
    },
    onError: (err) => {
      toast.error(`发送失败: ${err.message}`);
    },
  });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  // WebSocket: invalidate on new session or message events
  const { lastMessage } = useWebSocket();
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "session_created") {
      utils.session.list.invalidate();
    }
    if (lastMessage.type === "session_message") {
      if (lastMessage.sessionId === selectedSessionId) {
        utils.session.getMessages.invalidate({ sessionId: selectedSessionId, limit: 100 });
      }
      utils.session.list.invalidate();
    }
  }, [lastMessage, selectedSessionId, utils]);

  const selectedSession = sessions.find((s) => s.id === selectedSessionId) || null;

  const handleSend = useCallback(() => {
    if (!selectedSessionId || !inputText.trim()) return;
    sendMutation.mutate({
      sessionId: selectedSessionId,
      role: "user",
      content: inputText.trim(),
    });
  }, [selectedSessionId, inputText, sendMutation]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div
      className="min-h-screen pt-16 flex"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {/* ─── Left Panel: Session List ─── */}
      <div
        className="flex-shrink-0 flex flex-col border-r"
        style={{
          width: 300,
          borderColor: "var(--border-default)",
          background: "var(--bg-secondary)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <div>
            <h1
              className="text-sm font-black tracking-widest"
              style={{ color: "var(--text-primary)" }}
            >
              会话中心
            </h1>
            <p className="text-[10px] mt-0.5 font-mono" style={{ color: "var(--text-muted)" }}>
              SESSIONS · SHARED
            </p>
          </div>
          <button
            onClick={() => setShowNewDialog(true)}
            className="p-2 rounded transition-colors hover:bg-[rgba(74,158,255,0.1)]"
            style={{ color: "var(--accent-cyan)", border: "1px solid var(--accent-cyan)" }}
            title="新建会话"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Stats */}
        <div
          className="px-4 py-2 flex items-center gap-3 text-[10px] font-mono flex-shrink-0"
          style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border-default)" }}
        >
          <span className="flex items-center gap-1">
            <MessageSquare size={10} />
            {sessions.length} 会话
          </span>
          <span className="flex items-center gap-1">
            <Radio size={10} />
            {agents.filter((a) => a.status === "online").length} 在线
          </span>
        </div>

        {/* Session List */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {sessionListQuery.isLoading && (
            <div className="text-xs font-mono text-center py-8" style={{ color: "var(--text-muted)" }}>
              加载会话列表...
            </div>
          )}
          {!sessionListQuery.isLoading && sessions.length === 0 && (
            <div className="p-6 text-center">
              <MessageCircle
                size={36}
                className="mx-auto mb-2 opacity-20"
                style={{ color: "var(--text-muted)" }}
              />
              <div className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
                暂无活跃会话
              </div>
              <button
                onClick={() => setShowNewDialog(true)}
                className="mt-3 text-[10px] font-mono px-3 py-1.5 rounded"
                style={{ color: "var(--accent-cyan)", border: "1px solid var(--accent-cyan)" }}
              >
                创建第一个会话
              </button>
            </div>
          )}
          {sessions.map((session) => (
            <SessionListItem
              key={session.id}
              session={session}
              isSelected={session.id === selectedSessionId}
              agents={agents}
              onClick={() => setSelectedSessionId(session.id)}
            />
          ))}
        </div>
      </div>

      {/* ─── Right Panel: Messages ─── */}
      <div className="flex-1 flex flex-col min-w-0">
        {selectedSession ? (
          <>
            {/* Message Header */}
            <div
              className="flex items-center justify-between px-5 py-3 flex-shrink-0"
              style={{ borderBottom: "1px solid var(--border-default)", background: "var(--bg-secondary)" }}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0"
                    style={{
                      background: (TYPE_CONFIG[selectedSession.type] || TYPE_CONFIG.adhoc).bg,
                      color: (TYPE_CONFIG[selectedSession.type] || TYPE_CONFIG.adhoc).color,
                    }}
                  >
                    {(TYPE_CONFIG[selectedSession.type] || TYPE_CONFIG.adhoc).label}
                  </span>
                  <h2 className="text-sm font-bold truncate" style={{ color: "var(--text-primary)" }}>
                    {selectedSession.title}
                  </h2>
                </div>
                <div className="flex items-center gap-3 mt-1 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                  <span className="flex items-center gap-1">
                    <Hash size={10} />
                    {selectedSession.sessionKey}
                  </span>
                  <span className="flex items-center gap-1">
                    <Users size={10} />
                    {parseParticipants(selectedSession.participants).length} 参与者
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    {fmtDateTime(selectedSession.updatedAt)}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setSelectedSessionId(null)}
                className="p-1.5 rounded hover:bg-[rgba(180,200,255,0.1)] flex-shrink-0"
                style={{ color: "var(--text-muted)" }}
              >
                <X size={14} />
              </button>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-5">
              {messagesQuery.isLoading && (
                <div className="text-xs font-mono text-center py-8" style={{ color: "var(--text-muted)" }}>
                  加载消息...
                </div>
              )}
              {!messagesQuery.isLoading && messages.length === 0 && (
                <div className="text-center py-12">
                  <MessageCircle
                    size={40}
                    className="mx-auto mb-3 opacity-20"
                    style={{ color: "var(--text-muted)" }}
                  />
                  <div className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
                    暂无消息，开始对话吧
                  </div>
                </div>
              )}
              {messages.map((msg) => (
                <MessageBubble key={msg.id} msg={msg} agents={agents} />
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div
              className="px-5 py-3 flex-shrink-0"
              style={{ borderTop: "1px solid var(--border-default)", background: "var(--bg-secondary)" }}
            >
              <div className="flex items-end gap-2">
                <textarea
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
                  rows={1}
                  className="flex-1 px-3 py-2 rounded text-xs outline-none font-mono resize-none min-h-[36px] max-h-[120px]"
                  style={{
                    background: "rgba(0,0,0,0.2)",
                    border: "1px solid var(--border-default)",
                    color: "var(--text-primary)",
                  }}
                  onInput={(e) => {
                    const target = e.target as HTMLTextAreaElement;
                    target.style.height = "auto";
                    target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
                  }}
                />
                <button
                  onClick={handleSend}
                  disabled={!inputText.trim() || sendMutation.isPending}
                  className="px-4 py-2 rounded text-xs font-mono transition-colors flex items-center gap-1 disabled:opacity-50 flex-shrink-0"
                  style={{
                    background: "var(--accent-cyan)",
                    color: "#000",
                  }}
                >
                  {sendMutation.isPending ? (
                    <RefreshCw size={12} className="animate-spin" />
                  ) : (
                    <Send size={12} />
                  )}
                </button>
              </div>
            </div>
          </>
        ) : (
          /* Empty State */
          <div className="flex-1 flex flex-col items-center justify-center">
            <MessageSquare
              size={64}
              className="mb-4 opacity-10"
              style={{ color: "var(--text-muted)" }}
            />
            <div className="text-sm font-mono mb-2" style={{ color: "var(--text-muted)" }}>
              选择一个会话开始交流
            </div>
            <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)", opacity: 0.6 }}>
              SELECT A SESSION TO VIEW MESSAGES
            </div>
          </div>
        )}
      </div>

      {/* New Session Dialog */}
      <NewSessionDialog
        open={showNewDialog}
        onClose={() => setShowNewDialog(false)}
        agents={agents}
      />
    </div>
  );
}
