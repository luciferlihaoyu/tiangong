/**
 * P10.2: 事件流 — 实时事件监控
 *
 * 通过 WebSocket 接收统一事件，实时展示。
 * 支持按类型筛选、按 traceId 串联查看。
 *
 * 审计修复（2026-02，碧霄）——原实现的两个硬伤：
 *  ① 全文件只挂 useWebSocket()、零 trpc 调用 → 刷新页面即清空，事件只活在
 *     内存里；后端 api/events-router.ts 的 unifiedList（keyset 游标分页，
 *     合并 audit / task_messages / token_usage 三类事件）根本没人用。
 *  ② 暂停时 handler 里 `if (paused) return;` 直接丢弃事件 → 恢复后那段空白
 *     再也拿不回来。
 * 现改为「后端历史回看 + WS 实时流」双源合并：
 *  - 挂载先拉一页历史（unifiedList，limit=HISTORY_PAGE_SIZE），与实时事件按
 *    时间倒序合并、按 eventId 去重；「加载更早的事件」按游标翻页；
 *  - 暂停期间新事件进 pending 缓冲，恢复时一次性并入，不再丢弃；
 *  - unifiedList 是 admin-only（非管理员后端抛 FORBIDDEN），故用 enabled 精准
 *    关闭并对非管理员给出说明——实时流不受影响，也不报红错。
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/providers/trpc";
import { useAdminGate } from "@/components/AdminGate";
import { useWebSocket } from "@/hooks/useWebSocket";
import { fmtTimeSec } from "@/lib/format";
import type { AppRouter } from "../../api/router";
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
  Send,
  Inbox,
  GitBranch,
  Mail,
  Radio,
  UserCheck,
  UserPlus,
  Bell,
  Wifi,
  WifiOff,
  // 历史回看（unifiedList）新增：翻页 / 重载 / 加载态图标
  ChevronDown,
  History,
  Loader2,
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
/** 历史回看每页条数（后端 unifiedList 的 limit 上限是 100，取 50 兼顾首屏与翻页粒度） */
const HISTORY_PAGE_SIZE = 50;

type RouterOutputs = inferRouterOutputs<AppRouter>;
/** 后端 events.unifiedList 的单页返回：{ items: 判别联合[], nextCursor: string|null } */
type UnifiedEventPage = RouterOutputs["events"]["unifiedList"];
type UnifiedEventItem = UnifiedEventPage["items"][number];

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

  // ── A2A 协议事件（后端实际 broadcast 短名） ──
  a2a_dispatch: { label: "A2A 派发", color: "var(--accent-cyan)", icon: <Send size={12} /> },
  a2a_ack: { label: "A2A 确认", color: "var(--accent-cyan)", icon: <CheckCircle2 size={12} /> },
  a2a_submit: { label: "A2A 提交", color: "var(--accent-cyan)", icon: <Play size={12} /> },
  a2a_complete: { label: "A2A 完成", color: "var(--success)", icon: <CheckCircle2 size={12} /> },
  a2a_fail: { label: "A2A 失败", color: "var(--danger)", icon: <XCircle size={12} /> },

  // ── 任务 / 状态 ──
  task_update: { label: "任务更新", color: "var(--accent-cyan)", icon: <RefreshCw size={12} /> },
  task_notification: { label: "任务通知", color: "var(--accent-cyan)", icon: <Bell size={12} /> },

  // ── Agent 状态（后端通用 agent_status） ──
  agent_status: { label: "Agent 状态", color: "var(--accent-gold)", icon: <Activity size={12} /> },

  // ── 会话 ──
  session_created: { label: "会话创建", color: "var(--accent-cyan)", icon: <UserPlus size={12} /> },
  session_message: { label: "会话消息", color: "var(--accent-cyan)", icon: <MessageSquare size={12} /> },

  // ── 消息 / 邮件 ──
  new_message: { label: "新消息", color: "var(--accent-cyan)", icon: <MessageSquare size={12} /> },
  message_acked: { label: "消息已确认", color: "var(--accent-gold)", icon: <MessageSquare size={12} /> },
  message_read: { label: "消息已读", color: "var(--success)", icon: <MessageSquare size={12} /> },
  mailbox_message_sent: { label: "邮件已发", color: "var(--accent-cyan)", icon: <Mail size={12} /> },
  mailbox_message_replied: { label: "邮件已回", color: "var(--accent-cyan)", icon: <Mail size={12} /> },
  broadcast: { label: "广播", color: "var(--accent-cyan)", icon: <Radio size={12} /> },
  feishu_notification: { label: "飞书通知", color: "var(--accent-cyan)", icon: <Bell size={12} /> },

  // ── 协作 ──
  collab_delegation_message: { label: "协作委派", color: "var(--accent-gold)", icon: <GitBranch size={12} /> },
  collab_unblocked: { label: "协作解锁", color: "var(--success)", icon: <CheckCircle2 size={12} /> },
  collab_summary: { label: "协作汇总", color: "var(--accent-gold)", icon: <Inbox size={12} /> },

  // ── 通知 ──
  notification_created: { label: "通知创建", color: "var(--accent-cyan)", icon: <Bell size={12} /> },

  // ── 历史回看（events.unifiedList）专属类型：后端历史条目不是 WS 短名， ──
  // ── 这里给 task_messages 的 eventType 与 token_usage 各补一组样式， ──
  // ── 否则历史行只能退化成裸字符串标签。 ──
  "task_thread.dispatch": { label: "线程派发", color: "var(--accent-cyan)", icon: <Send size={12} /> },
  "task_thread.ack": { label: "线程确认", color: "var(--accent-cyan)", icon: <CheckCircle2 size={12} /> },
  "task_thread.working": { label: "线程执行中", color: "var(--accent-gold)", icon: <Clock size={12} /> },
  "task_thread.result": { label: "线程结果", color: "var(--success)", icon: <CheckCircle2 size={12} /> },
  "task_thread.error": { label: "线程错误", color: "var(--danger)", icon: <XCircle size={12} /> },
  "task_thread.timeout": { label: "线程超时", color: "var(--danger)", icon: <AlertTriangle size={12} /> },
  "task_thread.cancel": { label: "线程取消", color: "var(--text-muted)", icon: <XCircle size={12} /> },
  "task_thread.state": { label: "线程状态", color: "var(--text-muted)", icon: <Activity size={12} /> },
  "task_thread.terminal": { label: "线程终结", color: "var(--text-muted)", icon: <Inbox size={12} /> },
  "task_thread.system": { label: "线程系统", color: "var(--text-muted)", icon: <Server size={12} /> },
  "model.usage": { label: "用量记录", color: "var(--accent-gold)", icon: <Zap size={12} /> },
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

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 事件流时间戳：当天只显示 HH:mm:ss（与旧版 fmtTimeSec 视觉完全一致，不回归），
 * 跨天补「月-日」——历史回看会翻到几天前的事件，只给时分秒会让人误以为是今天的。
 */
function fmtEventTime(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const pad = (n: number) => n.toString().padStart(2, "0");
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hms : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hms}`;
}

/* ═══════════════════════════════════════════
   历史回看：后端 unifiedList 条目 → 展示模型
   ═══════════════════════════════════════════ */

/**
 * 把后端历史条目映射成页面统一的 EventEnvelope。
 *
 * 为什么这样映射：
 *  - eventId 直接用后端的 `kind:rowId`（如 `audit:12`），它全局唯一，
 *    既当 React key 也当与 WS 实时事件合并时的去重键；
 *  - 三类历史条目的字段结构各不相同，统一摊进 payload，展开面板才看得见；
 *  - audit 的 summary 就是审计事件名（如 `task:timeout`），直接当 type 展示，
 *    不做假的"翻译"，避免造出不存在的分类；
 *  - usage 条目的 costCents 额外折算 costMicros（1 美分 = 10000 微美元），
 *    命中 EventRow 现有的微美元渲染分支，$0.0012 这种小额才不会被抹成 $0.00。
 */
function historyToEnvelope(item: UnifiedEventItem): EventEnvelope {
  if (item.kind === "audit") {
    let meta: Record<string, unknown> = {};
    if (item.metadata) {
      try {
        const parsed: unknown = JSON.parse(item.metadata);
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          meta = parsed as Record<string, unknown>;
        } else {
          meta = { metadata: item.metadata };
        }
      } catch {
        // metadata 不是 JSON 就原样挂上，历史条目不该因此「没有细节」
        meta = { metadata: item.metadata };
      }
    }
    return {
      type: item.summary || `audit.${item.entityType}`,
      eventId: item.id,
      timestamp: item.ts,
      taskId: item.entityType === "task" && item.entityId != null ? item.entityId : undefined,
      payload: {
        source: "audit",
        entityType: item.entityType,
        entityId: item.entityId,
        actorUserId: item.actor.userId,
        ...meta,
      },
    };
  }

  if (item.kind === "task") {
    return {
      type: `task_thread.${item.summary}`,
      eventId: item.id,
      timestamp: item.ts,
      taskId: item.entityId,
      sourceAgentId: item.metadata.fromAgentId ?? undefined,
      targetAgentId: item.metadata.toAgentId ?? undefined,
      payload: {
        source: "task_message",
        taskId: item.entityId,
        eventType: item.summary,
        contentPreview: item.metadata.contentPreview,
        fromAgentId: item.metadata.fromAgentId,
        toAgentId: item.metadata.toAgentId,
      },
    };
  }

  const costCents = Number(item.metadata.costCents ?? 0);
  return {
    type: "model.usage",
    eventId: item.id,
    timestamp: item.ts,
    taskId: item.entityId ?? undefined,
    payload: {
      source: "token_usage",
      model: item.metadata.model,
      provider: item.metadata.provider,
      totalTokens: item.metadata.totalTokens,
      costCents,
      // 1 美分 = 10_000 微美元；EventRow 的微美元分支会按 6 位小数渲染
      costMicros: costCents * 10_000,
      summary: item.summary,
    },
  };
}

/**
 * 多批事件合并：按 eventId 去重 + 时间倒序（最新在上）。
 * 入参顺序即同毫秒事件的展示优先级——调用方传 [实时, 历史]，
 * 于是同一时刻实时事件排在历史之前。
 */
function mergeEvents(batches: readonly (readonly EventEnvelope[])[]): EventEnvelope[] {
  const seen = new Set<string>();
  const out: EventEnvelope[] = [];
  for (const batch of batches) {
    for (const e of batch) {
      if (seen.has(e.eventId)) continue;
      seen.add(e.eventId);
      out.push(e);
    }
  }
  out.sort((a, b) => {
    if (a.timestamp === b.timestamp) return 0; // 稳定排序：保留实时优先的插入序
    return a.timestamp < b.timestamp ? 1 : -1;
  });
  return out;
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
          {/* 历史线程条目（task_messages）带的是后端截好的正文预览，实时事件没有 */}
          {!!event.payload?.contentPreview && (
            <span style={{ color: "var(--text-muted)" }} className="truncate max-w-48">
              {String(event.payload.contentPreview).slice(0, 48)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {event.sourceAgentId && (
            <span style={{ color: "var(--text-muted)" }}>#{event.sourceAgentId}</span>
          )}
          {!!(event.payload?.costMicros ?? event.payload?.costCents) && (
            <span style={{ color: "var(--accent-gold)" }}>
              {event.payload?.costMicros
                ? `$${(Number(event.payload.costMicros) / 1_000_000).toFixed(6)}`
                : `$${(Number(event.payload.costCents) / 100).toFixed(2)}`}
            </span>
          )}
          <span style={{ color: "var(--text-muted)" }}>{fmtEventTime(event.timestamp)}</span>
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
  // events = 仅实时流（WS）；历史回看另存一份，两者在渲染前合并
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<string>("");
  const [traceFilter, setTraceFilter] = useState<string>("");
  const [selectedEvent, setSelectedEvent] = useState<EventEnvelope | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  // 暂停期间的事件缓冲：原实现是直接丢弃，恢复后那段历史永远缺一块
  const pendingRef = useRef<EventEnvelope[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  /**
   * 暂停状态的 ref 镜像。
   * 为什么需要它：原来 WS handler 直接闭包读 paused，于是 effect 必须依赖
   * [ws, paused] —— 每次暂停/继续都要先 remove 再 add 监听，那一瞬间到达的
   * 消息会漏掉（正是「暂停丢事件」的另一半成因）。改读 ref 后监听只注册一次。
   */
  const pausedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  const isAdmin = useAdminGate();

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // 使用现有的 WebSocket hook 连接 Dashboard 端点
  const ws = useWebSocket();
  const connected = ws?.connected ?? false;

  /**
   * 历史回看（events.unifiedList，keyset 游标分页）。
   *
   * enabled 绑定 isAdmin：该过程在 api/events-router.ts 里是 admin-only，
   * 非管理员发出去必然 403，与其让用户看红字不如干脆不发（降级见下面提示条）。
   * getNextPageParam 用后端给的 nextCursor —— 服务端是「严格位于游标之后」的
   * 真 keyset 翻页，不会重复也不会漂移，前端不需要自己算位置。
   */
  const historyQuery = trpc.events.unifiedList.useInfiniteQuery(
    { limit: HISTORY_PAGE_SIZE },
    {
      enabled: isAdmin,
      retry: false,
      staleTime: 60_000,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    }
  );

  /**
   * 历史被权限拦下 —— 只降级、不报红错。
   * 三个判据：前端已知非管理员 / 后端返回 403 / 后端消息是「需要管理员权限」
   * （api/events-router.ts 抛 TRPCError FORBIDDEN 时用的就是这句话）。
   * 之所以不直接比对 error.data.code 的字符串，是因为本项目 errorFormatter 的
   * 类型推导把 data.code 收敛成了数字型，字符串比较会被 TS 判定为永不相等。
   */
  const historyForbidden =
    !isAdmin ||
    historyQuery.error?.data?.httpStatus === 403 ||
    /管理员权限/.test(historyQuery.error?.message ?? "");
  /** 其它原因的历史加载失败（网络/服务端/游标失效），实时流照常工作 */
  const historyFailed = !historyForbidden && historyQuery.isError;

  /** 把已翻的每一页摊平成事件数组（后端已按时间倒序，页间也严格衔接） */
  const historyEvents = useMemo<EventEnvelope[]>(
    () => (historyQuery.data?.pages ?? []).flatMap((page) => page.items.map(historyToEnvelope)),
    [historyQuery.data]
  );

  /**
   * 双源合并：入参顺序 [实时, 历史] 决定同毫秒事件的优先级（实时在前），
   * 展示顺序统一为时间倒序 —— 最新的实时事件在顶部，越往下越早，末尾是
   * 「加载更早的事件」入口。
   *
   * 跨源重复的实际情况（已核对后端）：
   *  - 审计账本（audit_events）根本不走 WS 广播，只在库里，所以审计历史不会和
   *    实时流撞车；
   *  - WS 广播载荷多数不带 eventId，前端按 legacy-uuid 包装；而历史条目 id 是
   *    `kind:rowId`，两套命名空间天然不重叠；
   *  - 真正可能重叠的只有「挂载那一刻的边界」：挂载后到达的实时事件不会重复
   *    出现在已取到的历史页里（keyset 游标只向更早的方向翻）。
   * 因此 eventId 去重即足以保证不重复渲染，不需要再做内容指纹（那会误杀真实
   * 的重复事件，例如同一任务的两次同名状态变更）。
   */
  const mergedEvents = useMemo(() => mergeEvents([events, historyEvents]), [events, historyEvents]);

  /**
   * 接收实时事件。
   * 暂停时不再丢弃：先入 pendingRef（同样受 MAX_EVENTS 约束），
   * 等用户点「继续」时一次性并入 events。
   */
  useEffect(() => {
    if (!ws) return;

    const handler = (event: MessageEvent) => {
      let envelope: EventEnvelope | null = null;
      try {
        const data = JSON.parse(event.data);
        if (data.type && data.eventId) {
          // 是标准事件
          envelope = data as EventEnvelope;
        } else if (data.type && !data.eventId) {
          // 可能是旧格式事件（后端 broadcast 没带 eventId 字段），
          // 包装成标准格式：使用 crypto.randomUUID 避免遗留 `legacy-` 临时 ID
          envelope = {
            type: data.type,
            eventId: typeof crypto !== "undefined" && "randomUUID" in crypto
              ? `legacy-${crypto.randomUUID()}`
              : `legacy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: data.timestamp || new Date().toISOString(),
            payload: data,
          };
        }
        if (data.type) setLastEventAt(Date.now());
      } catch {
        // 非 JSON 载荷（心跳/文本帧）直接忽略；不要让一条坏帧打断实时流
      }

      if (!envelope) return;

      if (pausedRef.current) {
        // 暂停：只缓存不渲染。超出上限丢最旧的一条——新的更值得保留
        const buf = [envelope, ...pendingRef.current].slice(0, MAX_EVENTS);
        pendingRef.current = buf;
        setPendingCount(buf.length);
        return;
      }

      const ready = envelope;
      setEvents((prev) => [ready, ...prev].slice(0, MAX_EVENTS));
    };

    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [ws]);

  /** 暂停/继续：继续时把缓冲一次性并入实时流，不再丢弃暂停期间的事件 */
  const togglePause = useCallback(() => {
    if (!paused) {
      pausedRef.current = true; // 与 state 同步更新，避免切换瞬间的事件被写进缓冲却没人消费
      setPaused(true);
      return;
    }
    const buffered = pendingRef.current;
    pendingRef.current = [];
    setPendingCount(0);
    pausedRef.current = false;
    setPaused(false);
    if (buffered.length > 0) {
      setEvents((prev) => mergeEvents([prev, buffered]).slice(0, MAX_EVENTS));
    }
  }, [paused]);

  // 自动滚动到顶部
  useEffect(() => {
    if (listRef.current && !paused) {
      listRef.current.scrollTop = 0;
    }
  }, [events, paused]);

  // 筛选（在合并后的双源列表上做）
  const filteredEvents = mergedEvents.filter((e) => {
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

  /**
   * 清空 —— 只清实时流。
   * 历史条目来自后端审计账本/线程/用量三张表，清掉本地副本毫无意义
   * （下次进来还是同一批数据），也清不掉服务端的真数据，所以不动它。
   */
  const clearEvents = () => {
    setEvents([]);
    pendingRef.current = [];
    setPendingCount(0);
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
              onClick={togglePause}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono"
              style={{
                background: paused ? "rgba(255,200,50,0.1)" : "rgba(255,255,255,0.03)",
                border: `1px solid ${paused ? "rgba(255,200,50,0.3)" : "var(--border-default)"}`,
                color: paused ? "var(--accent-gold)" : "var(--text-muted)",
              }}
              title={
                paused
                  ? "继续接收：暂停期间缓存的事件会一次性并入"
                  : "暂停：期间的新事件会进缓冲，继续时补上，不再丢弃"
              }
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? "继续" : "暂停"}
              {paused && pendingCount > 0 && (
                <span
                  className="ml-0.5 px-1 rounded text-[9px]"
                  style={{ background: "rgba(255,200,50,0.18)", color: "var(--accent-gold)" }}
                >
                  +{pendingCount}
                </span>
              )}
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
              title="清空实时事件；历史事件来自后端账本，清本地副本没有意义，会继续显示"
            >
              <Trash2 size={14} /> 清空
            </button>
          </div>
        </div>

        {/* 统计 + 连接状态 */}
        <div className="flex items-center gap-4 mb-4 text-[10px] font-mono flex-wrap" style={{ color: "var(--text-muted)" }}>
          <span className="flex items-center gap-1.5">
            {connected ? <Wifi size={12} style={{ color: "var(--success)" }} /> : <WifiOff size={12} style={{ color: "var(--danger)" }} />}
            <span style={{ color: connected ? "var(--success)" : "var(--danger)" }}>
              {connected ? "WS 已连接" : "WS 离线"}
            </span>
          </span>
          <span>总事件: {mergedEvents.length}</span>
          <span className="flex items-center gap-1">
            <History size={11} />
            实时 {events.length} · 历史 {historyEvents.length}
          </span>
          <span>筛选后: {filteredEvents.length}</span>
          <span>Trace 分组: {Object.keys(groups).length}</span>
          <span>状态: {paused ? "⏸ 已暂停" : "▶ 接收中"}</span>
          {paused && <span style={{ color: "var(--accent-gold)" }}>缓冲: {pendingCount} 条（继续后并入）</span>}
          {lastEventAt && (
            <span>最后事件: {fmtTimeSec(new Date(lastEventAt).toISOString())}</span>
          )}
        </div>

        {/* 历史回看状态条：不阻塞实时流，任何异常都只是降级提示 */}
        {(historyForbidden || historyFailed) && (
          <div
            className="text-[10px] font-mono px-3 py-2 rounded mb-4 flex items-center justify-between gap-2"
            style={{
              background: historyForbidden ? "rgba(255,255,255,0.02)" : "rgba(255,200,50,0.08)",
              border: `1px solid ${historyForbidden ? "var(--border-default)" : "rgba(255,200,50,0.3)"}`,
              color: historyForbidden ? "var(--text-muted)" : "var(--accent-gold)",
            }}
          >
            <span>
              <History size={11} className="inline mr-1" />
              {historyForbidden
                ? "历史事件需要管理员权限：当前仅显示实时事件流（WS 推送照常，不受影响）"
                : `历史事件加载失败：${historyQuery.error?.message ?? "未知错误"}（实时流不受影响）`}
            </span>
            {!historyForbidden && (
              <button
                onClick={() => { void historyQuery.refetch(); }}
                className="px-2 py-0.5 rounded"
                style={{ border: "1px solid rgba(255,200,50,0.4)", color: "var(--accent-gold)" }}
              >
                重试
              </button>
            )}
          </div>
        )}

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
                // 空列表时先报历史加载态；已有实时事件就直接显示，别让首屏被占位符挡住
                historyQuery.isLoading ? (
                  <div className="text-xs py-12 text-center space-y-2" style={{ color: "var(--text-muted)" }}>
                    <Loader2 size={28} className="mx-auto opacity-40 animate-spin" />
                    <div>正在加载历史事件…</div>
                  </div>
                ) : (
                  <div className="text-xs py-12 text-center space-y-2" style={{ color: "var(--text-muted)" }}>
                    <Radio size={32} className="mx-auto opacity-30" />
                    <div>
                      {mergedEvents.length === 0
                        ? connected
                          ? "已连接 · 等待事件推送中"
                          : "WS 离线 · 等待重连…"
                        : "没有匹配的事件"}
                    </div>
                    {mergedEvents.length === 0 && (
                      <div className="text-[10px] font-mono opacity-70">
                        后端每产生一次任务/消息/审查/模型调用都会推送事件到这里
                      </div>
                    )}
                  </div>
                )
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

                  {/* 游标翻页入口：拿后端 nextCursor 继续往回翻，没有更早的就给个尽头提示 */}
                  <div className="pt-2 pb-1 flex items-center justify-center">
                    {historyQuery.hasNextPage ? (
                      <button
                        onClick={() => { void historyQuery.fetchNextPage(); }}
                        disabled={historyQuery.isFetchingNextPage}
                        className="flex items-center gap-1.5 text-[10px] font-mono px-3 py-1.5 rounded disabled:opacity-50"
                        style={{ border: "1px solid var(--border-default)", color: "var(--text-muted)" }}
                      >
                        {historyQuery.isFetchingNextPage
                          ? <Loader2 size={12} className="animate-spin" />
                          : <ChevronDown size={12} />}
                        {historyQuery.isFetchingNextPage ? "加载中…" : "加载更早的事件"}
                      </button>
                    ) : (
                      <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                        {historyForbidden ? "历史回看需管理员权限 · 以上为实时流" : "已到最早一条"}
                      </span>
                    )}
                  </div>
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
