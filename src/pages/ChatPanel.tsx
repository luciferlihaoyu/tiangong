/**
 * 天宫 对话栏目页 — ChatPanel
 *
 * 首页消息面板的独立全高版本（/chat）：
 * - 天宫对话：Agent ↔ Agent 消息通道（含 🤖 天宫助手 AI 对话）
 * - Open WebUI：内嵌 Open WebUI，全视口高度 iframe，固定会话不丢
 *
 * 与首页共用同一个 MessagePanel 组件（sections/Dashboard.tsx 导出），
 * 首页保留紧凑版作快捷一览，本页是完整的对话工作台。
 */
import { useWebSocket } from "@/hooks/useWebSocket";
import { useDashboardStats } from "@/hooks/useDashboardStats";
import { MessagePanel } from "@/sections/Dashboard";

export default function ChatPanel() {
  const stats = useDashboardStats();
  const { connected: wsConnected, lastMessage: lastWsMessage } = useWebSocket();
  const agents = (stats.agents ?? []) as unknown as Parameters<typeof MessagePanel>[0]["agents"];

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-24 pb-6">
        <div className="mb-4">
          <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
            对话
          </h1>
          <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
            CHAT · 天宫消息通道 / Open WebUI 固定会话
          </p>
        </div>
        <MessagePanel
          agents={agents}
          lastWsMessage={lastWsMessage}
          wsConnected={wsConnected}
          fullHeight
        />
      </div>
    </div>
  );
}
