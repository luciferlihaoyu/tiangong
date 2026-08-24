import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useNotifications, NOTIFICATIONS_LIMIT } from "@/hooks/useNotifications";
import {
  NotificationItem,
  type AppNotification,
  type NotificationType,
} from "@/components/notifications/NotificationItem";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Bell, CheckCheck, ChevronDown, Inbox, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 通知中心全页（UI-5）
 * - 标题栏：通知中心（未读角标）+ 全部标记已读
 * - 过滤栏：tab 按 type 过滤（全部/任务审批/任务失败/教训/预算）+ 仅未读开关
 * - 列表：复用 <NotificationItem>，cursor 分页（useQuery + 手动「加载更多」）
 * - 数据源与 dropdown 一致：trpc.agent.notifications.list（30s 轮询）
 * 注：后端 list 仅支持 unreadOnly / cursor，type 过滤在前端完成。
 */

/** tab → 对应通知类型（null = 全部）；任务审批覆盖批准+拒绝两种结果 */
const TABS: ReadonlyArray<{ key: string; label: string; types: readonly NotificationType[] | null }> = [
  { key: "all", label: "全部", types: null },
  { key: "approval", label: "任务审批", types: ["task_approved", "task_rejected"] },
  { key: "failed", label: "任务失败", types: ["task_failed"] },
  { key: "lesson", label: "教训", types: ["lesson_recorded"] },
  { key: "budget", label: "预算", types: ["budget_exhausted"] },
];

/** 已加载的分页槽位：以发起请求时的 cursor 为键（undefined = 最新一页） */
interface PageSlot {
  cursor: number | undefined;
  items: AppNotification[];
}

export default function NotificationsPanel() {
  const { unreadCount, markRead, markAllRead, refresh } = useNotifications();

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [activeTab, setActiveTab] = useState("all");
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [pages, setPages] = useState<PageSlot[]>([]);

  const { data, isLoading, isFetching } = trpc.agent.notifications.list.useQuery(
    { limit: NOTIFICATIONS_LIMIT, unreadOnly, cursor },
    { refetchInterval: 30_000, staleTime: 10_000 }
  );

  // 过滤条件（仅未读）变化 → 重置分页游标与已加载页面
  useEffect(() => {
    setCursor(undefined);
    setPages([]);
  }, [unreadOnly]);

  // 将本次返回的页面按 cursor 槽位写入：in-place 更新，已读状态能及时反映
  useEffect(() => {
    if (!data) return;
    setPages((prev) => {
      const slot = prev.findIndex((p) => p.cursor === cursor);
      const next: PageSlot = { cursor, items: data.items };
      if (slot === -1) return [...prev, next];
      const copy = [...prev];
      copy[slot] = next;
      return copy;
    });
  }, [data, cursor]);

  // 页序：cursor 越大越旧（按 id 递减），undefined（最新页）排最前；拼接并按 id 去重
  const loaded = useMemo(() => {
    const ordered = [...pages].sort((a, b) => (b.cursor ?? Infinity) - (a.cursor ?? Infinity));
    const seen = new Set<number>();
    const flat: AppNotification[] = [];
    for (const p of ordered) {
      for (const n of p.items) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        flat.push(n);
      }
    }
    return flat;
  }, [pages]);

  // 按 tab 客户端过滤（后端 list 无 type 参数）
  const filtered = useMemo(() => {
    const tab = TABS.find((t) => t.key === activeTab);
    if (!tab?.types) return loaded;
    return loaded.filter((n) => tab.types!.includes(n.type));
  }, [loaded, activeTab]);

  const hasMore = data?.nextCursor != null;
  const isInitialLoading = isLoading && pages.length === 0;
  // 手动翻页时查询键（cursor）切换、新页未到 → 显示「加载中…」
  const isLoadingMore = isFetching && cursor !== undefined && !data;

  const loadMore = () => {
    if (data?.nextCursor != null) setCursor(data.nextCursor);
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--bg-primary)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-16 pb-16">
        {/* 标题栏 */}
        <div className="flex items-center justify-between flex-wrap gap-4 mb-5">
          <div>
            <h1
              className="text-2xl font-black tracking-wider flex items-center gap-2"
              style={{ color: "var(--text-primary)" }}
            >
              <Bell size={22} style={{ color: "var(--accent-cyan)" }} />
              通知中心
              {unreadCount > 0 && (
                <span
                  className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                  style={{ background: "var(--accent-glow-red)", color: "var(--accent-red-bright)" }}
                >
                  {unreadCount} 未读
                </span>
              )}
            </h1>
            <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
              NOTIFICATIONS · 任务审批 / 失败教训 / 预算告警
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refresh()}
              title="刷新"
              className="flex items-center gap-1 px-3 py-2 rounded text-xs font-mono transition-colors hover:bg-[rgba(180,200,255,0.05)]"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={12} />
              刷新
            </button>
            <button
              onClick={() => markAllRead()}
              disabled={unreadCount === 0}
              title="全部标记已读"
              className="flex items-center gap-1.5 px-3 py-2 rounded text-xs font-bold tracking-wide transition-all hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{
                background: "var(--accent-cyan)",
                color: "#fff",
                boxShadow: "0 0 16px rgba(74,158,255,0.25)",
              }}
            >
              <CheckCheck size={13} />
              全部标记已读
            </button>
          </div>
        </div>

        {/* 过滤栏 */}
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-1 flex-wrap p-1 rounded" style={{ border: "1px solid var(--border-default)" }}>
            {TABS.map((t) => {
              const active = t.key === activeTab;
              return (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={cn(
                    "px-3 py-1.5 rounded text-xs font-mono transition-colors",
                    active ? "font-bold" : "hover:bg-[rgba(180,200,255,0.05)]"
                  )}
                  style={
                    active
                      ? { background: "rgba(74,158,255,0.15)", color: "var(--accent-cyan)", border: "1px solid rgba(74,158,255,0.35)" }
                      : { color: "var(--text-muted)", border: "1px solid transparent" }
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* 仅未读开关（后端 unreadOnly 参数） */}
          <div className="ml-auto flex items-center gap-1.5 cursor-pointer select-none" onClick={() => setUnreadOnly((v) => !v)}>
            <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
              仅未读
            </span>
            <div
              className="relative w-8 h-4 rounded-full transition-colors"
              style={{
                background: unreadOnly ? "var(--accent-cyan)" : "rgba(255,255,255,0.1)",
                border: "1px solid var(--border-default)",
              }}
            >
              <div
                className="absolute top-0.5 w-3 h-3 rounded-full transition-all duration-200"
                style={{ background: "#fff", left: unreadOnly ? "19px" : "3px" }}
              />
            </div>
          </div>
        </div>

        {/* 列表面板 */}
        <div className="glass-panel sci-border overflow-hidden">
          <ScrollArea className="md:max-h-[calc(100vh-340px)] min-h-[360px]">
            {isInitialLoading ? (
              <div className="flex flex-col gap-1.5 p-1">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex gap-2.5 items-start px-3 py-2.5">
                    <Skeleton className="w-7 h-7 rounded-md flex-shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-3/4" />
                      <Skeleton className="h-2.5 w-full" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
                <Inbox size={32} style={{ color: "var(--text-muted)" }} />
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {loaded.length > 0 ? "当前分类暂无通知" : unreadOnly ? "暂无未读通知" : "暂无通知"}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {filtered.map((n) => (
                  <NotificationItem key={n.id} notification={n} onMarkRead={markRead} />
                ))}
              </div>
            )}
          </ScrollArea>

          {/* 底栏：加载更多 / 加载中 / 已全部加载 */}
          {!isInitialLoading && (
            <div
              className="px-3 py-2 flex items-center justify-center"
              style={{ borderTop: "1px solid var(--border-default)" }}
            >
              {isLoadingMore ? (
                <span className="text-[10px] font-mono animate-pulse" style={{ color: "var(--text-muted)" }}>
                  加载中...
                </span>
              ) : hasMore ? (
                <button
                  onClick={loadMore}
                  className="flex items-center gap-1 text-[10px] font-mono hover:underline transition-colors"
                  style={{ color: "var(--accent-cyan)" }}
                >
                  加载更多
                  <ChevronDown size={11} />
                </button>
              ) : loaded.length > 0 ? (
                <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                  已加载全部 · {loaded.length} 条
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
