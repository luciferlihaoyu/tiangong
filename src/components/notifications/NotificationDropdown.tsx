import type { ReactNode } from "react";
import { Link } from "react-router";
import { CheckCheck, Inbox, ArrowRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useNotifications, NOTIFICATIONS_LIMIT } from "@/hooks/useNotifications";
import { NotificationItem } from "./NotificationItem";

/** 下拉里最多展示的条数（hook 拉取 50，面板只展前 10 + 查看全部） */
const DROPDOWN_VISIBLE = 10;

/**
 * 通知下拉面板（NC-6 UI）
 * - 标题栏：通知 (X 未读) + 全部已读
 * - 滚动列表 / 空态 / 加载 skeleton
 * - 底部：查看全部 → /notifications
 * children 为触发按钮（由 NotificationBell 传入）
 */
export function NotificationDropdown({ children }: { children: ReactNode }) {
  const { items, unreadCount, isLoading, markRead, markAllRead } = useNotifications();
  const visible = items.slice(0, DROPDOWN_VISIBLE);
  const hasMore = items.length > DROPDOWN_VISIBLE;

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[360px] max-w-[calc(100vw-2rem)] p-0 overflow-hidden"
        style={{
          background: "rgba(8, 8, 12, 0.97)",
          border: "1px solid var(--border-default)",
          backdropFilter: "blur(20px) saturate(150%)",
          color: "var(--text-primary)",
        }}
      >
        {/* 标题栏 */}
        <div
          className="flex items-center justify-between px-3 py-2.5"
          style={{ borderBottom: "1px solid var(--border-default)" }}
        >
          <span className="text-xs font-bold tracking-wide">
            通知{unreadCount > 0 ? ` (${unreadCount} 未读)` : ""}
          </span>
          <button
            onClick={() => markAllRead()}
            disabled={unreadCount === 0}
            className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded hover:bg-[rgba(180,200,255,0.06)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: "var(--accent-cyan)" }}
            title="全部标为已读"
          >
            <CheckCheck size={12} />
            全部已读
          </button>
        </div>

        {/* 列表 / 空态 / 加载 */}
        <ScrollArea className="max-h-[320px] p-1.5">
          {isLoading && items.length === 0 ? (
            <div className="flex flex-col gap-1.5 p-1">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex gap-2.5 items-start px-3 py-2.5">
                  <Skeleton className="w-7 h-7 rounded-md flex-shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
              <Inbox size={20} style={{ color: "var(--text-muted)" }} />
              <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                暂无通知
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {visible.map((n) => (
                <NotificationItem key={n.id} notification={n} onMarkRead={markRead} />
              ))}
            </div>
          )}
        </ScrollArea>

        {/* 底部：查看全部 */}
        <div
          className="px-3 py-2 flex items-center justify-center"
          style={{ borderTop: "1px solid var(--border-default)" }}
        >
          <Link
            to="/notifications"
            className="flex items-center gap-1 text-[10px] font-mono hover:underline transition-colors"
            style={{ color: hasMore || items.length > 0 ? "var(--accent-cyan)" : "var(--text-muted)" }}
          >
            查看全部 {hasMore ? `(${items.length}/${NOTIFICATIONS_LIMIT})` : ""}
            <ArrowRight size={11} />
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
