/**
 * P8.3 协作编排台 — 自 src/pages/TaskCenter.tsx 逐段搬迁（原 L911-1155），行为保持。
 * parseSubtaskLines 为纯函数，导出供 tests/frontend/taskcenter-parse-subtasks.test.ts
 * 钉住既有行为（表征测试）。
 */
import { useEffect, useState } from "react";
import { TASK_STATUS_CONFIG as STATUS_CONFIG } from "@/lib/taskStatus";
import { trpc } from "@/providers/trpc";
import type { Agent, CollabStatus, CollabSubtask, CollabSummary, Task } from "./types";

export interface CollabPanelProps {
  tasks: Task[];
  agents: Agent[];
}

export function parseSubtaskLines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [titleRaw, agentRaw, priorityRaw, ...descParts] = line.split("|").map((part) => part.trim());
      return {
        title: titleRaw,
        assigneeAgentId: Number(agentRaw),
        priority: priorityRaw ? Number(priorityRaw) : 0,
        description: descParts.join("|") || undefined,
      };
    });
}

export function CollaborationPanel({ tasks, agents }: CollabPanelProps) {
  const utils = trpc.useUtils();
  const parentTasks = tasks.filter((task) => !task.parentTaskId);
  const [parentTaskId, setParentTaskId] = useState<number | null>(parentTasks[0]?.id ?? null);
  const [coordinatorAgentId, setCoordinatorAgentId] = useState<number | null>(agents[0]?.id ?? null);
  const [draft, setDraft] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    if (!parentTaskId && parentTasks[0]) setParentTaskId(parentTasks[0].id);
  }, [parentTaskId, parentTasks]);

  useEffect(() => {
    if (!coordinatorAgentId && agents[0]) setCoordinatorAgentId(agents[0].id);
  }, [coordinatorAgentId, agents]);

  const statusQuery = trpc.collab.status.useQuery(
    { parentTaskId: parentTaskId ?? 0 },
    { enabled: Boolean(parentTaskId), retry: 1, staleTime: 5000 }
  );
  const summaryQuery = trpc.collab.summary.useQuery(
    { parentTaskId: parentTaskId ?? 0 },
    { enabled: Boolean(parentTaskId), retry: 1, staleTime: 5000 }
  );

  const delegateMutation = trpc.collab.delegate.useMutation({
    onSuccess: () => {
      setLastError(null);
      setDraft("");
      utils.taskboard.list.invalidate();
      utils.collab.status.invalidate();
      utils.collab.summary.invalidate();
    },
    onError: (err) => setLastError(err.message),
  });

  const unblockMutation = trpc.collab.unblockReady.useMutation({
    onSuccess: () => {
      utils.taskboard.list.invalidate();
      utils.collab.status.invalidate();
      utils.collab.summary.invalidate();
    },
    onError: (err) => setLastError(err.message),
  });

  const handleDelegate = () => {
    setLastError(null);
    if (!parentTaskId || !coordinatorAgentId) {
      setLastError("请选择父任务和协调 Agent");
      return;
    }
    const subtasks = parseSubtaskLines(draft);
    if (subtasks.length === 0) {
      setLastError("请输入至少一个子任务");
      return;
    }
    const invalid = subtasks.find((item) => !item.title || !item.assigneeAgentId || Number.isNaN(item.assigneeAgentId));
    if (invalid) {
      setLastError("格式错误：每行使用 标题 | Agent数字ID | 优先级 | 描述");
      return;
    }
    delegateMutation.mutate({
      parentTaskId,
      coordinatorAgentId,
      subtasks,
    });
  };

  const handleUnblock = () => {
    if (!parentTaskId) return;
    unblockMutation.mutate({ parentTaskId });
  };

  const summary: CollabSummary | undefined = summaryQuery.data;
  const status: CollabStatus | undefined = statusQuery.data;
  const counts: Partial<Record<Task["status"], number>> = summary?.counts ?? status?.counts ?? {};
  const summaryOutputs = summary?.outputs ?? [];
  const summaryErrors = summary?.errors ?? [];

  return (
    <div className="glass-panel p-4 sci-border mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <div className="text-sm font-bold tracking-wide" style={{ color: "var(--text-primary)" }}>
            P8.3 协作编排台
          </div>
          <div className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
            COLLAB · DELEGATE / TRACK / SUMMARY
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => {
              if (parentTaskId) {
                utils.collab.status.invalidate({ parentTaskId });
                utils.collab.summary.invalidate({ parentTaskId });
              }
            }}
            className="text-[11px] px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)]"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            刷新协作状态
          </button>
          <button
            onClick={handleUnblock}
            disabled={!parentTaskId || unblockMutation.isPending}
            className="text-[11px] px-3 py-1.5 rounded font-bold hover:brightness-110 disabled:opacity-50"
            style={{ background: "rgba(74,158,255,0.1)", color: "var(--accent-cyan)", border: "1px solid rgba(74,158,255,0.2)" }}
          >
            {unblockMutation.isPending ? "检查中..." : "推进可运行子任务"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-4">
        <div>
          <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>父任务 · PARENT</label>
          <select
            value={parentTaskId ?? ""}
            onChange={(e) => setParentTaskId(e.target.value ? Number(e.target.value) : null)}
            className="w-full px-3 py-2 rounded text-xs outline-none"
            style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
          >
            <option value="">选择父任务</option>
            {parentTasks.map((task) => (
              <option key={task.id} value={task.id}>{task.taskId} · {task.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>协调 Agent · COORDINATOR</label>
          <select
            value={coordinatorAgentId ?? ""}
            onChange={(e) => setCoordinatorAgentId(e.target.value ? Number(e.target.value) : null)}
            className="w-full px-3 py-2 rounded text-xs outline-none"
            style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
          >
            <option value="">选择协调者</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>#{agent.id} · {agent.name}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-5 gap-1 text-center">
          {(["pending", "queued", "running", "done", "failed"] as const).map((key) => (
            <div key={key} className="rounded px-1 py-2" style={{ background: STATUS_CONFIG[key].bg, border: "1px solid var(--border-default)" }}>
              <div className="text-sm font-bold font-mono" style={{ color: STATUS_CONFIG[key].color }}>{counts[key] ?? 0}</div>
              <div className="text-[9px]" style={{ color: "var(--text-muted)" }}>{STATUS_CONFIG[key].label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>
            子任务列表 · 每行：标题 | Agent数字ID | 优先级 | 描述
          </label>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={6}
            placeholder={agents[0] ? `示例：\n调研方案 | ${agents[0].id} | 3 | 收集背景和约束\n实现原型 | ${agents[0].id} | 4 | 输出可验证改动` : "先创建/加载 Agent"}
            className="w-full px-3 py-2 rounded text-xs outline-none resize-none font-mono"
            style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
          />
          <div className="flex items-center justify-between mt-2 gap-2">
            <div className="text-[10px] font-mono" style={{ color: lastError ? "var(--accent-red)" : "var(--text-muted)" }}>
              {lastError || delegateMutation.error?.message || `可用 Agent ID：${agents.map((agent) => `#${agent.id} ${agent.name}`).join(" · ")}`}
            </div>
            <button
              onClick={handleDelegate}
              disabled={delegateMutation.isPending || !parentTaskId || !coordinatorAgentId}
              className="text-[11px] px-4 py-2 rounded font-bold hover:brightness-110 disabled:opacity-50"
              style={{ background: "var(--accent-cyan)", color: "#fff", boxShadow: "0 0 12px rgba(74,158,255,0.2)" }}
            >
              {delegateMutation.isPending ? "委托中..." : "创建并委托"}
            </button>
          </div>
        </div>

        <div className="rounded p-3 max-h-56 overflow-y-auto custom-scrollbar" style={{ background: "rgba(0,0,0,0.16)", border: "1px solid var(--border-default)" }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>协作状态 / 汇总</span>
            <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>{summary?.overallStatus || "—"}</span>
          </div>
          {statusQuery.isLoading && <div className="text-xs" style={{ color: "var(--text-muted)" }}>加载协作状态...</div>}
          {!statusQuery.isLoading && (!status?.subtasks || status.subtasks.length === 0) && (
            <div className="text-xs" style={{ color: "var(--text-muted)" }}>暂无子任务。选择父任务后输入子任务并委托。</div>
          )}
          <div className="space-y-2">
            {(status?.subtasks || []).map((item: CollabSubtask) => {
              const task = item.task;
              const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending;
              return (
                <div key={task.id} className="rounded p-2" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-default)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold truncate" style={{ color: "var(--text-primary)" }}>{task.taskId} · {task.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: sc.bg, color: sc.color }}>{sc.label}</span>
                  </div>
                  <div className="text-[10px] mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
                    Agent: {item.agent?.name || "—"} · Msg: {item.messageStatus || "—"} · ACK: {item.ackedAt ? "yes" : "no"}
                  </div>
                </div>
              );
            })}
          </div>
          {summaryOutputs.length > 0 && (
            <div className="mt-3 text-[10px] font-mono" style={{ color: "var(--success)" }}>
              已收集输出：{summaryOutputs.length} 条
            </div>
          )}
          {summaryErrors.length > 0 && (
            <div className="mt-1 text-[10px] font-mono" style={{ color: "var(--accent-red)" }}>
              错误：{summaryErrors.length} 条
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
