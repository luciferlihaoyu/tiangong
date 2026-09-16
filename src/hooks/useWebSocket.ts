import { useState, useEffect, useRef, useCallback } from "react";

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
 * WebSocket Hook — 连接 /ws/dashboard
 *
 * 功能：
 * - 连接 Dashboard WebSocket 端点
 * - 监听消息事件，更新 lastMessage
 * - 自动重连（断开后 3 秒重试）
 * - 导出：{ connected, lastMessage, send }
 */
export function useWebSocket(): UseWebSocketReturn {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const listenersRef = useRef(new Map<string, Set<EventListener>>());
  // 取 ticket 是异步的，wsRef 要等 fetch 返回后才赋值，中间存在窗口期
  const connectingRef = useRef(false);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    // 已有连接（含连接中）时不重复发起，避免重连定时器与 onclose 叠加出多个 socket
    if (wsRef.current && wsRef.current.readyState !== WebSocket.CLOSED) return;

    // /ws/dashboard 需要一次性 ticket（浏览器 WS 不能设自定义头，只能放 query）。
    // 无 token 说明未登录：不发请求也不重连，等下次挂载再试。
    // 必须先于 connectingRef 置位：这条提前 return 走不到下面的 finally，
    // 若在置位之后检查，标记会永久卡在 true，本次挂载就再也连不上了。
    const token = localStorage.getItem("tiangong_token");
    if (!token) {
      console.warn("[WS Dashboard] No token, skip connect");
      return;
    }

    // 没有这个标记的话，窗口期内的第二次 connect() 会再开一条 socket，
    // 同一条事件就会被重复派发（表现为重复通知）
    if (connectingRef.current) return;
    connectingRef.current = true;

    const scheduleReconnect = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, 3000);
    };

    // 先用 JWT 换 ticket，再带 ticket 开 WS；失败走既有 3 秒重连。
    // 用 task 承接 Promise，统一在 finally 里复位 connectingRef（含提前 return 的路径）。
    const task = (async () => {
      let wsUrl: string;
      try {
        const res = await fetch("/api/ws-ticket", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 401) {
          // 未登录或会话已过期：重试不可能成功，交给路由守卫去跳登录。
          // 否则多个 hook 实例会以 3 秒间隔持续打无效请求。
          // 已知局限：这里只停重试，不主动登出——若调用方未察觉会话过期
          // （ProtectedLayout 只检查本地 token 是否存在），WS 会静默保持断开，
          // 用户下次刷新或重新登录即恢复。
          console.warn("[WS Dashboard] Not authenticated, stop retrying");
          return;
        }
        if (!res.ok) throw new Error(`ws-ticket ${res.status}`);
        const { ticket } = (await res.json()) as { ticket: string };
        if (!mountedRef.current) return; // 等 ticket 期间被卸载，不再建立连接

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        wsUrl = `${protocol}//${window.location.host}/ws/dashboard?ticket=${encodeURIComponent(ticket)}`;
      } catch (err) {
        console.warn("[WS Dashboard] Failed to fetch ws ticket:", err);
        scheduleReconnect();
        return;
      }

      try {
        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        listenersRef.current.forEach((listeners, type) => {
          listeners.forEach((listener) => ws.addEventListener(type, listener));
        });

        ws.onopen = () => {
          if (!mountedRef.current) return;
          setConnected(true);
          console.log("[WS Dashboard] Connected");
        };

        ws.onmessage = (event) => {
          if (!mountedRef.current) return;
          try {
            const data = JSON.parse(event.data) as WSMessage;
            setLastMessage(data);
            // 通知中心实时推送 t2.5：按 data.type 派发到 listenersRef 注册的监听器
            // （之前 onmessage 不派发，addEventListener("xxx") 永远不会被 fire，属静默降级）
            const listeners = listenersRef.current.get(data.type);
            if (listeners) {
              // 复制一份避免迭代时 mutate
              for (const listener of Array.from(listeners)) {
                try {
                  listener(event);
                } catch (e) {
                  console.warn(`[WS Dashboard] Listener for "${data.type}" threw:`, e);
                }
              }
            }
          } catch {
            console.warn("[WS Dashboard] Failed to parse message:", event.data);
          }
        };

        ws.onclose = () => {
          if (!mountedRef.current) return;
          setConnected(false);
          console.log("[WS Dashboard] Disconnected, reconnecting in 3s...");
          wsRef.current = null;

          // Auto-reconnect after 3 seconds
          scheduleReconnect();
        };

        ws.onerror = (err) => {
          console.warn("[WS Dashboard] Error:", err);
          // onclose will fire after this, triggering reconnect
        };
      } catch (err) {
        console.warn("[WS Dashboard] Failed to create WebSocket:", err);
        // Retry after 3 seconds
        scheduleReconnect();
      }
    })();
    // 统一在 finally 里复位 connectingRef，覆盖上面所有提前 return 的路径
    void task
      .finally(() => {
        connectingRef.current = false;
      })
      .catch(() => {});
  }, []);

  const send = useCallback((data: object) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const addEventListener = useCallback((type: string, listener: (event: MessageEvent) => void) => {
    const eventListener = listener as EventListener;
    const listeners = listenersRef.current.get(type) ?? new Set<EventListener>();
    listeners.add(eventListener);
    listenersRef.current.set(type, listeners);
    wsRef.current?.addEventListener(type, eventListener);
  }, []);

  const removeEventListener = useCallback((type: string, listener: (event: MessageEvent) => void) => {
    const eventListener = listener as EventListener;
    listenersRef.current.get(type)?.delete(eventListener);
    wsRef.current?.removeEventListener(type, eventListener);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        listenersRef.current.forEach((listeners, type) => {
          listeners.forEach((listener) => wsRef.current?.removeEventListener(type, listener));
        });
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { connected, lastMessage, send, addEventListener, removeEventListener };
}
