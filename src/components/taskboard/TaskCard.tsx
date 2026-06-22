import { useMemo } from "react";
import type { Task } from "./types";
import { PRIORITY_COLORS, PRIORITY_LABELS, parseLabels } from "./types";
import { User, Shield } from "lucide-react";

interface TaskCardProps {
  task: Task;
  agents: { id: number; name: string; status: string }[];
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onClick: () => void;
}

export function TaskCard({
  task,
  agents,
  isDragging,
  onDragStart,
  onDragEnd,
  onClick,
}: TaskCardProps) {
  const agent = useMemo(
    () => agents.find((a) => a.id === task.agentId),
    [agents, task.agentId]
  );
  const reviewer = useMemo(
    () => agents.find((a) => a.id === task.reviewerId),
    [agents, task.reviewerId]
  );
  const labels = useMemo(() => parseLabels(task.boardLabels), [task.boardLabels]);

  const priorityColor = PRIORITY_COLORS[task.priority] || PRIORITY_COLORS[0];
  const priorityLabel = PRIORITY_LABELS[task.priority] || "普通";

  const isReviewTask = task.boardStatus === "review";
  const isBlocked = task.boardStatus === "blocked";

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("taskId", String(task.id));
        e.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={onClick}
      className="cursor-grab active:cursor-grabbing rounded-lg p-3 transition-all duration-150 group"
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border-default)",
        opacity: isDragging ? 0.4 : 1,
        boxShadow: isDragging ? "none" : "0 1px 4px rgba(0,0,0,0.1)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-hover)";
        e.currentTarget.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-default)";
        e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.1)";
      }}
    >
      {/* Top row: priority + labels */}
      <div className="flex items-center gap-1.5 flex-wrap mb-2">
        <span
          className="text-[10px] font-semibold px-1.5 py-0.5 rounded flex-shrink-0"
          style={{
            background: `${priorityColor}15`,
            color: priorityColor,
            border: `1px solid ${priorityColor}30`,
          }}
        >
          P{task.priority}
        </span>
        {labels.slice(0, 2).map((label) => (
          <span
            key={label}
            className="text-[9px] px-1.5 py-0.5 rounded"
            style={{
              background: "rgba(0, 191, 165, 0.08)",
              color: "var(--accent-cyan)",
              border: "1px solid rgba(0, 191, 165, 0.15)",
            }}
          >
            {label}
          </span>
        ))}
        {labels.length > 2 && (
          <span
            className="text-[9px] px-1 py-0.5 rounded"
            style={{ color: "var(--text-muted)" }}
          >
            +{labels.length - 2}
          </span>
        )}
      </div>

      {/* Title */}
      <h4
        className="text-xs font-bold leading-snug mb-2 truncate"
        style={{ color: "var(--text-primary)" }}
        title={task.name}
      >
        {task.name}
      </h4>

      {/* Progress (only for running) */}
      {task.boardStatus === "running" && (
        <div className="mb-2">
          <div className="progress-track" style={{ height: "3px" }}>
            <div
              className="progress-fill"
              style={{ width: `${task.progress}%` }}
            />
          </div>
          <div
            className="text-right text-[9px] font-mono mt-0.5"
            style={{ color: "var(--text-muted)" }}
          >
            {task.progress}%
          </div>
        </div>
      )}

      {/* Footer: assignee + reviewer + taskId */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          {agent ? (
            <>
              <span
                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                style={{
                  background:
                    agent.status === "online"
                      ? "var(--success)"
                      : agent.status === "busy"
                        ? "var(--warning)"
                        : "var(--text-muted)",
                }}
              />
              <span
                className="text-[10px] truncate"
                style={{ color: "var(--text-secondary)" }}
              >
                {agent.name}
              </span>
            </>
          ) : (
            <span
              className="flex items-center gap-1 text-[10px]"
              style={{ color: "var(--text-muted)" }}
            >
              <User size={10} />
              未指派
            </span>
          )}
          {isReviewTask && reviewer && (
            <span
              className="text-[9px] px-1 py-0.5 rounded flex items-center gap-1 flex-shrink-0"
              style={{
                background: "rgba(201,168,76,0.08)",
                color: "var(--accent-gold)",
                border: "1px solid rgba(201,168,76,0.15)",
              }}
            >
              <Shield size={8} />
              {reviewer.name}
            </span>
          )}
        </div>
        <span
          className="text-[9px] font-mono flex-shrink-0"
          style={{ color: "var(--text-muted)" }}
        >
          {task.taskId}
        </span>
      </div>
    </div>
  );
}
