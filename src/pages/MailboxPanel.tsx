/**
 * 天宫 Mailbox 消息面板 — MailboxPanel (P6)
 *
 * 显示 Mailbox 消息列表，支持按助手筛选
 * 页面路由 /mailbox
 */
import { useState, useCallback, useEffect } from "react";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";
import { toast } from "sonner";
import {
  Mail,
  RefreshCw,
  Search,
  Clock,
  CheckCircle,
  AlertCircle,
  Send,
  Inbox,
  X,
  Eye,
  MessageSquarePlus,
} from "lucide-react";

// ═══════════════════════ Types ═══════════════════════

interface Agent {
  id: number;
  agentId: string;
  name: string;
  status: "online" | "busy" | "idle";
}

interface MailboxMessage {
  id: number;
  fromMailboxId: string;
  fromAgentId: number | null;
  toMailboxId: string;
  toAgentId: number;
  type: string;
  status: string;
  subject: string | null;
  body: string | null;
  payload: Record<string, unknown> | null;
  replyToMessageId: number | null;
  artifactId: number | null;
  taskId: number | null;
  threadId: number | null;
  createdAt: string;
  updatedAt: string;
}

// ═══════════════════════ Constants ═══════════════════════

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  unread: { label: "未读", color: "var(--accent-cyan)", bg: "rgba(74,158,255,0.08)", icon: <Mail size={12} /> },
  acknowledged: { label: "已确认", color: "var(--text-muted)", bg: "rgba(180,200,255,0.03)", icon: <CheckCircle size={12} /> },
  working: { label: "处理中", color: "var(--warning)", bg: "var(--accent-glow-gold)", icon: <Clock size={12} /> },
  replied: { label: "已回复", color: "var(--success)", bg: "rgba(76,175,125,0.08)", icon: <Send size={12} /> },
  resolved: { label: "已解决", color: "var(--success)", bg: "rgba(76,175,125,0.06)", icon: <CheckCircle size={12} /> },
  failed: { label: "失败", color: "var(--accent-red)", bg: "var(--accent-glow-red)", icon: <AlertCircle size={12} /> },
};

const TYPE_LABELS: Record<string, string> = {
  direct: "私信",
  mention: "提及",
  question: "提问",
  review_request: "审批请求",
  subtask: "子任务",
  handoff: "交接",
  result_notice: "结果通知",
};

function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function truncateBody(text: string | null, maxLen = 120) {
  if (!text) return "—";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

// ═══════════════════════ Components ═══════════════════════

/** 消息卡片 */
function MessageCard({
  msg,
  onView,
}: {
  msg: MailboxMessage;
  onView: () => void;
}) {
  const sc = STATUS_CONFIG[msg.status] || STATUS_CONFIG.unread;
  const typeLabel = TYPE_LABELS[msg.type] || msg.type;

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
      </div>

      {/* Status + Type */}
      <div className="flex items-center gap-2 mb-2 pr-16">
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1 flex-shrink-0"
          style={{ background: sc.bg, color: sc.color }}
        >
          {sc.icon} {sc.label}
        </span>
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-mono flex-shrink-0"
          style={{ background: "rgba(180,200,255,0.05)", color: "var(--text-muted)" }}
        >
          {typeLabel}
        </span>
        <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>
          #{msg.id}
        </span>
      </div>

      {/* Subject */}
      {msg.subject && (
        <h3
          className="text-sm font-bold truncate mb-2"
          style={{ color: "var(--text-primary)" }}
        >
          {msg.subject}
        </h3>
      )}

      {/* From / To */}
      <div className="flex items-center gap-2 mb-2 text-[11px]" style={{ color: "var(--text-secondary)" }}>
        <span className="font-mono" style={{ color: "var(--text-muted)" }}>FROM</span>
        <span className="font-bold">{msg.fromMailboxId}</span>
        <span style={{ color: "var(--text-muted)" }}>→</span>
        <span className="font-bold">{msg.toMailboxId}</span>
      </div>

      {/* Body preview */}
      <div
        className="text-xs leading-relaxed mb-3"
        style={{ color: "var(--text-secondary)" }}
      >
        {truncateBody(msg.body)}
      </div>

      {/* Footer */}
      <div
        className="flex items-center gap-2 text-[10px] font-mono"
        style={{ color: "var(--text-muted)" }}
      >
        <Clock size={10} />
        <span>{fmtTime(msg.createdAt)}</span>
        {msg.taskId && (
          <>
            <span>·</span>
            <span style={{ color: "var(--accent-gold)" }}>Task #{msg.taskId}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** 消息详情抽屉 */
function MessageDetailDrawer({
  msg,
  open,
  onClose,
}: {
  msg: MailboxMessage;
  open: boolean;
  onClose: () => void;
}) {
  const sc = STATUS_CONFIG[msg.status] || STATUS_CONFIG.unread;
  const typeLabel = TYPE_LABELS[msg.type] || msg.type;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
      style={{ background: "rgba(0,0,0,0.65)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-lg flex flex-col"
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
            <Mail size={18} style={{ color: sc.color }} />
            <div className="min-w-0">
              <h2 className="text-sm font-bold truncate" style={{ color: "var(--text-primary)" }}>
                {msg.subject || "无主题"}
              </h2>
              <div className="flex items-center gap-2 mt-0.5">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1"
                  style={{ background: sc.bg, color: sc.color }}
                >
                  {sc.icon} {sc.label}
                </span>
                <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                  {typeLabel} · #{msg.id}
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
          {/* Meta */}
          <div className="glass-panel p-3 sci-border text-xs font-mono grid grid-cols-2 gap-2 mb-4" style={{ color: "var(--text-muted)" }}>
            <div>
              <span style={{ color: "var(--text-secondary)" }}>From:</span> {msg.fromMailboxId}
            </div>
            <div>
              <span style={{ color: "var(--text-secondary)" }}>To:</span> {msg.toMailboxId}
            </div>
            <div>
              <span style={{ color: "var(--text-secondary)" }}>Type:</span> {msg.type}
            </div>
            <div>
              <span style={{ color: "var(--text-secondary)" }}>Status:</span> {msg.status}
            </div>
            {msg.taskId && (
              <div>
                <span style={{ color: "var(--text-secondary)" }}>Task:</span> #{msg.taskId}
              </div>
            )}
            {msg.threadId && (
              <div>
                <span style={{ color: "var(--text-secondary)" }}>Thread:</span> #{msg.threadId}
              </div>
            )}
            <div className="col-span-2">
              <span style={{ color: "var(--text-secondary)" }}>时间:</span> {fmtTime(msg.createdAt)}
            </div>
          </div>

          {/* Body */}
          {msg.body && (
            <div className="mb-4">
              <div className="section-label mb-2">正文 · BODY</div>
              <pre
                className="terminal-panel p-3 text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-96 overflow-y-auto custom-scrollbar"
                style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}
              >
                {msg.body}
              </pre>
            </div>
          )}

          {/* Payload */}
          {msg.payload && Object.keys(msg.payload).length > 0 && (
            <div className="mb-4">
              <div className="section-label mb-2">附加数据 · PAYLOAD</div>
              <pre
                className="terminal-panel p-3 text-xs leading-relaxed whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto custom-scrollbar"
                style={{ color: "var(--text-secondary)", fontFamily: "monospace" }}
              >
                {JSON.stringify(msg.payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════ Page ═══════════════════════

export default function MailboxPanel() {
  const [selectedMailboxId, setSelectedMailboxId] = useState<string>("");
  const [selectedStatus, setSelectedStatus] = useState<string>("");
  const [detailMsg, setDetailMsg] = useState<MailboxMessage | null>(null);
  const [showSendForm, setShowSendForm] = useState(false);
  const [targetAgentId, setTargetAgentId] = useState<string>("");
  const [messageSubject, setMessageSubject] = useState("");
  const [messageBody, setMessageBody] = useState("");

  const agentQuery = trpc.agent.list.useQuery(undefined, { retry: 1, staleTime: 15000 });
  const agents = (agentQuery.data || []) as Agent[];

  const inboxQuery = trpc.mailbox.inbox.useQuery(
    {
      mailboxId: selectedMailboxId || agents[0]?.agentId || "system",
      status: (selectedStatus || undefined) as MailboxMessage["status"] | undefined,
      limit: 100,
    },
    { enabled: !!(selectedMailboxId || agents[0]?.agentId), retry: 1, staleTime: 5000 }
  );
  const messages = (inboxQuery.data || []) as MailboxMessage[];

  const utils = trpc.useUtils();

  const sendMutation = trpc.mailbox.send.useMutation({
    onSuccess: () => {
      toast.success("消息发送成功");
      setMessageSubject("");
      setMessageBody("");
      setTargetAgentId("");
      setShowSendForm(false);
      utils.mailbox.inbox.invalidate();
    },
    onError: (err) => {
      toast.error(`发送失败: ${err.message}`);
    },
  });

  // Dashboard WebSocket: backend broadcasts mailbox events
  const { lastMessage } = useWebSocket();
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "mailbox_message_sent" || lastMessage.type === "mailbox_message_replied") {
      utils.mailbox.inbox.invalidate();
    }
  }, [lastMessage, utils]);

  const refresh = useCallback(() => {
    utils.mailbox.inbox.invalidate();
  }, [utils]);

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
            消息中心
          </h1>
          <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
            MAILBOX · INBOX / MESSAGES
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSendForm((s) => !s)}
            className="px-3 py-2 rounded text-xs font-mono transition-colors hover:bg-[rgba(74,158,255,0.1)] flex items-center gap-1"
            style={{ color: "var(--accent-cyan)", border: "1px solid var(--accent-cyan)" }}
          >
            <MessageSquarePlus size={12} /> 发送消息
          </button>
          <button
            onClick={refresh}
            className="px-3 py-2 rounded text-xs font-mono transition-colors hover:bg-[rgba(180,200,255,0.05)] flex items-center gap-1"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={12} /> 刷新
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Mailbox selector */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded" style={{ background: "rgba(0,0,0,0.15)", border: "1px solid var(--border-default)" }}>
          <Inbox size={14} style={{ color: "var(--text-muted)" }} />
          <select
            value={selectedMailboxId}
            onChange={(e) => setSelectedMailboxId(e.target.value)}
            className="bg-transparent text-xs outline-none font-mono"
            style={{ color: "var(--text-primary)" }}
          >
            <option value="">选择助手邮箱</option>
            {agents.map((a) => (
              <option key={a.id} value={a.agentId}>
                {a.name} ({a.agentId})
              </option>
            ))}
          </select>
        </div>

        {/* Status filter */}
        <select
          value={selectedStatus}
          onChange={(e) => setSelectedStatus(e.target.value)}
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

        {/* Stats */}
        <div className="flex items-center gap-2 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
          <span className="flex items-center gap-1">
            <Mail size={10} />
            {messages.length} 条消息
          </span>
        </div>
      </div>

      {/* Loading */}
      {inboxQuery.isLoading && (
        <div
          className="text-sm font-mono text-center py-12"
          style={{ color: "var(--text-muted)" }}
        >
          加载消息列表...
        </div>
      )}

      {/* Error */}
      {inboxQuery.isError && (
        <div className="text-sm" style={{ color: "var(--accent-red)" }}>
          加载失败: {inboxQuery.error?.message}
        </div>
      )}

      {/* Empty */}
      {!inboxQuery.isLoading && !inboxQuery.isError && messages.length === 0 && (
        <div className="glass-panel p-8 text-center sci-border">
          <Mail
            size={48}
            className="mx-auto mb-3 opacity-20"
            style={{ color: "var(--text-muted)" }}
          />
          <div className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
            {selectedMailboxId
              ? "该邮箱暂无消息"
              : "请选择助手邮箱查看消息"}
          </div>
        </div>
      )}

      {/* Message Grid */}
      {messages.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {messages.map((msg) => (
            <MessageCard
              key={msg.id}
              msg={msg}
              onView={() => setDetailMsg(msg)}
            />
          ))}
        </div>
      )}

      {/* Send Message Form */}
      {showSendForm && (
        <div className="glass-panel p-5 sci-border mb-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold flex items-center gap-2" style={{ color: "var(--text-primary)" }}>
              <Send size={14} style={{ color: "var(--accent-cyan)" }} />
              发送新消息
            </h3>
            <button
              onClick={() => setShowSendForm(false)}
              className="p-1 rounded hover:bg-[rgba(180,200,255,0.1)]"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={14} />
            </button>
          </div>

          <div className="space-y-3">
            {/* Target Agent */}
            <div>
              <label className="block text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                目标助手 · TO
              </label>
              <select
                value={targetAgentId}
                onChange={(e) => setTargetAgentId(e.target.value)}
                className="w-full px-3 py-2 rounded text-xs outline-none font-mono"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              >
                <option value="">选择目标助手</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.agentId}>
                    {a.name} ({a.agentId})
                  </option>
                ))}
              </select>
            </div>

            {/* Subject */}
            <div>
              <label className="block text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                主题 · SUBJECT
              </label>
              <input
                type="text"
                value={messageSubject}
                onChange={(e) => setMessageSubject(e.target.value)}
                placeholder="输入消息主题..."
                className="w-full px-3 py-2 rounded text-xs outline-none font-mono"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
            </div>

            {/* Body */}
            <div>
              <label className="block text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                内容 · BODY
              </label>
              <textarea
                value={messageBody}
                onChange={(e) => setMessageBody(e.target.value)}
                placeholder="输入消息内容..."
                rows={4}
                className="w-full px-3 py-2 rounded text-xs outline-none font-mono resize-none"
                style={{
                  background: "rgba(0,0,0,0.2)",
                  border: "1px solid var(--border-default)",
                  color: "var(--text-primary)",
                }}
              />
            </div>

            {/* Submit */}
            <div className="flex justify-end">
              <button
                onClick={() => {
                  if (!targetAgentId) {
                    toast.error("请选择目标助手");
                    return;
                  }
                  if (!messageBody.trim()) {
                    toast.error("请输入消息内容");
                    return;
                  }
                  sendMutation.mutate({
                    toMailboxId: targetAgentId,
                    subject: messageSubject || undefined,
                    body: messageBody,
                    type: "direct",
                  });
                }}
                disabled={sendMutation.isPending}
                className="px-4 py-2 rounded text-xs font-mono transition-colors flex items-center gap-1 disabled:opacity-50"
                style={{
                  background: "var(--accent-cyan)",
                  color: "#000",
                }}
              >
                {sendMutation.isPending ? (
                  <>
                    <RefreshCw size={12} className="animate-spin" /> 发送中...
                  </>
                ) : (
                  <>
                    <Send size={12} /> 发送
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Detail Drawer */}
      {detailMsg && (
        <MessageDetailDrawer
          msg={detailMsg}
          open={detailMsg !== null}
          onClose={() => setDetailMsg(null)}
        />
      )}
    </div>
  );
}
