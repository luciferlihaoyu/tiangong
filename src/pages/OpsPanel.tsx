/**
 * Phase 3: Ops 作战室 — 多 Agent 运行状态总览
 *
 * 展示：
 * - Agent 在线拓扑
 * - 任务流统计
 * - 模型调用流
 * - 成本热力图
 */
import { useState, useMemo, useEffect, useRef } from "react";
import { trpc } from "@/providers/trpc";
import { useWebSocket } from "@/hooks/useWebSocket";
import {
  Activity,
  Users,
  CheckCircle2,
  XCircle,
  Clock,
  Play,
  BarChart3,
  TrendingUp,
  Database,
  Zap,
  AlertTriangle,
  RefreshCw,
  Server,
  Cpu,
  HardDrive,
} from "lucide-react";

/* ═══════════════════════════════════════════
   类型定义
   ═══════════════════════════════════════════ */

interface AgentStatus {
  id: number;
  agentId: string;
  name: string;
  status: string;
  model: string | null;
  currentTask: string | null;
  lastHeartbeat: string | null;
  spentCents: number | null;
  budgetCents: number | null;
  heartbeatOk: boolean;
  budgetUsed: number;
}

interface TaskStats {
  queued: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
}

interface RecentTask {
  id: number;
  taskId: string;
  name: string;
  status: string;
  priority: number;
  agentId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface RecentModelCall {
  id: number;
  model: string;
  provider: string;
  totalTokens: number;
  costCents: number;
  costMicros?: number;
  highCostModel: string | null;
  source: string | null;
  sessionKey: string | null;
  traceId: string | null;
  agentId: number | null;
  createdAt: string;
}

interface HeatmapDay {
  date: string;
  totalTokens: number;
  callCount: number;
  costCents: number;
  costMicros?: number;
  models: Record<string, { tokens: number; cost: number }>;
}

interface CostHeatmap {
  days: HeatmapDay[];
  totalCostCents: number;
  totalCostMicros?: number;
  totalTokens: number;
  totalCalls: number;
}

interface TodayOverview {
  agents: Record<string, number>;
  tasks: TaskStats;
  usage: {
    totalTokens: number;
    costCents: number;
    costMicros?: number;
    callCount: number;
    highCostCount: number;
  };
}

/* ═══════════════════════════════════════════
   辅助函数
   ═══════════════════════════════════════════ */

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(cents: number): string {
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${cents}¢`;
}

/** 用量成本（微美元）格式化；聚合值可能是字符串，统一 Number 转换 */
function fmtMicros(micros: number | string | null | undefined): string {
  const usd = Number(micros ?? 0) / 1_000_000;
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(6)}`;
}

function microsOf(row: { costMicros?: number | string | null; costCents?: number | string | null }): number {
  const m = Number(row.costMicros ?? 0);
  if (m > 0) return m;
  return Number(row.costCents ?? 0) * 1_000_000;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATUS_COLORS: Record<string, string> = {
  online: "var(--success)",
  busy: "var(--accent-gold)",
  idle: "var(--text-muted)",
  running: "var(--accent-cyan)",
  done: "var(--success)",
  failed: "var(--danger)",
  pending: "var(--accent-gold)",
  queued: "var(--text-muted)",
};

const STATUS_ICONS: Record<string, typeof Activity> = {
  online: Activity,
  busy: Clock,
  idle: Activity,
  running: Play,
  done: CheckCircle2,
  failed: XCircle,
  pending: Clock,
  queued: Clock,
};

/* ═══════════════════════════════════════════
   子组件
   ═══════════════════════════════════════════ */

function StatCard({
  label,
  value,
  sub,
  color,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  icon: React.ReactNode;
}) {
  return (
    <div className="glass-panel p-3 sci-border flex items-center gap-2">
      <div
        className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0"
        style={{ background: "rgba(255,255,255,0.03)" }}
      >
        <span style={{ color }}>{icon}</span>
      </div>
      <div className="min-w-0">
        <div className="text-lg font-bold font-mono" style={{ color }}>
          {value}
        </div>
        <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
          {label}
        </div>
        {sub && (
          <div className="text-[9px] font-mono" style={{ color: "var(--text-secondary)" }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentGrid({ agents }: { agents: AgentStatus[] }) {
  if (agents.length === 0) {
    return (
      <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>
        暂无 Agent 数据
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
      {agents.map((a) => {
        const color = a.heartbeatOk ? STATUS_COLORS[a.status] || "var(--text-muted)" : "var(--danger)";
        const Icon = STATUS_ICONS[a.status] || Activity;
        return (
          <div
            key={a.id}
            className="p-3 rounded text-xs"
            style={{
              background: "rgba(255,255,255,0.02)",
              border: `1px solid ${color}20`,
            }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <Icon size={14} style={{ color }} />
              <span className="font-bold font-mono" style={{ color: "var(--text-primary)" }}>
                {a.name || a.agentId}
              </span>
              {!a.heartbeatOk && (
                <AlertTriangle size={12} style={{ color: "var(--danger)" }} />
              )}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
              <span>ID: {a.agentId}</span>
              <span>状态: {a.status}</span>
              {a.model && <span>模型: {a.model}</span>}
              {a.currentTask && <span>任务: {a.currentTask.slice(0, 20)}</span>}
              {a.lastHeartbeat && (
                <span>
                  心跳: {a.heartbeatOk ? "✅" : "❌"}{" "}
                  {fmtDateTime(a.lastHeartbeat)}
                </span>
              )}
              {a.budgetCents && a.budgetCents > 0 && (
                <span>
                  预算: {fmtCost(a.spentCents ?? 0)}/{fmtCost(a.budgetCents)} (
                  {a.budgetUsed.toFixed(0)}%)
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TaskFlow({ stats, tasks }: { stats: TaskStats; tasks: RecentTask[] }) {
  const statuses = ["queued", "pending", "running", "done", "failed"] as const;
  const maxCount = Math.max(...statuses.map((s) => stats[s]), 1);

  return (
    <div>
      {/* 任务状态条 */}
      <div className="flex items-end gap-2 mb-4" style={{ height: "80px" }}>
        {statuses.map((s) => {
          const count = stats[s];
          const h = Math.max(4, (count / maxCount) * 80);
          const color = STATUS_COLORS[s] || "var(--text-muted)";
          return (
            <div key={s} className="flex-1 flex flex-col items-center">
              <div className="text-[10px] font-mono mb-1" style={{ color }}>
                {count}
              </div>
              <div
                className="w-full rounded-t transition-all"
                style={{
                  height: `${h}px`,
                  background: `linear-gradient(180deg, ${color}, ${color}40)`,
                  opacity: 0.7,
                }}
              />
              <div className="text-[8px] mt-1 font-mono" style={{ color: "var(--text-muted)" }}>
                {s}
              </div>
            </div>
          );
        })}
      </div>

      {/* 最近任务 */}
      {tasks.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
            最近任务
          </div>
          {tasks.map((t) => {
            const Icon = STATUS_ICONS[t.status] || Clock;
            const color = STATUS_COLORS[t.status] || "var(--text-muted)";
            return (
              <div
                key={t.id}
                className="flex items-center justify-between gap-2 py-1.5 px-2 rounded text-[10px] font-mono"
                style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.03)" }}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Icon size={12} style={{ color }} />
                  <span className="truncate max-w-32" style={{ color: "var(--text-primary)" }}>
                    {t.name}
                  </span>
                  <span style={{ color: "var(--text-muted)" }}>#{t.taskId}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {t.priority > 0 && (
                    <span className="text-[8px] px-1 py-0.5 rounded" style={{ background: "rgba(255,200,50,0.1)", color: "var(--accent-gold)" }}>
                      P{t.priority}
                    </span>
                  )}
                  <span style={{ color: "var(--text-muted)" }}>{fmtDateTime(t.createdAt)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModelCallFlow({ calls, loading }: { calls: RecentModelCall[]; loading: boolean }) {
  if (loading) {
    return <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  }

  if (calls.length === 0) {
    return (
      <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>
        暂无模型调用记录
      </div>
    );
  }

  return (
    <div className="space-y-1 max-h-80 overflow-y-auto custom-scrollbar">
      {calls.map((c) => (
        <div
          key={c.id}
          className="flex items-center justify-between gap-2 py-1.5 px-2 rounded text-[10px] font-mono"
          style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.03)" }}
        >
          <div className="flex items-center gap-2 min-w-0">
            {c.highCostModel === "true" ? (
              <AlertTriangle size={12} style={{ color: "var(--danger)" }} />
            ) : (
              <Zap size={12} style={{ color: "var(--accent-cyan)" }} />
            )}
            <span className="truncate max-w-28" style={{ color: "var(--text-primary)" }}>
              {c.model}
            </span>
            {c.source && c.source !== "manual" && (
              <span
                className="text-[8px] px-1 py-0.5 rounded"
                style={{ background: "rgba(255,200,50,0.1)", color: "var(--accent-gold)" }}
              >
                {c.source}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <span style={{ color: "var(--accent-cyan)" }}>{fmtTokens(c.totalTokens)} tok</span>
            {microsOf(c) > 0 && (
              <span style={{ color: "var(--accent-gold)" }}>{fmtMicros(microsOf(c))}</span>
            )}
            {c.traceId && (
              <span style={{ color: "var(--text-muted)" }}>#{c.traceId.slice(0, 8)}</span>
            )}
            <span style={{ color: "var(--text-muted)" }}>{fmtDateTime(c.createdAt)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CostHeatmap({ heatmap, loading }: { heatmap: CostHeatmap | null; loading: boolean }) {
  if (loading) {
    return <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  }

  if (!heatmap || heatmap.days.length === 0) {
    return (
      <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>
        暂无成本数据
      </div>
    );
  }

  const maxCost = Math.max(...heatmap.days.map((d) => microsOf(d)), 1);
  const chartHeight = 100;

  return (
    <div>
      {/* 汇总 */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="p-2 rounded text-center" style={{ background: "rgba(255,255,255,0.02)" }}>
          <div className="text-sm font-bold font-mono" style={{ color: "var(--accent-gold)" }}>
            {fmtMicros(heatmap.totalCostMicros ?? heatmap.totalCostCents * 1_000_000)}
          </div>
          <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>总成本</div>
        </div>
        <div className="p-2 rounded text-center" style={{ background: "rgba(255,255,255,0.02)" }}>
          <div className="text-sm font-bold font-mono" style={{ color: "var(--accent-cyan)" }}>
            {fmtTokens(heatmap.totalTokens)}
          </div>
          <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>总 Token</div>
        </div>
        <div className="p-2 rounded text-center" style={{ background: "rgba(255,255,255,0.02)" }}>
          <div className="text-sm font-bold font-mono" style={{ color: "var(--text-primary)" }}>
            {heatmap.totalCalls}
          </div>
          <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>调用次数</div>
        </div>
      </div>

      {/* 柱状图 */}
      <div className="flex items-end gap-1" style={{ height: `${chartHeight}px` }}>
        {heatmap.days.map((d, i) => {
          const h = Math.max(2, (microsOf(d) / maxCost) * chartHeight);
          return (
            <div key={i} className="flex-1 flex flex-col items-center group relative" style={{ minWidth: "16px" }}>
              <div
                className="absolute -top-4 text-[8px] opacity-0 group-hover:opacity-100 transition-opacity font-mono whitespace-nowrap"
                style={{ color: "var(--accent-gold)" }}
              >
                {fmtMicros(microsOf(d))}
              </div>
              <div
                className="w-full rounded-t transition-all cursor-pointer"
                style={{
                  height: `${h}px`,
                  background: "linear-gradient(180deg, var(--accent-gold), rgba(255,200,50,0.1))",
                  opacity: 0.7,
                }}
                title={`${d.date ?? "未知日期"}: ${fmtMicros(microsOf(d))}, ${fmtTokens(d.totalTokens)} tok, ${d.callCount} 次`}
              />
              <div className="text-[7px] mt-1 font-mono truncate w-full text-center" style={{ color: "var(--text-muted)" }}>
                {d.date?.slice(5) ?? "—"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   主页面
   ═══════════════════════════════════════════ */

interface BackupSnapshotRow {
  name: string;
  mb: number;
  createdAt: string;
  verified: boolean;
  detail: string;
}

interface BackupStatusData {
  ready: boolean;
  reasons: string[];
  lastRunAt: string | null;
  lastReport: {
    ok: boolean;
    detail: string;
    uploadedTo: string | null;
    uploadError: string | null;
  } | null;
  skippedReason: string | null;
  snapshots: BackupSnapshotRow[];
}

/**
 * 数据备份卡片（Phase B §4）。
 *
 * 目标是「傻瓜式」：先给一句人话结论（备份正常 / 还没有备份 / 有快照损坏），
 * 再列出每份快照的大小与校验结果，最后给一个「立即备份」按钮。
 * 不把 JSON 甩给用户看——备份最常见的失效是"其实不可用却没人知道"，
 * 所以结论和校验结论必须摆在最上面。
 */
function DbBackupCard() {
  const statusQuery = trpc.ops.backupStatus.useQuery(undefined, { retry: 1, staleTime: 30_000 });
  const runMutation = trpc.ops.backupRun.useMutation({
    onSuccess: () => {
      void statusQuery.refetch();
    },
  });

  const status = statusQuery.data as BackupStatusData | undefined;
  const snapshots = status?.snapshots ?? [];
  const newest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
  const brokenCount = snapshots.filter((s) => !s.verified).length;

  const verdict = !status
    ? { color: "var(--text-muted)", icon: <Clock size={14} />, text: "读取备份状态中…" }
    : snapshots.length === 0
      ? { color: "var(--accent-gold)", icon: <AlertTriangle size={14} />, text: "还没有任何备份（定时备份默认每天一次）" }
      : brokenCount > 0
        ? { color: "var(--danger)", icon: <XCircle size={14} />, text: `有 ${brokenCount} 份快照未通过完整性校验，不可用于恢复` }
        : { color: "var(--success)", icon: <CheckCircle2 size={14} />, text: `备份正常：共 ${snapshots.length} 份，最近一份可用` };

  const report = runMutation.data as
    | { ok: boolean; detail: string; snapshot?: { name: string }; uploadError?: string }
    | undefined;

  return (
    <div className="glass-panel p-4 sci-border">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          数据备份 · DATABASE BACKUP
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono transition-colors disabled:opacity-50"
          style={{ color: "var(--accent-cyan)", border: "1px solid var(--border-default)" }}
        >
          <HardDrive size={13} />
          {runMutation.isPending ? "备份中…" : "立即备份"}
        </button>
      </div>

      {/* 一句话结论 */}
      <div className="flex items-center gap-2 text-xs font-mono mb-3" style={{ color: verdict.color }}>
        {verdict.icon}
        <span>{verdict.text}</span>
      </div>

      {/* 关键事实 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
          最近备份
          <div className="text-[11px] mt-0.5" style={{ color: "var(--text-primary)" }}>
            {newest ? fmtDateTime(newest.createdAt) : "—"}
          </div>
        </div>
        <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
          保留份数
          <div className="text-[11px] mt-0.5" style={{ color: "var(--text-primary)" }}>
            {snapshots.length} 份
          </div>
        </div>
        <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
          离机上传
          <div className="text-[11px] mt-0.5" style={{ color: status?.lastReport?.uploadError ? "var(--danger)" : "var(--success)" }}>
            {!status?.lastReport
              ? "—"
              : status.lastReport.uploadError
                ? "失败（本地快照仍可用）"
                : status.lastReport.uploadedTo
                  ? "已上传"
                  : "未配置"}
          </div>
        </div>
        <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
          自动备份
          <div className="text-[11px] mt-0.5" style={{ color: status?.skippedReason?.includes("未就绪") ? "var(--accent-gold)" : "var(--text-primary)" }}>
            {status?.skippedReason ?? (status?.lastRunAt ? "已执行" : "待执行")}
          </div>
        </div>
      </div>

      {/* 快照列表：每份都带校验结论 */}
      {snapshots.length > 0 && (
        <div className="space-y-1">
          {[...snapshots].reverse().map((s) => (
            <div key={s.name} className="flex items-center justify-between text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
              <span className="truncate max-w-[46%]">{s.name}</span>
              <span>{s.mb} MB</span>
              <span>{fmtDateTime(s.createdAt)}</span>
              <span style={{ color: s.verified ? "var(--success)" : "var(--danger)" }}>
                {s.verified ? "✓ 可用" : "✗ 损坏"}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 手动备份结果 */}
      {report && (
        <div
          className="mt-3 text-[10px] font-mono px-2 py-1.5 rounded"
          style={{
            color: report.ok ? "var(--success)" : "var(--danger)",
            background: "rgba(180,200,255,0.04)",
            border: "1px solid var(--border-default)",
          }}
        >
          {report.ok ? "✅ 备份完成" : "❌ 备份失败"}：{report.detail}
        </div>
      )}
    </div>
  );
}

export default function OpsPanel() {
  const [showHighCostOnly, setShowHighCostOnly] = useState(false);

  const overviewQuery = trpc.ops.todayOverview.useQuery(undefined, {
    retry: 1,
    staleTime: 10_000,
  });
  const agentStatusQuery = trpc.ops.agentStatus.useQuery(undefined, {
    retry: 1,
    staleTime: 10_000,
  });
  const taskStatsQuery = trpc.ops.taskStats.useQuery(undefined, {
    retry: 1,
    staleTime: 10_000,
  });
  const recentTasksQuery = trpc.ops.recentTasks.useQuery(
    { limit: 10 },
    { retry: 1, staleTime: 10_000 }
  );
  const recentCallsQuery = trpc.ops.recentModelCalls.useQuery(
    { limit: 20, highCostOnly: showHighCostOnly || undefined },
    { retry: 1, staleTime: 10_000 }
  );
  const heatmapQuery = trpc.ops.costHeatmap.useQuery(
    { days: 7 },
    { retry: 1, staleTime: 10_000 }
  );

  const overview = overviewQuery.data as TodayOverview | undefined;
  const agents = (agentStatusQuery.data as AgentStatus[]) || [];
  const taskStats = (taskStatsQuery.data as unknown as TaskStats) || {
    queued: 0, pending: 0, running: 0, done: 0, failed: 0,
  };
  const recentTasks = (recentTasksQuery.data as RecentTask[]) || [];
  const recentCalls = (recentCallsQuery.data as RecentModelCall[]) || [];
  const heatmap = heatmapQuery.data as CostHeatmap | null;

  const loading =
    overviewQuery.isLoading ||
    agentStatusQuery.isLoading ||
    taskStatsQuery.isLoading ||
    recentTasksQuery.isLoading ||
    recentCallsQuery.isLoading ||
    heatmapQuery.isLoading;

  // P10.5: WebSocket 实时推送
  const ws = useWebSocket();
  const [liveEvent, setLiveEvent] = useState<{ type: string; timestamp: string } | null>(null);
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    if (!ws) return;

    const handler = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        // 记录最新事件
        if (data.type) {
          setLiveEvent({ type: data.type, timestamp: data.timestamp || new Date().toISOString() });
        }

        // 重要事件触发自动刷新（节流 5 秒）
        const now = Date.now();
        const importantTypes = [
          "agent.online", "agent.offline",
          "task.created", "task.completed", "task.failed",
          "model.high_cost_alert",
          "fusion.completed",
        ];
        if (importantTypes.includes(data.type) && now - lastRefreshRef.current > 5000) {
          lastRefreshRef.current = now;
          overviewQuery.refetch();
          agentStatusQuery.refetch();
          taskStatsQuery.refetch();
          recentTasksQuery.refetch();
          recentCallsQuery.refetch();
          heatmapQuery.refetch();
        }
      } catch {}
    };

    ws.addEventListener("message", handler);
    return () => ws.removeEventListener("message", handler);
  }, [ws]);

  const handleRefresh = () => {
    overviewQuery.refetch();
    agentStatusQuery.refetch();
    taskStatsQuery.refetch();
    recentTasksQuery.refetch();
    recentCallsQuery.refetch();
    heatmapQuery.refetch();
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              OPS 作战室
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              多 Agent 运行状态 · 任务流 · 模型调用 · 成本监控
            </p>
          </div>
          <div className="flex items-center gap-2">
            {liveEvent && (
              <div className="flex items-center gap-1.5 text-[9px] font-mono px-2 py-1 rounded" style={{ background: "rgba(74,158,255,0.05)", border: "1px solid rgba(74,158,255,0.15)", color: "var(--accent-cyan)" }}>
                <Activity size={10} />
                <span className="truncate max-w-24">{liveEvent.type}</span>
              </div>
            )}
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
        </div>

        {/* 今日概览 */}
        {overview && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 mb-6">
            <StatCard
              label="在线 Agent"
              value={String(overview.agents.online + overview.agents.busy)}
              sub={`${overview.agents.busy} 忙碌中`}
              color="var(--success)"
              icon={<Server size={16} />}
            />
            <StatCard
              label="今日任务"
              value={String(overview.tasks.done + overview.tasks.running + overview.tasks.pending)}
              sub={`${overview.tasks.done} 完成 / ${overview.tasks.failed} 失败`}
              color="var(--accent-cyan)"
              icon={<Activity size={16} />}
            />
            <StatCard
              label="今日 Token"
              value={fmtTokens(overview.usage.totalTokens)}
              sub={`${overview.usage.callCount} 次调用`}
              color="var(--accent-cyan)"
              icon={<Database size={16} />}
            />
            <StatCard
              label="今日成本"
              value={fmtMicros(microsOf(overview.usage))}
              sub={`${overview.usage.highCostCount} 次高价调用`}
              color={overview.usage.highCostCount > 0 ? "var(--danger)" : "var(--accent-gold)"}
              icon={<TrendingUp size={16} />}
            />
            <StatCard
              label="运行中"
              value={String(overview.tasks.running)}
              sub=""
              color="var(--accent-cyan)"
              icon={<Play size={16} />}
            />
            <StatCard
              label="排队中"
              value={String(overview.tasks.queued + overview.tasks.pending)}
              sub=""
              color="var(--accent-gold)"
              icon={<Clock size={16} />}
            />
            <StatCard
              label="失败"
              value={String(overview.tasks.failed)}
              sub=""
              color={overview.tasks.failed > 0 ? "var(--danger)" : "var(--text-muted)"}
              icon={<XCircle size={16} />}
            />
          </div>
        )}

        {/* Agent 在线拓扑 */}
        <div className="glass-panel p-4 sci-border mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Agent 在线状态 · AGENT TOPOLOGY
            </div>
            <div className="flex items-center gap-2 text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
              <span className="flex items-center gap-1"><span style={{ color: "var(--success)" }}>●</span> 在线</span>
              <span className="flex items-center gap-1"><span style={{ color: "var(--accent-gold)" }}>●</span> 忙碌</span>
              <span className="flex items-center gap-1"><span style={{ color: "var(--danger)" }}>●</span> 心跳异常</span>
            </div>
          </div>
          <AgentGrid agents={agents} />
        </div>

        {/* 任务流 + 模型调用流 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* 任务流 */}
          <div className="glass-panel p-4 sci-border">
            <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              任务流 · TASK FLOW
            </div>
            <TaskFlow stats={taskStats} tasks={recentTasks} />
          </div>

          {/* 模型调用流 */}
          <div className="glass-panel p-4 sci-border">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                模型调用流 · MODEL CALLS
              </div>
              <label className="flex items-center gap-1.5 text-[9px] font-mono cursor-pointer" style={{ color: "var(--text-muted)" }}>
                <input
                  type="checkbox"
                  checked={showHighCostOnly}
                  onChange={(e) => setShowHighCostOnly(e.target.checked)}
                  className="rounded"
                />
                仅高价模型
              </label>
            </div>
            <ModelCallFlow calls={recentCalls} loading={loading} />
          </div>
        </div>

        {/* 成本热力图 */}
        <div className="glass-panel p-4 sci-border mb-6">
          <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            成本热力图 · COST HEATMAP (近 7 天)
          </div>
          <CostHeatmap heatmap={heatmap} loading={loading} />
        </div>

        {/* 数据备份（Phase B §4） */}
        <DbBackupCard />
      </div>
    </div>
  );
}
