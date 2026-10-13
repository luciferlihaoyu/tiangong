/**
 * 任务卡片 — 自 src/pages/TaskCenter.tsx 逐段搬迁（原 L176-349），行为保持。
 *
 * 性能改造（P-TaskCenter 拆分）：
 * - 包 React.memo：props 全部为稳定引用时跳过重渲染（task/agent 来自 react-query
 *   结构共享，容器行级回调为 useCallback 稳定引用）。
 * - props 契约变更：agents 数组 + 组件内 find 改为容器解析好的单个 agent；
 *   回调从零参改为 (task: Task) => void，由本组件在 onClick 里回传 task，
 *   容器侧才能用与行无关的稳定处理器。
 */
import { memo } from "react";
import { TASK_STATUS_CONFIG as STATUS_CONFIG } from "@/lib/taskStatus";
import { fmtTime } from "@/lib/format";
import { AGENT_STATUS_COLORS, LIFECYCLE_LABELS } from "./constants";
import { AlertTriangle, Clock, Eye, Trash2, Zap } from "lucide-react";
import type { Agent, Task } from "./types";

/** 任务卡片 */
export const TaskCard = memo(function TaskCard({
  task,
  agent,
  onView,
  onDelete,
  onPromote,
  onDemote,
  onDispatch,
}: {
  task: Task;
  agent?: Agent;
  onView: (task: Task) => void;
  onDelete: (task: Task) => void;
  onPromote: (task: Task) => void;
  onDemote: (task: Task) => void;
  onDispatch?: (task: Task) => void;
}) {
  const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
  const lcLabel = task.lifecycleStatus ? LIFECYCLE_LABELS[task.lifecycleStatus] : null;

  return (
    <div className="glass-panel p-4 sci-border transition-all group relative hover:border-[var(--accent-cyan)]/20">
      {/* Hover actions */}
      <div className="absolute top-2 right-2 flex gap-1 tg-hover-actions opacity-0 group-hover:opacity-100 transition-opacity z-10">
        {task.status === "pending" && onDispatch && (
          <button
            onClick={() => onDispatch(task)}
            className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(74,158,255,0.15)] font-mono flex items-center gap-1"
            style={{ color: "var(--accent-cyan)" }}
            title="派发任务"
          >
            <Zap size={12} /> 派发
          </button>
        )}
        <button
          onClick={() => onPromote(task)}
          className="text-[10px] px-1 py-0.5 rounded hover:bg-[rgba(201,168,76,0.15)] font-mono"
          style={{ color: "var(--accent-gold)" }}
          title="提升优先级"
        >
          ↑ P{task.priority + 1}
        </button>
        {task.priority > 0 && (
          <button
            onClick={() => onDemote(task)}
            className="text-[10px] px-1 py-0.5 rounded hover:bg-[rgba(180,200,255,0.1)] font-mono"
            style={{ color: "var(--text-muted)" }}
            title="降低优先级"
          >
            ↓
          </button>
        )}
        <button
          onClick={() => onView(task)}
          className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[rgba(100,181,246,0.1)] flex items-center gap-1"
          style={{ color: "var(--accent-cyan)" }}
        >
          <Eye size={12} /> 详情
        </button>
        <button
          onClick={() => onDelete(task)}
          className="text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--accent-glow-red)] flex items-center gap-1"
          style={{ color: "var(--accent-red)" }}
        >
          <Trash2 size={12} /> 删除
        </button>
      </div>

      {/* Status + taskId */}
      <div className="flex items-center gap-2 mb-2 pr-20">
        <span
          className="text-[10px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1 flex-shrink-0"
          style={{ background: sc.bg, color: sc.color }}
        >
          {sc.icon} {sc.label}
        </span>
        {lcLabel && lcLabel !== sc.label && (
          <span
            className="text-[9px] px-1 py-0 rounded font-mono flex-shrink-0"
            style={{ background: "rgba(180,200,255,0.05)", color: "var(--text-muted)" }}
          >
            {lcLabel}
          </span>
        )}
        <span
          className="text-[10px] font-mono"
          style={{ color: "var(--accent-gold)" }}
        >
          {task.taskId}
        </span>
        {task.priority > 0 && (
          <span
            className="text-[10px] px-1 py-0 rounded font-mono"
            style={{ background: "rgba(201, 168, 76, 0.1)", color: "var(--accent-gold)" }}
          >
            P{task.priority}
          </span>
        )}
      </div>

      {/* Title */}
      <h3
        className="text-sm font-bold truncate mb-2"
        style={{ color: "var(--text-primary)" }}
      >
        {task.name}
      </h3>

      {/* Agent */}
      {agent && (
        <div className="flex items-center gap-2 mb-2">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: AGENT_STATUS_COLORS[agent.status] || "var(--text-muted)" }}
          />
          <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
            {agent.name}
          </span>
          <span
            className="text-[9px] font-mono"
            style={{ color: "var(--text-muted)" }}
          >
            {agent.model || agent.source}
          </span>
        </div>
      )}

      {/* Progress bar */}
      <div className="mb-2">
        <div
          className="progress-track"
          style={{ height: "4px" }}
        >
          <div
            className="progress-fill"
            style={{
              width: `${task.progress}%`,
              background:
                task.status === "failed"
                  ? "var(--accent-red)"
                  : task.status === "done"
                    ? "var(--success)"
                    : "var(--accent-cyan)",
            }}
          />
        </div>
        <div
          className="text-right text-[10px] font-mono mt-0.5"
          style={{ color: "var(--text-muted)" }}
        >
          {task.progress}%
        </div>
      </div>

      {/* Footer */}
      <div
        className="flex items-center gap-2 text-[10px] font-mono"
        style={{ color: "var(--text-muted)" }}
      >
        <Clock size={10} />
        <span>{fmtTime(task.updatedAt)}</span>
        {task.error && (
          <>
            <span>·</span>
            <AlertTriangle size={10} style={{ color: "var(--accent-red)" }} />
            <span style={{ color: "var(--accent-red)" }}>有错误</span>
          </>
        )}
      </div>
    </div>
  );
});
