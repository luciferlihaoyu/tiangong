import { useState } from "react";
import type { BoardStatus, Task } from "./types";
import { BOARD_STATUS_CONFIG } from "./types";
import { TaskCard } from "./TaskCard";
import { ScrollArea } from "@/components/ui/scroll-area";

interface KanbanColumnProps {
  status: BoardStatus;
  tasks: Task[];
  agents: { id: number; name: string; status: string }[];
  draggedTaskId: number | null;
  onDragStart: (taskId: number) => void;
  onDragEnd: () => void;
  onDrop: (taskId: number, status: BoardStatus) => void;
  onTaskClick: (task: Task) => void;
}

export function KanbanColumn({
  status,
  tasks,
  agents,
  draggedTaskId,
  onDragStart,
  onDragEnd,
  onDrop,
  onTaskClick,
}: KanbanColumnProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const config = BOARD_STATUS_CONFIG[status];

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const taskId = e.dataTransfer.getData("taskId");
    if (taskId) {
      onDrop(Number(taskId), status);
    }
  };

  return (
    <div
      className="flex-shrink-0 flex flex-col rounded-lg transition-colors"
      style={{
        width: "280px",
        minHeight: "400px",
        maxHeight: "calc(100vh - 220px)",
        background: isDragOver
          ? "rgba(74, 158, 255, 0.08)"
          : "rgba(180, 200, 255, 0.015)",
        border: `1px solid ${isDragOver ? "rgba(74, 158, 255, 0.3)" : "var(--border-default)"}`,
      }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Column Header */}
      <div
        className="flex items-center justify-between px-3 py-2.5 rounded-t-lg flex-shrink-0"
        style={{
          borderBottom: `1px solid ${config.borderColor}`,
          background: config.bgColor,
        }}
      >
        <div className="flex items-center gap-2">
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: config.headerColor }}
          />
          <span
            className="text-xs font-bold tracking-wide"
            style={{ color: config.headerColor }}
          >
            {config.label}
          </span>
        </div>
        <span
          className="text-[10px] font-mono px-1.5 py-0.5 rounded"
          style={{
            background: "rgba(0,0,0,0.2)",
            color: "var(--text-muted)",
            border: "1px solid var(--border-default)",
          }}
        >
          {tasks.length}
        </span>
      </div>

      {/* Cards */}
      <ScrollArea className="flex-1 px-2 py-2">
        <div className="flex flex-col gap-1.5">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agents={agents}
              isDragging={draggedTaskId === task.id}
              onDragStart={() => onDragStart(task.id)}
              onDragEnd={onDragEnd}
              onClick={() => onTaskClick(task)}
            />
          ))}
          {tasks.length === 0 && (
            <div
              className="text-center py-6 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              空
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
