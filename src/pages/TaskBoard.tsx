import { useState, useCallback, useMemo, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useAuth } from "@/hooks/useAuth";
import { KanbanColumn } from "@/components/taskboard/KanbanColumn";
import { TaskDetailModal } from "@/components/taskboard/TaskDetailModal";
import { CreateTaskModal } from "@/components/taskboard/CreateTaskModal";
import type { Task, TaskDetail, Agent, BoardStatus } from "@/components/taskboard/types";
import { BOARD_STATUSES, BOARD_STATUS_CONFIG } from "@/components/taskboard/types";
import { toast } from "sonner";
import { Plus, RefreshCw, Search, Layout, Shield, Gavel, Users } from "lucide-react";

export default function TaskBoard() {
  const navigate = useNavigate();
  const [draggedTaskId, setDraggedTaskId] = useState<number | null>(null);
  // 旧式深链 ?task=<id>（对外契约见 docs/APPROVAL_AND_PREREVIEW.md）。
  // 必须用 useSearchParams 读：本项目是 HashRouter，查询串在 hash 里，
  // window.location.search 恒为空字符串——历史实现正是这么读的，所以该深链从未生效。
  // 新的「查看任务」入口统一走 /tasks/:id 详情页，这里保留旧式链接兼容。
  const [searchParams] = useSearchParams();
  const taskParam = searchParams.get("task");
  const [detailTaskId, setDetailTaskId] = useState<number | null>(() => {
    const n = taskParam ? Number(taskParam) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  });
  // 已在看板上时参数变化（同页跳转不重挂载）也要打开对应详情
  useEffect(() => {
    if (taskParam === null) return;
    const n = Number(taskParam);
    if (Number.isFinite(n) && n > 0) setDetailTaskId(n);
  }, [taskParam]);
  const [showCreate, setShowCreate] = useState(false);
  const [keyword, setKeyword] = useState("");
  const [dropError, setDropError] = useState<string | null>(null);
  // 审批人筛选器（空 = 不过滤，展示全部待审批）。
  // 为什么改：原来用 `agents.find(status === "online")` 把「第一个在线 Agent」当成
  // 登录用户"我"传给 listPendingApprovals，横幅还写「待我审批 N 项」——
  // 这个"我"与真正的登录用户毫无关系，在线列表一变结论就变。
  // 现在默认看全部，要看某人的就由用户在筛选器里显式指定。
  const [approverFilter, setApproverFilter] = useState<string>("");

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

  const { isAdmin } = useAuth();

  // undefined = 不按 agent 过滤。后端 listPendingApprovals 的 agentId 是可选入参：
  // 不传时 review 单返回全部（含 reviewerId 为空的），执行审批(parked) 也全部返回；
  // 传了就只保留 reviewerId 为空的或等于该 agent 的 review 单。
  const approverAgentId = approverFilter ? Number(approverFilter) : undefined;

  const pendingApprovalsQuery = trpc.taskboard.listPendingApprovals.useQuery(
    { agentId: approverAgentId },
    { retry: 1, staleTime: 5000 }
  );
  const pendingApprovals = (pendingApprovalsQuery.data || []) as (Task & {
    pendingType: "review" | "execution_approval";
  })[];

  // 向后兼容：旧变量名指向统一待审批列表
  const myReviewTasks = pendingApprovals;

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
      // 不过滤地整体失效即可（原先按「假我」的 id 精确失效）
      utils.taskboard.listPendingApprovals.invalidate();
    }
    if (lastMessage.type === "mailbox_message_sent") {
      const { subject, fromMailboxId, toMailboxId } = lastMessage as any;
      // 前端没有「当前登录 Agent」这个概念（登录用户是平台账号，不是 Agent），
      // 所以无法判断这条消息是不是"我的"；如实播报收件箱与发件人，不虚构归属。
      if (toMailboxId) {
        const toAgent = agents.find((a) => a.agentId === toMailboxId);
        toast.info(
          `新消息: ${subject || "Mailbox message"} → ${toAgent?.name ?? toMailboxId}${
            fromMailboxId ? `（来自 ${fromMailboxId}）` : ""
          }`,
          { duration: 5000 }
        );
      }
    }
  }, [lastMessage, utils, detailTaskId, agents]);

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

      // 状态变更需要记一个"操作 Agent"。原实现拿「第一个在线 Agent」顶替，
      // 会把改动记到无关助手名下；现在改为：任务自己的执行者 → 看板上用户显式
      // 选定的审批人/操作身份 → 都没有就报错要求先选，不猜。
      const agentId = task.agentId ?? approverAgentId;
      if (!agentId) {
        setDropError("未指定操作身份：请先在上方「审批人」筛选器里选一个助手，或给该任务指派执行 Agent");
        return;
      }

      updateStatusMutation.mutate({ taskId, agentId, boardStatus: status });
      setDraggedTaskId(null);
    },
    [tasks, approverAgentId, updateStatusMutation]
  );

  const handleTaskClick = useCallback((task: Task) => {
    setDetailTaskId(task.id);
  }, []);

  // Dispatch mutation for pending tasks
  const dispatchMutation = trpc.taskboard.dispatch.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      toast.success("任务已派发，Connector 将自动认领");
    },
    onError: (err) => {
      toast.error(`派发失败: ${err.message}`);
    },
  });

  const handleDispatch = useCallback((taskId: number) => {
    dispatchMutation.mutate({ taskId });
  }, [dispatchMutation]);

  const handleRefresh = useCallback(() => {
    utils.taskboard.list.invalidate();
  }, [utils]);
  const stats = useMemo(() => {
    const total = tasks.length;
    const running = tasks.filter((t) => t.boardStatus === "running").length;
    const review = tasks.filter((t) => t.boardStatus === "review").length;
    const blocked = tasks.filter((t) => t.boardStatus === "blocked").length;
    const done = tasks.filter((t) => t.boardStatus === "done").length;
    return { total, running, review, blocked, done };
  }, [tasks]);

  /**
   * 待审批任务 id 集合（看板列高亮用）：
   *  - 管理员：全部 review 任务
   *  - 非管理员且未筛选审批人：全部 review 任务（含 reviewerId 为空的未指派单）
   *  - 非管理员且已筛审批人：reviewerId 为空或等于该审批人的 review 任务
   *  - 加上后端 listPendingApprovals 返回的记录（含高风险执行审批 parked）
   * 「我」是谁不再猜测：没有筛选条件时就是"全部待审批"。
   */
  const myReviewTaskIds = useMemo(() => {
    const ids = new Set<number>();
    for (const t of tasks) {
      if (t.boardStatus !== "review") continue;
      if (isAdmin) ids.add(t.id);
      else if (approverAgentId === undefined) ids.add(t.id);
      else if (t.reviewerId === null || t.reviewerId === approverAgentId) ids.add(t.id);
    }
    for (const t of pendingApprovals) {
      if (t.pendingType === "execution_approval" && !isAdmin) continue;
      ids.add(t.id);
    }
    return ids;
  }, [tasks, pendingApprovals, isAdmin, approverAgentId]);

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
            { key: "myReviews", label: "待审批", color: "#c9a84c", bg: "rgba(201,168,76,0.08)", icon: Shield },
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
                {s.key === "myReviews" ? pendingApprovals.length : stats[s.key as keyof typeof stats]}
              </span>
              {s.icon && <s.icon size={10} style={{ color: s.color }} />}
            </div>
          ))}
        </div>

        {/* 待审批 — 默认展示全部（不按 agent 过滤），可用下方「审批人」筛选器显式收窄 */}
        {pendingApprovals.length > 0 && (
          <div
            className="mt-2 mb-3 px-3 py-2.5 rounded flex items-start gap-3"
            style={{
              background: "rgba(201, 168, 76, 0.06)",
              border: "1px solid rgba(201, 168, 76, 0.3)",
            }}
          >
            <Gavel size={16} style={{ color: "var(--accent-gold)", marginTop: 2, flexShrink: 0 }} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="text-xs font-bold" style={{ color: "var(--accent-gold)" }}>
                  待审批 · {pendingApprovals.length} 项
                </span>
                <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                  {approverAgentId === undefined
                    ? "全部审批人（含执行审批高风险卡住与结果审核），点击打开详情处理"
                    : `已按审批人过滤：${
                        agents.find((a) => a.id === approverAgentId)?.name ?? `Agent #${approverAgentId}`
                      }`}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {pendingApprovals.slice(0, 5).map((p) => {
                  const isParked = p.pendingType === "execution_approval";
                  return (
                    <button
                      key={p.id}
                      onClick={() => handleTaskClick(p)}
                      className="text-[10px] px-2 py-1 rounded font-mono flex items-center gap-1 transition-colors hover:bg-[rgba(201,168,76,0.12)]"
                      style={{
                        background: isParked ? "rgba(194, 58, 48, 0.08)" : "rgba(201, 168, 76, 0.08)",
                        color: isParked ? "var(--accent-red)" : "var(--accent-gold)",
                        border: isParked ? "1px solid rgba(194, 58, 48, 0.3)" : "1px solid rgba(201, 168, 76, 0.25)",
                      }}
                      title={p.name}
                    >
                      <Shield size={9} />
                      {p.taskId}
                      {isParked && <span>· 高风险待批</span>}
                      {!isParked && p.reviewerId && (
                        <span style={{ color: "var(--text-muted)" }}>
                          · 审批人{" "}
                          {agents.find((a) => a.id === p.reviewerId)?.name ?? `#${p.reviewerId}`}
                        </span>
                      )}
                    </button>
                  );
                })}
                {pendingApprovals.length > 5 && (
                  <span className="text-[10px] font-mono px-2 py-1" style={{ color: "var(--text-muted)" }}>
                    +{pendingApprovals.length - 5} 更多
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Search + 审批人筛选 + drop error */}
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
          {/* 审批人筛选：空 = 不过滤（看全部待审批）。不再自动认定"我"是谁。 */}
          <div
            className="flex items-center gap-1.5 px-3 py-1.5 rounded"
            style={{ background: "rgba(0,0,0,0.15)", border: "1px solid var(--border-default)" }}
          >
            <Users size={14} style={{ color: "var(--text-muted)" }} />
            <select
              value={approverFilter}
              onChange={(e) => setApproverFilter(e.target.value)}
              className="bg-transparent text-xs outline-none font-mono"
              style={{ color: "var(--text-primary)" }}
              title="审批人筛选：选中后只显示该助手的待审批任务"
            >
              <option value="">审批人：全部</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.agentId})
                </option>
              ))}
            </select>
          </div>
          {approverFilter && (
            <button
              onClick={() => setApproverFilter("")}
              className="text-[10px] font-mono px-2 py-1 rounded"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              清除筛选
            </button>
          )}
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
                myReviewTaskIds={myReviewTaskIds}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop}
                onTaskClick={handleTaskClick}
                onDispatch={handleDispatch}
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
