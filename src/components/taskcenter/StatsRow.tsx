/**
 * 顶部统计卡片行 — 自 src/pages/TaskCenter.tsx 逐段搬迁（原 L124-174），行为保持。
 */
import { AlertTriangle, CheckCircle, Pause, Target, Zap } from "lucide-react";
import type { Task } from "./types";

/** 顶部统计卡片行 */
export function StatsRow({ tasks }: { tasks: Task[] }) {
  const counts = {
    total: tasks.length,
    pending: tasks.filter((t) => t.status === "pending").length,
    queued: tasks.filter((t) => t.status === "queued").length,
    running: tasks.filter((t) => t.status === "running").length,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
  };

  const cards = [
    { key: "total", label: "任务总数", count: counts.total, color: "var(--text-primary)", bg: "rgba(255,255,255,0.02)", icon: <Target size={16} /> },
    { key: "running", label: "执行中", count: counts.running, color: "var(--warning)", bg: "var(--accent-glow-gold)", icon: <Zap size={16} /> },
    { key: "queued", label: "排队中", count: counts.queued + counts.pending, color: "var(--accent-cyan)", bg: "rgba(74,158,255,0.08)", icon: <Pause size={16} /> },
    { key: "done", label: "已完成", count: counts.done, color: "var(--success)", bg: "rgba(76,175,125,0.06)", icon: <CheckCircle size={16} /> },
    { key: "failed", label: "失败", count: counts.failed, color: "var(--accent-red)", bg: "var(--accent-glow-red)", icon: <AlertTriangle size={16} /> },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      {cards.map((c) => (
        <div
          key={c.key}
          className="glass-panel p-3 sci-border flex items-center gap-2"
        >
          <div
            className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
            style={{ background: c.bg }}
          >
            <span style={{ color: c.color }}>{c.icon}</span>
          </div>
          <div className="min-w-0">
            <div
              className="text-lg font-bold font-mono"
              style={{ color: c.color }}
            >
              {c.count}
            </div>
            <div
              className="text-[10px] font-mono"
              style={{ color: "var(--text-muted)" }}
            >
              {c.label}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
