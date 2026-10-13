import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SharedWsConnection, type WsEventLike, type WsLike, type WsTypeListener } from "@/lib/ws-connection";

export interface WSMessage {
  type: string;
  [key: string]: any;
}

export interface UseWebSocketReturn {
  connected: boolean;
  lastMessage: WSMessage | null;
  send: (data: object) => void;
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
}

/**
 * 用 JWT 换一次性 ticket。返回值三态：
 * - ticket 字符串：正常建连
 * - null：无 token（未登录）或 401（会话过期）——不连接，refs>0 时由共享连接
 *   按 30s 低峰心跳重试（重登成功后无需刷新即可恢复）
 * - reject：瞬时失败（网络/5xx），由共享连接按 3s 退避重试
 *
 * 无 token 连 /api/ws-ticket 都不打；401 同样不主动登出，交给路由守卫跳登录
 * （与旧实现一致的边界：WS 侧只负责停止无意义的密集重试）。
 */
async function defaultTicketProvider(): Promise<string | null> {
  // /ws/dashboard 需要一次性 ticket（浏览器 WS 不能设自定义头，只能放 query）。
  const token = localStorage.getItem("tiangong_token");
  if (!token) {
    console.warn("[WS Dashboard] No token, skip connect");
    return null;
  }
  try {
    const res = await fetch("/api/ws-ticket", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      console.warn("[WS Dashboard] Not authenticated, stop retrying");
      return null;
    }
    if (!res.ok) throw new Error(`ws-ticket ${res.status}`);
    const { ticket } = (await res.json()) as { ticket: string };
    return ticket ?? null;
  } catch (err) {
    console.warn("[WS Dashboard] Failed to fetch ws ticket:", err);
    throw err; // 瞬时失败 → 共享连接按退避重试
  }
}

/**
 * 由 ticket 建立底层 socket（协议/host 是浏览器环境细节，归这里管）。
 *
 * 原生 WebSocket 的 on* 属性带 this/Event 参数，与 ws-connection 的极简
 * WsLike 结构面不兼容，这里做一层薄适配：getter/setter 转发到底层 socket。
 * 注意 onmessage 转发的是**原生 MessageEvent** 本体（其 data 兼容 WsEventLike），
 * 保证类型监听者拿到的仍是原始 MessageEvent 形态——与旧实现一致。
 */
function defaultWsFactory(ticket: string): WsLike {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${protocol}//${window.location.host}/ws/dashboard?ticket=${encodeURIComponent(ticket)}`
  );
  return {
    get readyState() {
      return ws.readyState;
    },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    set onopen(handler: (() => void) | null) {
      ws.onopen = handler == null ? null : () => handler();
    },
    set onclose(handler: (() => void) | null) {
      ws.onclose = handler == null ? null : () => handler();
    },
    set onerror(handler: ((event: unknown) => void) | null) {
      ws.onerror = handler == null ? null : (event) => handler(event);
    },
    set onmessage(handler: ((event: WsEventLike) => void) | null) {
      // 透传原生 MessageEvent（data: any 兼容 WsEventLike 的 data: unknown）
      ws.onmessage = handler == null ? null : (event) => handler(event);
    },
  };
}

/**
 * 模块级共享单例：所有 useWebSocket() 调用点（AppLayout 壳、各页面、useNotifications）
 * 共用同一条 /ws/dashboard 连接，经 acquire/release 引用计数维护生命周期。
 * 修复「每组件各建一条连接 + 各取 ticket + 各自重连」导致的多标签事件重复派发与连接浪费。
 */
const sharedConnection = new SharedWsConnection({
  wsFactory: defaultWsFactory,
  ticketProvider: defaultTicketProvider,
});

/**
 * WebSocket Hook — 连接 /ws/dashboard（共享单连接版）
 *
 * 功能（导出与语义不变）：
 * - { connected, lastMessage, send, addEventListener, removeEventListener }
 * - connected 随共享连接状态实时更新（useSyncExternalStore）
 * - lastMessage 每条消息更新一次（引用变化驱动调用方 effect，语义与旧实现一致）
 * - 断线自动重连（3 秒退避）；无 token / 401 不连接，30s 低峰心跳重试
 *
 * 生命周期：挂载 acquire + 订阅消息，卸载 release + 退订——组件卸载不影响其他订阅者；
 * 最后一个订阅者离开后延迟 5s 才真正断开，吸收路由切换抖动。
 *
 * ⚠️ 契约变化：addEventListener 现注册在模块级共享连接的类型注册表上
 * （旧版挂在组件自己的 socket 上，随组件实例 GC）。调用点必须配对
 * removeEventListener（useEffect cleanup 等），否则监听器连同闭包捕获的
 * 组件状态在页面存续期内永久泄漏。另："message"（WS_EVENT_NAME_CATCH_ALL）
 * 是 DOM 事件名兼容槽，每条原始消息必达，listener 收到原始 MessageEvent
 * 本体（data 为字符串），由调用方自行 parse。
 */
export function useWebSocket(): UseWebSocketReturn {
  // 共享连接状态：subscribe/get 均为实例上的稳定箭头属性，不会反复重订阅
  const connected = useSyncExternalStore(sharedConnection.subscribeStatus, sharedConnection.getStatus);

  // 每实例独立的 lastMessage 缓冲：初始 null，订阅期间每条消息更新一次。
  // 多个调用点靠它的引用变化触发 effect，这里绝不能改成共享快照。
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);

  useEffect(() => {
    sharedConnection.acquire();
    const unsubscribeMessage = sharedConnection.subscribeMessage((message) => {
      setLastMessage(message as WSMessage);
    });
    return () => {
      unsubscribeMessage();
      sharedConnection.release();
    };
  }, []);

  const send = useCallback((data: object) => {
    sharedConnection.send(JSON.stringify(data));
  }, []);

  const addEventListener = useCallback((type: string, listener: (event: MessageEvent) => void) => {
    // 真实环境里派发的就是 socket 的 MessageEvent；收窄到 WsEventLike 仅为跨端类型面
    sharedConnection.addEventListener(type, listener as unknown as WsTypeListener);
  }, []);

  const removeEventListener = useCallback(
    (type: string, listener: (event: MessageEvent) => void) => {
      sharedConnection.removeEventListener(type, listener as unknown as WsTypeListener);
    },
    []
  );

  return { connected, lastMessage, send, addEventListener, removeEventListener };
}
