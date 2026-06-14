/**
 * 天宫 用量监测面板 — UsagePanel (P9)
 *
 * 按模型统计 token 使用量、调用次数、时间范围
 * 不记录或展示密钥
 */
import { useState, useMemo } from "react";
import { trpc } from "@/providers/trpc";
import {
  BarChart3,
  Database,
  Zap,
  Calendar,
  TrendingUp,
  RefreshCw,
} from "lucide-react";

interface UsageByModel {
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
  costCents: number;
}

interface UsageByDay {
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
}

interface UsageRecord {
  id: number;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  callCount: number;
  costCents: number;
  taskId: number | null;
  agentId: number | null;
  createdAt: string;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtCost(cents: number): string {
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${cents}¢`;
}

/** 顶部统计卡片行 */
function StatsRow({ byModel }: { byModel: UsageByModel[] }) {
  const totals = byModel.reduce(
    (acc, m) => ({
      totalTokens: acc.totalTokens + m.totalTokens,
      callCount: acc.callCount + m.callCount,
      costCents: acc.costCents + m.costCents,
      promptTokens: acc.promptTokens + m.promptTokens,
      completionTokens: acc.completionTokens + m.completionTokens,
    }),
    { totalTokens: 0, callCount: 0, costCents: 0, promptTokens: 0, completionTokens: 0 }
  );

  const cards = [
    { label: "总 Token", value: fmtTokens(totals.totalTokens), color: "var(--accent-cyan)", icon: <Database size={16} /> },
    { label: "总调用次数", value: String(totals.callCount), color: "var(--success)", icon: <Zap size={16} /> },
    { label: "估算成本", value: fmtCost(totals.costCents), color: "var(--accent-gold)", icon: <TrendingUp size={16} /> },
    { label: "输入 Token", value: fmtTokens(totals.promptTokens), color: "var(--text-secondary)", icon: <BarChart3 size={16} /> },
    { label: "输出 Token", value: fmtTokens(totals.completionTokens), color: "var(--warning)", icon: <BarChart3 size={16} /> },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
      {cards.map((c, i) => (
        <div key={i} className="glass-panel p-3 sci-border flex items-center gap-2">
          <div className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0" style={{ background: "rgba(255,255,255,0.03)" }}>
            <span style={{ color: c.color }}>{c.icon}</span>
          </div>
          <div className="min-w-0">
            <div className="text-lg font-bold font-mono" style={{ color: c.color }}>{c.value}</div>
            <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>{c.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 按模型分组表 */
function ModelTable({ byModel, loading }: { byModel: UsageByModel[]; loading: boolean }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;

  if (byModel.length === 0) {
    return (
      <div className="text-center py-12" style={{ color: "var(--text-muted)" }}>
        <Database size={32} className="mx-auto mb-3 opacity-30" />
        <div className="text-sm font-mono mb-1">暂无用量数据</div>
        <div className="text-[10px]">通过 Connector Worker 或手动 API 上报后可见</div>
      </div>
    );
  }

  const maxTokens = Math.max(...byModel.map((m) => m.totalTokens), 1);

  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
            {["模型", "提供方", "输入 Token", "输出 Token", "总 Token", "调用次数", "成本", "占比"].map((h) => (
              <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byModel.map((m) => (
            <tr key={m.model} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
              <td className="py-2 px-3 truncate max-w-40" style={{ color: "var(--text-primary)" }}>{m.model}</td>
              <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{m.provider}</td>
              <td className="py-2 px-3" style={{ color: "var(--text-secondary)" }}>{fmtTokens(m.promptTokens)}</td>
              <td className="py-2 px-3" style={{ color: "var(--warning)" }}>{fmtTokens(m.completionTokens)}</td>
              <td className="py-2 px-3 font-bold" style={{ color: "var(--accent-cyan)" }}>{fmtTokens(m.totalTokens)}</td>
              <td className="py-2 px-3" style={{ color: "var(--text-secondary)" }}>{m.callCount}</td>
              <td className="py-2 px-3" style={{ color: "var(--accent-gold)" }}>{fmtCost(m.costCents)}</td>
              <td className="py-2 px-3">
                <div className="flex items-center gap-2">
                  <div className="progress-track flex-1" style={{ height: "4px", maxWidth: "60px" }}>
                    <div className="progress-fill" style={{ width: `${(m.totalTokens / maxTokens) * 100}%`, background: "var(--accent-cyan)" }} />
                  </div>
                  <span style={{ color: "var(--text-muted)" }}>{((m.totalTokens / maxTokens) * 100).toFixed(0)}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 按日趋势 */
function DailyTrend({ byDay, loading }: { byDay: UsageByDay[]; loading: boolean }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;

  if (byDay.length === 0) return null;

  const maxTokens = Math.max(...byDay.map((d) => d.totalTokens), 1);
  const chartHeight = 120;

  return (
    <div className="mt-4">
      <div className="text-[10px] font-mono mb-2 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        日趋势 · DAILY TREND
      </div>
      <div className="glass-panel p-4 sci-border">
        <div className="flex items-end gap-1" style={{ height: `${chartHeight}px` }}>
          {byDay
            .slice()
            .reverse()
            .map((d, i) => {
              const h = Math.max(2, (d.totalTokens / maxTokens) * chartHeight);
              return (
                <div key={i} className="flex-1 flex flex-col items-center group relative" style={{ minWidth: "20px" }}>
                  <div className="absolute -top-5 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity font-mono whitespace-nowrap" style={{ color: "var(--accent-cyan)" }}>
                    {fmtTokens(d.totalTokens)}
                  </div>
                  <div
                    className="w-full rounded-t transition-all"
                    style={{
                      height: `${h}px`,
                      background: "linear-gradient(180deg, var(--accent-cyan), rgba(74,158,255,0.15))",
                      opacity: 0.7,
                    }}
                  />
                  <div className="text-[8px] mt-1 font-mono truncate w-full text-center" style={{ color: "var(--text-muted)" }}>
                    {d.date.slice(5)}
                  </div>
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

/** 详细记录列表 */
function RecordList({ records, loading }: { records: UsageRecord[]; loading: boolean }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;

  if (records.length === 0) {
    return <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>暂无详细记录</div>;
  }

  return (
    <div className="mt-4">
      <div className="text-[10px] font-mono mb-2 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        最近记录 · RECENT RECORDS
      </div>
      <div className="space-y-1 max-h-64 overflow-y-auto custom-scrollbar">
        {records.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-2 py-2 px-3 rounded text-xs" style={{ background: "rgba(255,255,255,0.01)", border: "1px solid rgba(255,255,255,0.03)" }}>
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-mono truncate max-w-32" style={{ color: "var(--text-primary)" }}>{r.model}</span>
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>{r.provider}</span>
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <span className="font-mono text-[10px]" style={{ color: "var(--accent-cyan)" }}>{fmtTokens(r.totalTokens)} tok</span>
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                {r.promptTokens}+{r.completionTokens}
              </span>
              <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>{fmtCost(r.costCents)}</span>
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>{fmtDateTime(r.createdAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function UsagePanel() {
  const now = new Date();
  const [from, setFrom] = useState(() => {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => now.toISOString().slice(0, 10));
  const [model, setModel] = useState("");

  const byModelQuery = trpc.usage.byModel.useQuery(
    { from: from ? `${from}T00:00:00Z` : undefined, to: to ? `${to}T23:59:59Z` : undefined },
    { retry: 1, staleTime: 10_000 }
  );

  const byDayQuery = trpc.usage.byDay.useQuery(
    { from: from ? `${from}T00:00:00Z` : undefined, to: to ? `${to}T23:59:59Z` : undefined, model: model || undefined },
    { retry: 1, staleTime: 10_000 }
  );

  const listQuery = trpc.usage.list.useQuery(
    { from: from ? `${from}T00:00:00Z` : undefined, to: to ? `${to}T23:59:59Z` : undefined, model: model || undefined, limit: 50 },
    { retry: 1, staleTime: 10_000 }
  );

  const byModel = (byModelQuery.data as UsageByModel[]) || [];
  const byDay = (byDayQuery.data as UsageByDay[]) || [];
  const records = (listQuery.data as UsageRecord[]) || [];
  const loading = byModelQuery.isLoading || byDayQuery.isLoading || listQuery.isLoading;

  // Extract unique model names for filter
  const modelNames = useMemo(() => Array.from(new Set(byModel.map((m) => m.model))), [byModel]);

  const handleRefresh = () => {
    byModelQuery.refetch();
    byDayQuery.refetch();
    listQuery.refetch();
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              TOKEN 用量监测
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              按模型统计 · 安全监控 · 不记录密钥
            </p>
          </div>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={14} /> 刷新
          </button>
        </div>

        {/* Stats */}
        <StatsRow byModel={byModel} />

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <div>
            <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>开始</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-3 py-2 rounded text-xs outline-none"
              style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
            />
          </div>
          <div>
            <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>结束</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-3 py-2 rounded text-xs outline-none"
              style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
            />
          </div>
          <div>
            <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>模型</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="px-3 py-2 rounded text-xs outline-none"
              style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
            >
              <option value="">全部模型</option>
              {modelNames.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1 text-[10px] font-mono ml-2 self-center" style={{ color: "var(--text-muted)" }}>
            <Calendar size={12} />
            <span>最近 30 天</span>
          </div>
        </div>

        {/* Model table */}
        <div className="glass-panel p-4 sci-border mb-6">
          <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
            按模型统计 · BY MODEL
          </div>
          <ModelTable byModel={byModel} loading={loading} />
        </div>

        {/* Daily trend */}
        <DailyTrend byDay={byDay} loading={loading} />

        {/* Recent records */}
        <div className="glass-panel p-4 sci-border mt-6">
          <RecordList records={records} loading={loading} />
        </div>
      </div>
    </div>
  );
}
