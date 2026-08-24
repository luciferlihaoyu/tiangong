import { Bell } from "lucide-react";
import { useNotifications } from "@/hooks/useNotifications";
import { NotificationDropdown } from "./NotificationDropdown";

/**
 * 通知铃铛（NC-6 UI）
 * - 铃铛图标，未读数 > 0 显示红色角标（>99 显示 99+）
 * - 点击展开 NotificationDropdown
 */
export function NotificationBell() {
  const { unreadCount } = useNotifications();

  return (
    <NotificationDropdown>
      <button
        className="relative p-1.5 rounded hover:bg-[rgba(180,200,255,0.04)] transition-colors"
        style={{ color: "var(--text-secondary)" }}
        title={unreadCount > 0 ? `通知（${unreadCount} 条未读）` : "通知"}
      >
        <Bell size={15} />
        {unreadCount > 0 && (
          <span
            className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full flex items-center justify-center text-[8px] font-bold leading-none"
            style={{
              background: "var(--accent-red)",
              color: "#fff",
              boxShadow: "0 0 6px rgba(194, 58, 48, 0.6)",
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
    </NotificationDropdown>
  );
}
