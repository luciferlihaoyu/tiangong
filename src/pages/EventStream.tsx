/**
 * P10.2: 事件流 — 实时事件监控
 *
 * 通过 WebSocket 接收统一事件，实时展示。
 * 支持按类型筛选、按 traceId 串联查看。
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import {
  Activity,
  Filter,
  Search,
  X,
  Play,
  CheckCircle2,
  XCircle,
  Clock,
  AlertTriangle,
  Shield,
  Scale,
  MessageSquare,
  Server,
  Zap,
  RefreshCw,
  Trash2,
  Pause,
} from "lucide-react";

/* ═══════════════════════════════════════════
   类型定义
   ═══════════════════════════════════════════ */

interface EventEnvelope {
  type: string;
  eventId: string;
  traceId?: string;
  sourceAgentId?: number;
  targetAgentId?: number;
  taskId?: number;
  messageId?: number;
  modelCallId?: number;
  sourceSystem?: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

const MAX_EVENTS = 500;

/* ═══════════════════════════════════════════
   事件分类与样式
   ═══════════════════════════════════════════ */

const EVENT_CATEGORIES: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  "agent.online": { label: "Agent 上线", color: "var(--success)", icon: <Server size={12} /> },
  "agent.offline": { label: "Agent 下线", color: "var(--danger)", icon: <Server size={12} /> },
  "agent.busy": { label: "Agent 忙碌", color: "var(--accent-gold)", icon: <Clock size={12} /> },
  "agent.idle": { label: "Agent 空闲", color: "var(--text-muted)", icon: <Activity size={12} /> },
  "task.created": { label: "任务创建", color: "var(--accent-cyan)", icon: <Play size={12} /> },
  "task.started": { label: "任务开始", color: "var(--accent-cyan)", icon: <Play size={12} /> },
  "task.completed": { label: "任务完成", color: "var(--success)", icon: <CheckCircle2 size={12} /> },
  "task.failed": { label: "任务失败", color: "var(--danger)", icon: <XCircle size={12} /> },
  "task.unblocked": { label: "任务解锁", color: "var(--accent-gold)", icon: <CheckCircle2 size={12} /> },
  "message.sent": { label: "消息发送", color: "var(--accent-cyan)", icon: <MessageSquare size={12} /> },
  "message.delivered": { label: "消息送达", color: "var(--success)", icon: <MessageSquare size={12} /> },
  "message.acked": { label: "消息确认", color: "var(--accent-gold)", icon: <MessageSquare size={12} /> },
  "model.call.started": { label: "模型调用", color: "var(--accent-cyan)", icon: <Zap size={12} /> },
  "model.call.completed": { label: "模型完成", color: "var(--success)", icon: <Zap size={12} /> },
  "model.high_cost_alert": { label: "高价告警", color: "var(--danger)", icon: <AlertTriangle size={12} /> },
  "fusion.submitted": { label: "审查提交", color: "var(--accent-gold)", icon: <Scale size={12} /> },
  "fusion.review_completed": { label: "审查完成", color: "var(--accent-cyan)", icon: <Scale size={12} /> },
  "fusion.completed": { label: "审查裁决", color: "var(--accent-gold)", icon: <Scale size={12} /> },
  "system.error": { label: "系统错误", color: "var(--danger)", icon: <AlertTriangle size={12} /> },
  "system.migration": { label: "数据库迁移", color: "var(--accent-gold)", icon: <Shield size={12} /> },
};

function getEventStyle(type: string) {
  return EVENT_CATEGORIES[type] || {
    label: type,
    color: "var(--text-muted)",
    icon: <Activity size={12} />,
  };
}

/* ═══════════════════════════════════════════
   辅助函数
   ═══════════════════════════════════════════ */

function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ═══════════════════════════════════════════
   事件条目组件
   ═══════════════════════════════════════════ */

function EventRow({
  event,
  selected,
  onClick,
}: {
  event: EventEnvelope;
  selected: boolean;
  onClick: () => void;
}) {
  const style = getEventStyle(event.type);
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="py-1.5 px-2 rounded text-[10px] font-mono cursor-pointer transition-colors"
      style={{
        background: selected
          ? "rgba(74,158,255,0.05)"
          : event.type.includes("error") || event.type.includes("alert")
            ? "rgba(255,80,80,0.03)"
            : "transparent",
        border: selected
          ? "1px solid rgba(74,158,255,0.2)"
          : "1px solid transparent",
      }}
      onClick={onClick}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ color: style.color }}>{style.icon}</span>
          <span style={{ color: style.color }} className="font-medium">
            {style.label}
          </span>
          {event.traceId && (
            <span
              className="text-[9px] px-1 py-0.5 rounded cursor-pointer hover:bg-[rgba(74,158,255,0.1)]"
              style={{ background: "rgba(74,158,255,0.05)", color: "var(--accent-cyan)" }}
              title={event.traceId}
            >
              #{event.traceId.slice(0, 12)}
            </span>
          )}
          {!!event.payload?.model && (
            <span style={{ color: "var(--text-secondary)" }} className="truncate max-w-24">
              {event.payload.model as string}
            </span>
          )}
          {!!event.payload?.name && (
            <span style={{ color: "var(--text-secondary)" }} className="truncate max-w-24">
              {(event.payload.name as string).slice(0, 20)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {event.sourceAgentId && (
            <span style={{ color: "var(--text-muted)" }}>#{event.sourceAgentId}</span>
          )}
          {!!event.payload?.costCents && (
            <span style={{ color: "var(--accent-gold)" }}>
              ${(Number(event.payload.costCents) / 100).toFixed(2)}
            </span>
          )}
          <span style={{ color: "var(--text-muted)" }}>{fmtTime(event.timestamp)}</span>
        </div>
      </div>

      {expanded && (
        <div className="mt-1.5 ml-5 space-y-0.5">
          <div style={{ color: "var(--text-muted)" }}>
            Event ID: {event.eventId}
          </div>
          {event.traceId && (
            <div style={{ color: "var(--accent-cyan)" }}>
              Trace ID: {event.traceId}
            </div>
          )}
          {event.payload && Object.keys(event.payload).length > 0 && (
            <div
              className="p-1.5 rounded text-[9px] mt-1 overflow-x-auto"
              style={{ background: "rgba(0,0,0,0.2)" }}
            >
              <pre style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>
                {JSON.stringify(event.payload, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* 点击展开/收起 */}
      <div
        className="mt-0.5 ml-5 text-[8px] cursor-pointer"
        style={{ color: "var(--text-muted)" }}
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
      >
        {expanded ? "收起 ▲" : "展开 ▼"}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   主页面
   ═══════════════════════════════════════════ */

export default function EventStream() {
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<string>("");
  const [traceFilter, setTraceFilter] = useState<string>("");
  const [selectedEvent, setSelectedEvent] = useState<EventEnvelope | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 使用现有的 WebSocket hook 连接 Dashboard 端点
  const ws = useWebSocket();

  // 接收事件
  useEffect(() => {
    if (!ws) return;

    const handler = (event: MessageEvent) => {
      if (paused) return;
      try {
        const data = JSON.parse(event.data);
        if (data.type && data.eventId) {
          // 是标准事件
          setEvents((prev) => {
            const next = [data as EventEnvelope, ...prev];
            return next.slice(0, MAX_EVENTS);
          });
        } else if (data.type && !data.eventId) {
          // 可能是旧格式事件，包装成标准格式
          setEvents((prev) => {
            const wrapped: EventEnvelope = {
              type: data.type,
              eventId: `legacy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
              timestamp: data.timestamp || new Date().toISOString(),
              payload: data,
            };
            const next = [wrapped, ...prev];
            return next.slice(0, MAX_EVENTS);
          });
        }
      } catch {}
    };

    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [ws, paused]);

  // 自动滚动到顶部
  useEffect(() => {
    if (listRef.current && !paused) {
      listRef.current.scrollTop = 0;
    }
  }, [events, paused]);

  // 筛选
  const filteredEvents = events.filter((e) => {
    if (filter && !e.type.includes(filter)) return false;
    if (traceFilter && !e.traceId?.includes(traceFilter)) return false;
    return true;
  });

  // 按 traceId 分组（用于串联查看）
  const traceGroups = useCallback(() => {
    const groups: Record<string, EventEnvelope[]> = {};
    for (const e of filteredEvents) {
      if (e.traceId) {
        if (!groups[e.traceId]) groups[e.traceId] = [];
        groups[e.traceId].push(e);
      }
    }
    return groups;
  }, [filteredEvents]);

  const groups = traceGroups();

  const clearEvents = () => {
    setEvents([]);
    setSelectedEvent(null);
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              事件流
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              实时事件监控 · traceId 串联 · 全链路追踪
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPaused(!paused)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono"
              style={{
                background: paused ? "rgba(255,200,50,0.1)" : "rgba(255,255,255,0.03)",
                border: `1px solid ${paused ? "rgba(255,200,50,0.3)" : "var(--border-default)"}`,
                color: paused ? "var(--accent-gold)" : "var(--text-muted)",
              }}
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? "继续" : "暂停"}
            </button>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono"
              style={{
                background: showFilters ? "rgba(74,158,255,0.1)" : "rgba(255,255,255,0.03)",
                border: `1px solid ${showFilters ? "rgba(74,158,255,0.3)" : "var(--border-default)"}`,
                color: showFilters ? "var(--accent-cyan)" : "var(--text-muted)",
              }}
            >
              <Filter size={14} /> 筛选
            </button>
            <button
              onClick={clearEvents}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono"
              style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
            >
              <Trash2 size={14} /> 清空
            </button>
          </div>
        </div>

        {/* 统计 */}
        <div className="flex items-center gap-4 mb-4 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
          <span>总事件: {events.length}</span>
          <span>筛选后: {filteredEvents.length}</span>
          <span>Trace 分组: {Object.keys(groups).length}</span>
          <span>状态: {paused ? "⏸ 已暂停" : "▶ 接收中"}</span>
        </div>

        {/* 筛选栏 */}
        {showFilters && (
          <div className="glass-panel p-3 sci-border mb-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div>
                <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
                  事件类型
                </label>
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="例: task., model., fusion."
                  className="px-2 py-1.5 rounded text-[10px] outline-none font-mono"
                  style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "200px" }}
                />
              </div>
              <div>
                <label className="text-[9px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
                  Trace ID
                </label>
                <input
                  type="text"
                  value={traceFilter}
                  onChange={(e) => setTraceFilter(e.target.value)}
                  placeholder="按 traceId 筛选..."
                  className="px-2 py-1.5 rounded text-[10px] outline-none font-mono"
                  style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)", width: "200px" }}
                />
              </div>
              {(filter || traceFilter) && (
                <button
                  onClick={() => {
                    setFilter("");
                    setTraceFilter("");
                  }}
                  className="flex items-center gap-1 px-2 py-1.5 rounded text-[10px] font-mono"
                  style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
                >
                  <X size={12} /> 清除
                </button>
              )}
            </div>
          </div>
        )}

        {/* 主内容区 */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* 事件列表 */}
          <div className="lg:col-span-2">
            <div
              ref={listRef}
              className="glass-panel p-3 sci-border overflow-y-auto"
              style={{ maxHeight: "70vh" }}
            >
              {filteredEvents.length === 0 ? (
                <div className="text-xs py-8 text-center" style={{ color: "var(--text-muted)" }}>
                  {events.length === 0 ? "等待事件..." : "没有匹配的事件"}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {filteredEvents.map((e) => (
                    <EventRow
                      key={e.eventId}
                      event={e}
                      selected={selectedEvent?.eventId === e.eventId}
                      onClick={() => setSelectedEvent(e)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 右侧面板 */}
          <div className="lg:col-span-1 space-y-4">
            {/* 选中事件详情 */}
            {selectedEvent && (
              <div className="glass-panel p-3 sci-border">
                <div className="text-[10px] font-mono mb-2 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                  事件详情
                </div>
                <div className="space-y-1.5 text-[10px] font-mono">
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>类型: </span>
                    <span style={{ color: getEventStyle(selectedEvent.type).color }}>
                      {selectedEvent.type}
                    </span>
                  </div>
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>Event ID: </span>
                    <span style={{ color: "var(--text-primary)" }}>{selectedEvent.eventId}</span>
                  </div>
                  {selectedEvent.traceId && (
                    <div>
                      <span style={{ color: "var(--text-muted)" }}>Trace ID: </span>
                      <span style={{ color: "var(--accent-cyan)" }}>{selectedEvent.traceId}</span>
                    </div>
                  )}
                  {selectedEvent.sourceAgentId && (
                    <div>
                      <span style={{ color: "var(--text-muted)" }}>来源 Agent: </span>
                      <span style={{ color: "var(--text-primary)" }}>#{selectedEvent.sourceAgentId}</span>
                    </div>
                  )}
                  {selectedEvent.taskId && (
                    <div>
                      <span style={{ color: "var(--text-muted)" }}>任务 ID: </span>
                      <span style={{ color: "var(--text-primary)" }}>#{selectedEvent.taskId}</span>
                    </div>
                  )}
                  <div>
                    <span style={{ color: "var(--text-muted)" }}>时间: </span>
                    <span style={{ color: "var(--text-primary)" }}>{fmtDateTime(selectedEvent.timestamp)}</span>
                  </div>
                  {selectedEvent.payload && Object.keys(selectedEvent.payload).length > 0 && (
                    <div
                      className="p-2 rounded mt-1 overflow-x-auto"
                      style={{ background: "rgba(0,0,0,0.2)" }}
                    >
                      <pre style={{ color: "var(--text-secondary)", whiteSpace: "pre-wrap", fontSize: "9px" }}>
                        {JSON.stringify(selectedEvent.payload, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Trace 分组 */}
            {Object.keys(groups).length > 0 && (
              <div className="glass-panel p-3 sci-border">
                <div className="text-[10px] font-mono mb-2 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                  Trace 分组
                </div>
                <div className="space-y-1 max-h-60 overflow-y-auto custom-scrollbar">
                  {Object.entries(groups)
                    .sort(([, a], [, b]) => b[0].timestamp.localeCompare(a[0].timestamp))
                    .slice(0, 20)
                    .map(([traceId, evts]) => (
                      <button
                        key={traceId}
                        onClick={() => setTraceFilter(traceId)}
                        className="w-full text-left p-1.5 rounded text-[9px] font-mono hover:bg-[rgba(74,158,255,0.03)]"
                        style={{
                          background:
                            traceFilter === traceId
                              ? "rgba(74,158,255,0.05)"
                              : "rgba(255,255,255,0.01)",
                          border:
                            traceFilter === traceId
                              ? "1px solid rgba(74,158,255,0.2)"
                              : "1px solid rgba(255,255,255,0.03)",
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span style={{ color: "var(--accent-cyan)" }}>
                            #{traceId.slice(0, 16)}
                          </span>
                          <span style={{ color: "var(--text-muted)" }}>{evts.length} 事件</span>
                        </div>
                        <div className="flex gap-1 mt-0.5 flex-wrap">
                          {Array.from(new Set(evts.map((e) => e.type))).map((t) => (
                            <span
                              key={t}
                              className="text-[7px] px-1 py-0.5 rounded"
                              style={{
                                background: `${getEventStyle(t).color}15`,
                                color: getEventStyle(t).color,
                              }}
                            >
                              {t.split(".").pop()}
                            </span>
                          ))}
                        </div>
                      </button>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
