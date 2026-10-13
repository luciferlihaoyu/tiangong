/**
 * 天宫 任务指挥中心 — TaskCenter (P4)
 *
 * 整合执行引擎、任务创建/查询/状态更新、任务记事板
 * 页面路由 /missions 已由 MissionLog 占用，本文件作为新页面
 * 同时创建独立的 /task-center 路由入口
 *
 * 拆分后本文件只承担容器职责（状态、查询、WS 订阅、布局、行渲染）；
 * 类型/常量/子组件已逐段搬迁至 src/components/taskcenter/，行为保持。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { TASK_STATUS_CONFIG as STATUS_CONFIG } from "@/lib/taskStatus";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";
import { toast } from "sonner";
import { Activity, Plus, RefreshCw, Search, Target } from "lucide-react";
import { StatsRow } from "@/components/taskcenter/StatsRow";
import { TaskCard } from "@/components/taskcenter/TaskCard";
import { TaskDetailDrawer } from "@/components/taskcenter/TaskDetailDrawer";
import { CollaborationPanel } from "@/components/taskcenter/CollaborationPanel";
import { CreateTaskDialog } from "@/components/taskcenter/CreateTaskDialog";
import type { Agent, Conversation, Task } from "@/components/taskcenter/types";

// ═══════════════════════ Page ═══════════════════════

export default function TaskCenter() {
  const [showCreate, setShowCreate] = useState(false);
  const [detailTask, setDetailTask] = useState<Task | null>(null);
  const [filterStatus, setFilterStatus] = useState<string>("");
  const [filterAgentId, setFilterAgentId] = useState<number | undefined>();
  const [keyword, setKeyword] = useState("");

  // P5/P6: Runner status poll
  const [runnerStatus, setRunnerStatus] = useState<{
    enabled: boolean;
    mode: string;
    intervalMs: number;
    running: boolean;
    commandConfigured: boolean;
    execMode?: string;
    execFileConfigured?: boolean;
    execArgsConfigured?: boolean;
    execArgsValid?: boolean;
    execArgsCount?: number;
    legacyCommandConfigured?: boolean;
    consecutiveErrors: number;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const poll = () => {
      fetch("/api/runner/status")
        .then((r) => r.json())
        .then((d) => { if (active && d.runner) setRunnerStatus(d.runner); })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 10000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const agentQuery = trpc.agent.list.useQuery(undefined, { retry: 1, staleTime: 15000 });
  // useMemo 收口：data 未到时 || [] 每渲染都会造新数组，会让下面 agentById 的
  // useMemo 依赖每渲染失效（exhaustive-deps 提示）；memo 后引用稳定，内容不变。
  const agents = useMemo(() => (agentQuery.data || []) as Agent[], [agentQuery.data]);

  // 行内 agent 解析收口到容器：Map 仅在 agents 引用变化时重建（react-query
  // 结构共享下 agents 元素引用稳定），TaskCard 拿到的 agent 引用因此跨渲染稳定，
  // memo 不会被击穿；同时省掉每行一次的 O(n) find。
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  // taskboard.list 的 boardStatus 是看板状态枚举（triage/backlog/todo/ready/
  // running/review/blocked/done/failed/cancelled），UI 顶栏 STATUS_CONFIG
  // 是生命周期 status（pending/queued/running/done/failed）。两者重叠子集
  // 不够覆盖生命周期过滤，t3 阶段做完整语义映射：
  //   pending  → backlog（待处理/未排期）
  //   queued   → todo    （已排队/可执行）
  //   running  → running（直传）
  //   done     → done   （直传）
  //   failed   → failed （直传）
  // boardStatus 字段必填枚举值之一，否则后端 zod 拒绝。
  const statusToBoardStatus: Record<string, "backlog" | "todo" | "running" | "done" | "failed"> = {
    pending: "backlog",
    queued: "todo",
    running: "running",
    done: "done",
    failed: "failed",
  };
  const boardStatusFilter = filterStatus ? statusToBoardStatus[filterStatus] : undefined;
  const taskQuery = trpc.taskboard.list.useQuery(
    { boardStatus: boardStatusFilter, agentId: filterAgentId, keyword: keyword || undefined },
    { retry: 1, staleTime: 5000 }
  );
  const tasks = (taskQuery.data || []) as Task[];

  const convQuery = trpc.conversation.list.useQuery(
    { status: "active" },
    { retry: 1, staleTime: 30000 }
  );
  const conversations = (convQuery.data || []) as Conversation[];

  const utils = trpc.useUtils();

  // mutate 从 useMutation 结果解构：react-query v5 的 mutate 是 useCallback([observer])
  // 稳定引用（结果对象本身每渲染都是新的），行级 useCallback 依赖它才稳定。
  const { mutate: deleteMutate } = trpc.taskboard.delete.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
    },
  });

  // Dashboard WebSocket：按消息类型精准订阅（P1-1 共享连接层多路分发契约）。
  // 旧实现消费 lastMessage：任何类型消息到达都会 setLastMessage → 容器重渲染后
  // 重跑类型守卫；新实现仅 task_update / collab_* 到达时触发对应 invalidate，
  // 其余类型零失效、零额外渲染。addEventListener/removeEventListener 是
  // useWebSocket 的 useCallback([]) 稳定引用，utils 亦稳定（Provider 端 useMemo），
  // 本 effect 仅挂载时注册一次。
  // ⚠️ 类型注册表挂在模块级共享连接上：cleanup 必须逐键配对退订，漏配对即永久泄漏。
  const { addEventListener, removeEventListener } = useWebSocket();
  useEffect(() => {
    const onTaskUpdate = () => {
      utils.taskboard.list.invalidate();
      utils.orch.getOverview.invalidate();
    };
    const onCollabEvent = () => {
      utils.taskboard.list.invalidate();
      utils.collab.status.invalidate();
      utils.collab.summary.invalidate();
    };
    const collabTypes = ["collab_summary", "collab_unblocked", "collab_delegation_message"] as const;
    addEventListener("task_update", onTaskUpdate);
    for (const type of collabTypes) {
      addEventListener(type, onCollabEvent);
    }
    return () => {
      removeEventListener("task_update", onTaskUpdate);
      for (const type of collabTypes) {
        removeEventListener(type, onCollabEvent);
      }
    };
  }, [utils, addEventListener, removeEventListener]);

  const refresh = useCallback(() => {
    utils.taskboard.list.invalidate();
  }, [utils]);

  // —— 行级回调（TaskCard memo 契约）——依赖全部是跨渲染引用稳定的对象：
  // setState（React 保证稳定）/ react-query mutate（稳定）/ utils（稳定）。
  const handleView = useCallback((task: Task) => {
    setDetailTask(task);
  }, []);

  const handleDelete = useCallback((task: Task) => {
    if (window.confirm(`确定要删除任务「${task.name}」(${task.taskId}) 吗？`)) {
      deleteMutate({ taskId: task.id });
    }
  }, [deleteMutate]);

  // P9: Priority promote/demote
  const { mutate: promoteMutate } = trpc.taskboard.promote.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
    },
  });

  // Dispatch mutation
  const { mutate: dispatchMutate } = trpc.taskboard.dispatch.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.orch.getOverview.invalidate();
      toast.success("任务已派发，Connector 将自动认领");
    },
    onError: (err) => {
      toast.error(`派发失败: ${err.message}`);
    },
  });

  const handlePromote = useCallback((task: Task) => {
    promoteMutate({ taskId: task.id, delta: 1 });
  }, [promoteMutate]);

  const handleDemote = useCallback((task: Task) => {
    if (task.priority > 0) {
      promoteMutate({ taskId: task.id, delta: -1 });
    }
  }, [promoteMutate]);

  const handleDispatch = useCallback((task: Task) => {
    dispatchMutate({ taskId: task.id });
  }, [dispatchMutate]);

  return (
    <div
      className="min-h-screen pt-16 px-4 md:px-6 max-w-7xl mx-auto"
      style={{ backgroundColor: "var(--bg-primary)" }}
    >
      {/* Page Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1
            className="text-xl font-black tracking-widest"
            style={{ color: "var(--text-primary)" }}
          >
            任务指挥中心
          </h1>
          <p className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
            TASK CENTER · CREATE / ASSIGN / TRACK
          </p>
          {/* P5: Runner status badge */}
          {runnerStatus && (
            <div className="flex items-center gap-2 mt-2">
              <span className="flex items-center gap-1.5" style={{
                background: runnerStatus.running ? "rgba(76,175,125,0.08)" : "rgba(180,200,255,0.03)",
                border: `1px solid ${runnerStatus.running ? "rgba(76,175,125,0.2)" : "var(--border-default)"}`,
                padding: "2px 8px",
                borderRadius: "4px",
                fontSize: "10px",
                fontFamily: "monospace",
              }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{
                  background: runnerStatus.running ? "var(--success)" : "var(--text-muted)",
                }} />
                <Activity size={10} style={{ color: runnerStatus.running ? "var(--success)" : "var(--text-muted)" }} />
                <span style={{
                  color: runnerStatus.running ? "var(--success)" : "var(--text-muted)",
                }}>
                  Runner {runnerStatus.running ? "ACTIVE" : "STOPPED"}
                </span>
              </span>
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                {runnerStatus.mode} · {runnerStatus.intervalMs}ms
              </span>
              {/* P6: execMode badge */}
              {runnerStatus.mode === "command" && runnerStatus.execMode && runnerStatus.execMode !== "none" && (
                <span className="text-[10px] font-mono" style={{ color: "var(--accent-cyan)" }}>
                  {runnerStatus.execMode}
                  {runnerStatus.execArgsCount !== undefined && runnerStatus.execArgsCount > 0 && (
                    <span style={{ color: "var(--text-muted)" }}>·{runnerStatus.execArgsCount}args</span>
                  )}
                </span>
              )}
              {runnerStatus.legacyCommandConfigured && (
                <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>
                  legacy
                </span>
              )}
              {runnerStatus.consecutiveErrors > 0 && (
                <span style={{
                  background: "var(--accent-glow-red)",
                  color: "var(--accent-red)",
                  padding: "1px 6px",
                  borderRadius: "3px",
                  fontSize: "10px",
                  fontFamily: "monospace",
                }}>
                  ERR:{runnerStatus.consecutiveErrors}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="px-3 py-2 rounded text-xs font-mono transition-colors hover:bg-[rgba(180,200,255,0.05)] flex items-center gap-1"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={12} /> 刷新
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

      {/* Stats */}
      <StatsRow tasks={tasks} />

      {/* P8.3 Collaboration */}
      <CollaborationPanel tasks={tasks} agents={agents} />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Search */}
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded" style={{ background: "rgba(0,0,0,0.15)", border: "1px solid var(--border-default)" }}>
          <Search size={14} style={{ color: "var(--text-muted)" }} />
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索标题/描述..."
            className="bg-transparent text-xs outline-none w-48"
            style={{ color: "var(--text-primary)" }}
          />
        </div>

        {/* Status filter */}
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="px-3 py-1.5 rounded text-xs outline-none font-mono"
          style={{
            background: "rgba(0,0,0,0.15)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
          }}
        >
          <option value="">全部状态</option>
          {Object.entries(STATUS_CONFIG).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>

        {/* Agent filter */}
        <select
          value={filterAgentId ?? ""}
          onChange={(e) => setFilterAgentId(e.target.value ? Number(e.target.value) : undefined)}
          className="px-3 py-1.5 rounded text-xs outline-none font-mono"
          style={{
            background: "rgba(0,0,0,0.15)",
            border: "1px solid var(--border-default)",
            color: "var(--text-primary)",
          }}
        >
          <option value="">全部 Agent</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        {/* Online filter */}
        <div className="flex items-center gap-2 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} />
            在线 {agents.filter((a) => a.status === "online").length}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--warning)" }} />
            忙碌 {agents.filter((a) => a.status === "busy").length}
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--text-muted)" }} />
            空闲 {agents.filter((a) => a.status === "idle").length}
          </span>
        </div>
      </div>

      {/* Loading */}
      {taskQuery.isLoading && (
        <div
          className="text-sm font-mono text-center py-12"
          style={{ color: "var(--text-muted)" }}
        >
          加载任务列表...
        </div>
      )}

      {/* Error */}
      {taskQuery.isError && (
        <div className="text-sm" style={{ color: "var(--accent-red)" }}>
          加载失败: {taskQuery.error?.message}
        </div>
      )}

      {/* Empty */}
      {!taskQuery.isLoading && !taskQuery.isError && tasks.length === 0 && (
        <div className="glass-panel p-8 text-center sci-border">
          <Target
            size={48}
            className="mx-auto mb-3 opacity-20"
            style={{ color: "var(--text-muted)" }}
          />
          <div className="text-sm font-mono" style={{ color: "var(--text-muted)" }}>
            {keyword || filterStatus || filterAgentId
              ? "没有匹配的任务"
              : "暂无任务，点击「创建任务」开始"}
          </div>
        </div>
      )}

      {/* Task Grid */}
      {tasks.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agent={task.agentId != null ? agentById.get(task.agentId) : undefined}
              onView={handleView}
              onDelete={handleDelete}
              onPromote={handlePromote}
              onDemote={handleDemote}
              onDispatch={handleDispatch}
            />
          ))}
        </div>
      )}

      {/* Create Dialog */}
      <CreateTaskDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        agents={agents}
      />

      {/* Detail Drawer */}
      {detailTask && (
        <TaskDetailDrawer
          task={detailTask}
          agents={agents}
          conversations={conversations}
          open={detailTask !== null}
          onClose={() => setDetailTask(null)}
        />
      )}
    </div>
  );
}
