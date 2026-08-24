import { useEffect } from "react";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";

/**
 * 通知中心 Hook（NC-6 UI）
 *
 * 数据源：trpc.agent.notifications.list（游标分页，返回 { items, nextCursor }）
 * 轮询：后端无 WebSocket 通知推送，用 refetchInterval 30s 自动拉新。
 * 已读：markRead / markAllRead，成功后 invalidate list 刷新。
 */
export const NOTIFICATIONS_LIMIT = 50;

/**
 * 常驻查询键 prefetch helper —— 与 useNotifications 使用同一查询键（limit=50），
 * 页面级/导航渲染前可提前预热缓存。
 */
export function prefetchNotifications(utils: ReturnType<typeof trpc.useUtils>) {
  return utils.agent.notifications.list.prefetch({ limit: NOTIFICATIONS_LIMIT });
}

export function useNotifications() {
  const utils = trpc.useUtils();
  const listQuery = trpc.agent.notifications.list.useQuery(
    { limit: NOTIFICATIONS_LIMIT },
    { refetchInterval: 30_000, staleTime: 10_000 }
  );
  const markReadMutation = trpc.agent.notifications.markRead.useMutation({
    onSuccess: () => utils.agent.notifications.list.invalidate(),
  });
  const markAllReadMutation = trpc.agent.notifications.markAllRead.useMutation({
    onSuccess: () => utils.agent.notifications.list.invalidate(),
  });

  const { addEventListener, removeEventListener } = useWebSocket();

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && msg.type === "notification_created") {
          // 收到后端 push 事件——立即 invalidate tRPC list，让 bell 角标/下拉近实时刷新
          utils.agent.notifications.list.invalidate();
        }
      } catch {
        // 解析失败静默忽略（与 WebSocket 重连策略一致）
      }
    };
    addEventListener("notification_created", handler);
    return () => {
      removeEventListener("notification_created", handler);
    };
  }, [addEventListener, removeEventListener, utils]);

  const items = listQuery.data?.items ?? [];
  const unreadCount = items.filter((n) => !n.readAt).length;

  return {
    items,
    unreadCount,
    isLoading: listQuery.isLoading,
    refresh: () => utils.agent.notifications.list.invalidate(),
    markRead: (id: number) => markReadMutation.mutate({ id }),
    markAllRead: () => markAllReadMutation.mutate({}),
  };
}
