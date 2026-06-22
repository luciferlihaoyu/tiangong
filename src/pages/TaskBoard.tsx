import { useState, useCallback, useMemo, useEffect } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";
import { KanbanColumn } from "@/components/taskboard/KanbanColumn";
import { TaskDetailModal } from "@/components/taskboard/TaskDetailModal";
import { CreateTaskModal } from "@/components/taskboard/CreateTaskModal";
import type { Task, TaskDetail, Agent, BoardStatus } from "@/components/taskboard/types";
import { BOARD_STATUSES, BOARD_STATUS_CONFIG } from "@/components/taskboard/types";
import { toast } from "sonner";
import { Plus, RefreshCw, Search, Layout, Shield } from "lucide-react";

export default function TaskBoard() {
  const navigate = useNavigate();
  const [draggedTaskId, setDraggedTaskId] = useState<number | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [dropError, setDropError] = useState<string | null>(null);

  const utils = trpc.useUtils();

  // Fetch data
  const agentQuery = trpc.agent.list.useQuery(undefined, { retry: 1, staleTime: 15000 });
  const agents = (agentQuery.data || []) as Agent[];

  const taskQuery = trpc.taskboard.list.useQuery(
    { keyword: keyword || undefined },
    { retry: 1, staleTime: 5000 }
  );
  const tasks = (taskQuery.data || []) as Task[];

  const detailQuery = trpc.taskboard.get.useQuery(
    { id: detailTaskId ?? 0 },
    { enabled: detailTaskId !== null, retry: 1, staleTime: 5000 }
  );
  const detailTask = (detailQuery.data || null) as TaskDetail | null;

  const firstAgent = agents.find((a) => a.status === "online");
  const currentAgentId = firstAgent?.id ?? agents[0]?.id;

  const reviewTasksQuery = trpc.taskboard.listReviewTasks.useQuery(
    { agentId: currentAgentId ?? 0 },
    { enabled: currentAgentId !== undefined, retry: 1, staleTime: 5000 }
  );
  const myReviewTasks = (reviewTasksQuery.data || []) as Task[];

  // WebSocket updates
  const { lastMessage } = useWebSocket();
  useEffect(() => {
    if (!lastMessage) return;
    if (lastMessage.type === "task_update") {
      utils.taskboard.list.invalidate();
      if (detailTaskId) {
        utils.taskboard.get.invalidate({ id: detailTaskId });
      }
    }
    if (lastMessage.type === "task_notification") {
      const { taskName, fromStatus, toStatus, changedBy } = lastMessage;
      const fromLabel = BOARD_STATUS_CONFIG[fromStatus as BoardStatus]?.label || fromStatus;
      const toLabel = BOARD_STATUS_CONFIG[toStatus as BoardStatus]?.label || toStatus;
      const byAgent = agents.find((a) => a.id === changedBy);
      const byName = byAgent ? byAgent.name : `Agent #${changedBy}`;
      toast.info(`「${taskName}」 ${fromLabel} → ${toLabel} by ${byName}`, {
        duration: 4000,
      });
      utils.taskboard.list.invalidate();
      if (currentAgentId) {
        utils.taskboard.listReviewTasks.invalidate({ agentId: currentAgentId });
      }
    }
    if (lastMessage.type === "mailbox_message_sent") {
      const { subject, fromMailboxId, toMailboxId } = lastMessage as any;
      if (toMailboxId && currentAgentId) {
        const toAgent = agents.find((a) => a.agentId === toMailboxId);
        if (toAgent?.id === currentAgentId) {
          toast.info(`新消息: ${subject || "Mailbox message"}`, { duration: 5000 });
        }
      }
    }
  }, [lastMessage, utils, detailTaskId, agents, currentAgentId]);

  // Group tasks by boardStatus
  const groupedTasks = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const s of BOARD_STATUSES) {
      map[s] = [];
    }
    for (const t of tasks) {
      const status = t.boardStatus || "triage";
      if (!map[status]) map[status] = [];
      map[status].push(t);
    }
    return map;
  }, [tasks]);

  // Update status mutation for drag and drop
  const updateStatusMutation = trpc.taskboard.updateStatus.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      setDropError(null);
    },
    onError: (err) => setDropError(err.message),
  });

  const handleDragStart = useCallback((taskId: number) => {
    setDraggedTaskId(taskId);
    setDropError(null);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggedTaskId(null);
  }, []);

  const handleDrop = useCallback(
    (taskId: number, status: BoardStatus) => {
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      const from = (task.boardStatus || "triage") as BoardStatus;
      if (from === status) return;

      const firstAgent = agents.find((a) => a.status === "online");
      const agentId = task.agentId || firstAgent?.id || agents[0]?.id;
      if (!agentId) {
        setDropError("无可用的 Agent 执行状态变更");
        return;
      }

      updateStatusMutation.mutate({ taskId, agentId, boardStatus: status });
      setDraggedTaskId(null);
    },
    [tasks, agents, updateStatusMutation]
  );

  const handleTaskClick = useCallback((task: Task) => {
    setDetailTaskId(task.id);
  }, []);

  const handleRefresh = useCallback(() => {
    utils.taskboard.list.invalidate();
  }, [utils]);

  // Stats for header
  const stats = useMemo(() => {
    const total = tasks.length;
    const running = tasks.filter((t) => t.boardStatus === "running").length;
    const review = tasks.filter((t) => t.boardStatus === "review").length;
    const blocked = tasks.filter((t) => t.boardStatus === "blocked").length;
    const done = tasks.filter((t) => t.boardStatus === "done").length;
    return { total, running, review, blocked, done };
  }, [tasks]);

  return (
    <div
      className="min-h-screen pt-16 flex flex-col"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {/* Header */}
      <div className="px-4 md:px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-4">
          <div>
            <h1
              className="text-xl font-black tracking-widest flex items-center gap-2"
              style={{ color: "var(--text-primary)" }}
            >
              <Layout size={22} style={{ color: "var(--accent-cyan)" }} />
              任务板
            </h1>
            <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
              TASK BOARD · KANBAN
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRefresh}
              className="px-3 py-2 rounded text-xs font-mono transition-colors hover:bg-[rgba(180,200,255,0.05)] flex items-center gap-1"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={12} />
              刷新
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-2 rounded text-xs font-bold tracking-wide transition-all hover:brightness-110 flex items-center gap-2"
              style={{
                background: "var(--accent-cyan)",
                color: "#fff",
                boxShadow: "0 0 16px rgba(74,158,255,0.25)",
              }}
            >
              <Plus size={14} />
              创建任务
            </button>
          </div>
        </div>

        {/* Stats row */}
        <div className="flex flex-wrap gap-3 mb-4">
          {[
            { key: "total", label: "全部", color: "var(--text-primary)", bg: "rgba(255,255,255,0.02)", icon: null },
            { key: "running", label: "执行中", color: "#4a9eff", bg: "rgba(74,158,255,0.05)", icon: null },
            { key: "review", label: "审核中", color: "#c9a84c", bg: "rgba(201,168,76,0.05)", icon: null },
            { key: "blocked", label: "阻塞", color: "#c23a30", bg: "rgba(194,58,48,0.05)", icon: null },
            { key: "done", label: "已完成", color: "#4caf7d", bg: "rgba(76,175,125,0.05)", icon: null },
            { key: "myReviews", label: "待我审核", color: "#c9a84c", bg: "rgba(201,168,76,0.08)", icon: Shield },
          ].map((s) => (
            <div
              key={s.key}
              className="flex items-center gap-2 px-3 py-1.5 rounded font-mono"
              style={{ background: s.bg, border: "1px solid var(--border-default)" }}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.color }} />
              <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
                {s.label}
              </span>
              <span className="text-xs font-bold" style={{ color: s.color }}>
                {s.key === "myReviews" ? myReviewTasks.length : stats[s.key as keyof typeof stats]}
              </span>
              {s.icon && <s.icon size={10} style={{ color: s.color }} />}
            </div>
          ))}
        </div>

        {/* Search + drop error */}
        <div className="flex items-center gap-3 mb-2 flex-wrap">
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 rounded"
            style={{ background: "rgba(0,0,0,0.15)", border: "1px solid var(--border-default)" }}
          >
            <Search size={14} style={{ color: "var(--text-muted)" }} />
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索任务..."
              className="bg-transparent text-xs outline-none w-48"
              style={{ color: "var(--text-primary)" }}
            />
          </div>
          {dropError && (
            <div
              className="text-xs px-2 py-1 rounded font-mono"
              style={{ background: "var(--accent-glow-red)", color: "var(--accent-red)" }}
            >
              {dropError}
            </div>
          )}
        </div>
      </div>

      {/* Loading / Empty */}
      {taskQuery.isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
            加载任务列表...
          </div>
        </div>
      )}
      {!taskQuery.isLoading && !taskQuery.isError && tasks.length === 0 && (
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="glass-panel p-8 text-center sci-border max-w-md">
            <Layout size={48} className="mx-auto mb-3 opacity-20" style={{ color: "var(--text-muted)" }} />
            <div className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
              {keyword ? "没有匹配的任务" : "暂无任务，点击「创建任务」开始"}
            </div>
          </div>
        </div>
      )}

      {/* Kanban Columns */}
      {tasks.length > 0 && (
        <div className="flex-1 overflow-x-auto overflow-y-hidden px-4 md:px-6 pb-6 custom-scrollbar">
          <div className="flex gap-3 h-full">
            {BOARD_STATUSES.map((status) => (
              <KanbanColumn
                key={status}
                status={status}
                tasks={groupedTasks[status] || []}
                agents={agents}
                draggedTaskId={draggedTaskId}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop}
                onTaskClick={handleTaskClick}
              />
            ))}
          </div>
        </div>
      )}

      {/* Detail Modal */}
      <TaskDetailModal
        task={detailTask}
        agents={agents}
        allTasks={tasks}
        open={detailTaskId !== null}
        onClose={() => setDetailTaskId(null)}
      />

      {/* Create Modal */}
      <CreateTaskModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        agents={agents}
        allTasks={tasks}
      />
    </div>
  );
}
