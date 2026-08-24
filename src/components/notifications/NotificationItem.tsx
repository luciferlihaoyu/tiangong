import { Link } from "react-router";
import {
  CheckCircle2,
  XCircle,
  CircleCheck,
  CircleAlert,
  BookOpen,
  DollarSign,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type NotificationType =
  | "task_approved"
  | "task_rejected"
  | "task_completed"
  | "task_failed"
  | "lesson_recorded"
  | "budget_exhausted";

export interface AppNotification {
  id: number;
  agentId?: number;
  type: NotificationType;
  taskId?: number | null;
  title: string;
  body: string;
  metadata?: unknown;
  readAt: string | null;
  createdAt: Date | string;
}

interface NotificationItemProps {
  notification: AppNotification;
  onMarkRead: (id: number) => void;
}

/** type → 图标 + 颜色（6 种：绿/红/蓝/红/紫/橙） */
const TYPE_META: Record<NotificationType, { icon: React.ReactNode; color: string; bg: string }> = {
  task_approved: {
    icon: <CheckCircle2 size={15} />,
    color: "#34d399",
    bg: "rgba(52, 211, 153, 0.12)",
  },
  task_rejected: {
    icon: <XCircle size={15} />,
    color: "#f87171",
    bg: "rgba(248, 113, 113, 0.12)",
  },
  task_completed: {
    icon: <CircleCheck size={15} />,
    color: "#60a5fa",
    bg: "rgba(96, 165, 250, 0.12)",
  },
  task_failed: {
    icon: <CircleAlert size={15} />,
    color: "#f87171",
    bg: "rgba(248, 113, 113, 0.12)",
  },
  lesson_recorded: {
    icon: <BookOpen size={15} />,
    color: "#a78bfa",
    bg: "rgba(167, 139, 250, 0.12)",
  },
  budget_exhausted: {
    icon: <DollarSign size={15} />,
    color: "#fb923c",
    bg: "rgba(251, 146, 60, 0.12)",
  },
};

/** 中文相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期 */
export function formatRelativeTime(value: Date | string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) {
    const days = Math.floor(diff / day);
    return days === 1 ? "昨天" : `${days} 天前`;
  }
  return date.toLocaleDateString("zh-CN");
}

export function NotificationItem({ notification, onMarkRead }: NotificationItemProps) {
  const { type, title, body, readAt, createdAt, taskId } = notification;
  const unread = !readAt;
  const meta = TYPE_META[type] ?? TYPE_META.task_completed;

  const handleClick = () => {
    if (unread) onMarkRead(notification.id);
  };

  return (
    <div
      role={unread ? "button" : undefined}
      tabIndex={unread ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (unread && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          handleClick();
        }
      }}
      className={cn(
        "w-full text-left px-3 py-2.5 rounded-md transition-colors flex gap-2.5 items-start",
        unread
          ? "bg-[rgba(96,165,250,0.08)] hover:bg-[rgba(96,165,250,0.16)] cursor-pointer"
          : "opacity-60 hover:opacity-80 cursor-default"
      )}
      title={unread ? "点击标记已读" : undefined}
    >
      {/* 未读小圆点 */}
      <span
        className={cn("mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0", unread ? "bg-blue-400" : "bg-transparent")}
        style={unread ? { boxShadow: "0 0 4px rgba(96,165,250,0.8)" } : undefined}
      />

      {/* 类型图标 */}
      <span
        className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ color: meta.color, background: meta.bg }}
      >
        {meta.icon}
      </span>

      {/* 内容 */}
      <span className="flex-1 min-w-0">
        <span className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold truncate" style={{ color: unread ? "var(--text-primary)" : "var(--text-secondary)" }}>
            {title}
          </span>
          <span className="text-[10px] whitespace-nowrap font-mono" style={{ color: "var(--text-muted)" }}>
            {formatRelativeTime(createdAt)}
          </span>
        </span>
        <span className="block text-[11px] mt-0.5 leading-relaxed line-clamp-2 break-words" style={{ color: "var(--text-secondary)" }}>
          {body}
        </span>
        {taskId != null && (
          <Link
            to={`/tasks/${taskId}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 text-[10px] mt-1 font-mono hover:underline"
            style={{ color: "var(--accent-cyan)" }}
          >
            查看任务 #{taskId} →
          </Link>
        )}
      </span>
    </div>
  );
}
