import { useState, useEffect, useRef, useCallback } from "react";

export interface WSMessage {
  type: string;
  [key: string]: any;
}

export interface UseWebSocketReturn {
  connected: boolean;
  lastMessage: WSMessage | null;
  send: (data: object) => void;
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

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    // Determine WebSocket URL
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/dashboard`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

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
        } catch {
          console.warn("[WS Dashboard] Failed to parse message:", event.data);
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setConnected(false);
        console.log("[WS Dashboard] Disconnected, reconnecting in 3s...");

        // Auto-reconnect after 3 seconds
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
        }
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) {
            connect();
          }
        }, 3000);
      };

      ws.onerror = (err) => {
        console.warn("[WS Dashboard] Error:", err);
        // onclose will fire after this, triggering reconnect
      };
    } catch (err) {
      console.warn("[WS Dashboard] Failed to create WebSocket:", err);
      // Retry after 3 seconds
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, 3000);
    }
  }, []);

  const send = useCallback((data: object) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
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
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  return { connected, lastMessage, send };
}
