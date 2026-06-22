/**
 * 天宫 成本分析面板 — UsagePanel (P13)
 *
 * 多维度用量统计：按模型 / 按Agent / Agent×模型交叉 / 缓存命中率
 * 双币种显示（USD / CNY），支持汇率切换
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
  Users,
  Layers,
  ShieldCheck,
  DollarSign,
} from "lucide-react";

const EXCHANGE_RATE = 7.2;

type Currency = "USD" | "CNY";
type DisplayMode = "m" | "raw";

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

function fmtTokens(n: number, mode: DisplayMode = "m"): string {
  if (mode === "raw") return String(n);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return String(n);
}

function fmtCost(cents: number, currency: Currency, mode: DisplayMode = "m"): string {
  const usd = cents / 100;
  if (currency === "CNY") {
    const cny = usd * EXCHANGE_RATE;
    if (mode === "raw") return `¥${cny.toFixed(6)}`;
    return `¥${cny.toFixed(2)}`;
  }
  if (mode === "raw") return `$${usd.toFixed(6)}`;
  if (cents >= 100) return `$${usd.toFixed(2)}`;
  return `${cents}¢`;
}

function fmtUsd(usd: number, mode: DisplayMode = "m"): string {
  if (mode === "raw") return `$${usd.toFixed(6)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtCny(usd: number): string {
  return `¥${(usd * EXCHANGE_RATE).toFixed(2)}`;
}

/** 概览统计卡片 */
function OverviewCards({
  byModel,
  cacheStats,
  currency,
  displayMode,
}: {
  byModel: { totalTokens: number; callCount: number; costCents: number }[];
  cacheStats: { overall?: { cacheHitRate: number; cachedPromptTokens: number; uncachedPromptTokens: number; costCents: number } } | undefined;
  currency: Currency;
  displayMode: DisplayMode;
}) {
  const totals = byModel.reduce(
    (acc, m) => ({
      totalTokens: acc.totalTokens + m.totalTokens,
      callCount: acc.callCount + m.callCount,
      costCents: acc.costCents + m.costCents,
    }),
    { totalTokens: 0, callCount: 0, costCents: 0 }
  );

  const costUsd = totals.costCents / 100;
  const savedUsd = cacheStats?.overall
    ? (cacheStats.overall.cachedPromptTokens * 0.0015) / 1000 // rough estimate
    : 0;

  const cards = [
    {
      label: currency === "CNY" ? "总花费 (CNY)" : "总花费 (USD)",
      value: currency === "CNY" ? fmtCny(costUsd) : fmtUsd(costUsd, displayMode),
      sub: currency === "CNY" ? fmtUsd(costUsd, displayMode) : fmtCny(costUsd),
      color: "var(--accent-gold)",
      icon: <DollarSign size={16} />,
    },
    {
      label: "总 Token",
      value: fmtTokens(totals.totalTokens, displayMode),
      color: "var(--accent-cyan)",
      icon: <Database size={16} />,
    },
    {
      label: "总调用次数",
      value: String(totals.callCount),
      color: "var(--success)",
      icon: <Zap size={16} />,
    },
    {
      label: "缓存节省",
      value: fmtUsd(savedUsd, displayMode),
      sub: fmtCny(savedUsd),
      color: "var(--warning)",
      icon: <ShieldCheck size={16} />,
    },
    {
      label: "缓存命中率",
      value: cacheStats?.overall?.cacheHitRate != null ? `${cacheStats.overall.cacheHitRate}%` : "0%",
      color: "var(--accent-gold-bright)",
      icon: <TrendingUp size={16} />,
    },
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
            {c.sub && <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>{c.sub}</div>}
            <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>{c.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 按模型分组表 */
function ModelTable({ byModel, loading, currency, displayMode }: { byModel: any[]; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  if (byModel.length === 0) return <EmptyState title="暂无模型数据" desc="通过 Connector 或 API 上报后可见" />;

  const maxTokens = Math.max(...byModel.map((m) => m.totalTokens), 1);

  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
            {["模型", "提供方", "输入 Token", "输出 Token", "总 Token", "调用次数", "成本", "缓存命中", "占比"].map((h) => (
              <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byModel.map((m) => (
            <tr key={m.model} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
              <td className="py-2 px-3 truncate max-w-40" style={{ color: "var(--text-primary)" }}>{m.model}</td>
              <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{m.provider}</td>
              <td className="py-2 px-3" style={{ color: "var(--text-secondary)" }}>{fmtTokens(m.promptTokens, displayMode)}</td>
              <td className="py-2 px-3" style={{ color: "var(--warning)" }}>{fmtTokens(m.completionTokens, displayMode)}</td>
              <td className="py-2 px-3 font-bold" style={{ color: "var(--accent-cyan)" }}>{fmtTokens(m.totalTokens, displayMode)}</td>
              <td className="py-2 px-3" style={{ color: "var(--text-secondary)" }}>{m.callCount}</td>
              <td className="py-2 px-3" style={{ color: "var(--accent-gold)" }}>{fmtCost(m.costCents, currency, displayMode)}</td>
              <td className="py-2 px-3" style={{ color: "var(--success)" }}>{fmtTokens(m.cachedPromptTokens ?? 0, displayMode)}</td>
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

/** 按 Agent 统计表 */
function AgentTable({ byAgent, loading, currency, displayMode }: { byAgent: any[]; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  if (byAgent.length === 0) return <EmptyState title="暂无 Agent 数据" desc="任务执行后自动生成" />;

  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
            {["Agent", "输入 Token", "输出 Token", "总 Token", "缓存命中", "未缓存", "调用次数", "成本"].map((h) => (
              <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byAgent.map((a) => (
            <tr key={a.agentId ?? "null"} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
              <td className="py-2 px-3 truncate max-w-40" style={{ color: "var(--text-primary)" }}>
                {a.agentName ?? `Agent#${a.agentId}`}
              </td>
              <td className="py-2 px-3" style={{ color: "var(--text-secondary)" }}>{fmtTokens(a.promptTokens, displayMode)}</td>
              <td className="py-2 px-3" style={{ color: "var(--warning)" }}>{fmtTokens(a.completionTokens, displayMode)}</td>
              <td className="py-2 px-3 font-bold" style={{ color: "var(--accent-cyan)" }}>{fmtTokens(a.totalTokens, displayMode)}</td>
              <td className="py-2 px-3" style={{ color: "var(--success)" }}>{fmtTokens(a.cachedPromptTokens ?? 0, displayMode)}</td>
              <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{fmtTokens(a.uncachedPromptTokens ?? 0, displayMode)}</td>
              <td className="py-2 px-3" style={{ color: "var(--text-secondary)" }}>{a.callCount}</td>
              <td className="py-2 px-3" style={{ color: "var(--accent-gold)" }}>{fmtCost(a.costCents, currency, displayMode)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Agent × Model 交叉表 */
function CrossTable({ byAgentAndModel, loading, currency, displayMode }: { byAgentAndModel: any[]; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  if (byAgentAndModel.length === 0) return <EmptyState title="暂无交叉数据" desc="多 Agent 多模型使用后可见" />;

  return (
    <div className="overflow-x-auto custom-scrollbar">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
            {["Agent", "模型", "总 Token", "缓存命中", "调用次数", "成本"].map((h) => (
              <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {byAgentAndModel.map((row, i) => (
            <tr key={i} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
              <td className="py-2 px-3 truncate max-w-32" style={{ color: "var(--text-primary)" }}>{row.agentName ?? `Agent#${row.agentId}`}</td>
              <td className="py-2 px-3 truncate max-w-32" style={{ color: "var(--text-secondary)" }}>{row.model}</td>
              <td className="py-2 px-3 font-bold" style={{ color: "var(--accent-cyan)" }}>{fmtTokens(row.totalTokens, displayMode)}</td>
              <td className="py-2 px-3" style={{ color: "var(--success)" }}>{fmtTokens(row.cachedPromptTokens ?? 0, displayMode)}</td>
              <td className="py-2 px-3" style={{ color: "var(--text-secondary)" }}>{row.callCount}</td>
              <td className="py-2 px-3" style={{ color: "var(--accent-gold)" }}>{fmtCost(row.costCents, currency, displayMode)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 缓存命中率图表 */
function CacheChart({ cacheStats, loading, displayMode }: { cacheStats: any; loading: boolean; displayMode: DisplayMode }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  if (!cacheStats || cacheStats.byModel.length === 0) return <EmptyState title="暂无缓存数据" desc="Connector 上报缓存信息后可分析" />;

  const maxCached = Math.max(...cacheStats.byModel.map((m: any) => m.cachedPromptTokens), 1);

  return (
    <div className="space-y-4">
      {/* By model bar chart */}
      <div>
        <div className="text-[10px] font-mono mb-2" style={{ color: "var(--text-muted)" }}>按模型缓存命中</div>
        <div className="space-y-2">
          {cacheStats.byModel.map((m: any) => {
            const totalPrompt = (m.cachedPromptTokens ?? 0) + (m.uncachedPromptTokens ?? 0);
            const rate = totalPrompt > 0 ? ((m.cachedPromptTokens ?? 0) / totalPrompt) * 100 : 0;
            return (
              <div key={m.model} className="flex items-center gap-2">
                <div className="w-28 truncate text-[10px] font-mono" style={{ color: "var(--text-secondary)" }}>{m.model}</div>
                <div className="flex-1 flex items-center gap-2">
                  <div className="flex-1 rounded overflow-hidden" style={{ height: "8px", background: "rgba(255,255,255,0.03)" }}>
                    <div
                      className="h-full rounded"
                      style={{ width: `${Math.min(100, rate)}%`, background: "linear-gradient(90deg, var(--success), var(--accent-cyan))" }}
                    />
                  </div>
                  <div className="w-12 text-right text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>{rate.toFixed(1)}%</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Overall donut-like summary */}
      <div className="grid grid-cols-2 gap-3 mt-4">
        <div className="p-3 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>总体缓存命中</div>
          <div className="text-xl font-bold font-mono" style={{ color: "var(--success)" }}>
            {cacheStats.overall?.cacheHitRate ?? 0}%
          </div>
          <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
            {fmtTokens(cacheStats.overall?.cachedPromptTokens ?? 0, displayMode)} / {fmtTokens(cacheStats.overall?.totalPromptTokens ?? 0, displayMode)} tokens
          </div>
        </div>
        <div className="p-3 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
          <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>缓存节省估算</div>
          <div className="text-xl font-bold font-mono" style={{ color: "var(--accent-gold)" }}>
            {fmtUsd(((cacheStats.overall?.cachedPromptTokens ?? 0) * 0.0015) / 1000, displayMode)}
          </div>
          <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
            基于平均输入价差
          </div>
        </div>
      </div>
    </div>
  );
}

/** 日趋势图 */
function DailyTrend({ byDay, loading, currency, displayMode }: { byDay: any[]; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  if (byDay.length === 0) return null;

  const maxTokens = Math.max(...byDay.map((d) => d.totalTokens), 1);
  const maxCost = Math.max(...byDay.map((d) => d.costCents ?? 0), 1);
  const chartHeight = 120;

  return (
    <div className="mt-4">
      <div className="text-[10px] font-mono mb-2 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        日趋势 · DAILY TREND
      </div>
      <div className="glass-panel p-4 sci-border">
        {/* Token bars */}
        <div className="flex items-end gap-1 mb-3" style={{ height: `${chartHeight}px` }}>
          {byDay
            .slice()
            .reverse()
            .map((d, i) => {
              const h = Math.max(2, (d.totalTokens / maxTokens) * chartHeight);
              return (
                <div key={i} className="flex-1 flex flex-col items-center group relative" style={{ minWidth: "20px" }}>
                  <div className="absolute -top-5 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity font-mono whitespace-nowrap" style={{ color: "var(--accent-cyan)" }}>
                    {fmtTokens(d.totalTokens, displayMode)}
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
        {/* Cost mini bars */}
        <div className="flex items-end gap-1" style={{ height: "40px" }}>
          {byDay
            .slice()
            .reverse()
            .map((d, i) => {
              const h = Math.max(2, ((d.costCents ?? 0) / maxCost) * 40);
              return (
                <div key={i} className="flex-1 flex flex-col items-center group relative" style={{ minWidth: "20px" }}>
                  <div className="absolute -top-4 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity font-mono whitespace-nowrap" style={{ color: "var(--accent-gold)" }}>
                    {fmtCost(d.costCents ?? 0, currency, displayMode)}
                  </div>
                  <div
                    className="w-full rounded-t"
                    style={{
                      height: `${h}px`,
                      background: "linear-gradient(180deg, var(--accent-gold), rgba(201,168,76,0.15))",
                      opacity: 0.6,
                    }}
                  />
                </div>
              );
            })}
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: "var(--accent-cyan)" }} /> Token
          </span>
          <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
            <span className="inline-block w-2 h-2 rounded-full mr-1" style={{ background: "var(--accent-gold)" }} /> 成本
          </span>
        </div>
      </div>
    </div>
  );
}

/** 详细记录列表 */
function RecordList({ records, loading, currency, displayMode }: { records: any[]; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  if (records.length === 0) return <div className="text-xs py-4" style={{ color: "var(--text-muted)" }}>暂无详细记录</div>;

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
              {r.source && r.source !== "manual" && (
                <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: "rgba(255,200,50,0.1)", color: "var(--accent-gold)" }}>{r.source}</span>
              )}
              {(r.cachedPromptTokens ?? 0) > 0 && (
                <span className="text-[9px] px-1.5 py-0.5 rounded font-mono" style={{ background: "rgba(76,175,125,0.1)", color: "var(--success)" }}>
                  缓存 {fmtTokens(r.cachedPromptTokens, displayMode)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <span className="font-mono text-[10px]" style={{ color: "var(--accent-cyan)" }}>{fmtTokens(r.totalTokens, displayMode)} tok</span>
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                {r.promptTokens}+{r.completionTokens}
              </span>
              <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>{fmtCost(r.costCents, currency, displayMode)}</span>
              {r.sessionKey && (
                <span className="text-[9px] font-mono truncate max-w-24" style={{ color: "var(--text-muted)" }} title={r.sessionKey}>{r.sessionKey.split(":").pop()}</span>
              )}
              {r.traceId && (
                <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }} title={r.traceId}>#{r.traceId.slice(0, 8)}</span>
              )}
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>{fmtDateTime(r.createdAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="text-center py-12" style={{ color: "var(--text-muted)" }}>
      <Database size={32} className="mx-auto mb-3 opacity-30" />
      <div className="text-sm font-mono mb-1">{title}</div>
      <div className="text-[10px]">{desc}</div>
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
  const [source, setSource] = useState("");
  const [agentId, setAgentId] = useState<number | undefined>(undefined);
  const [currency, setCurrency] = useState<Currency>("USD");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("m");
  const [activeTab, setActiveTab] = useState<"overview" | "agent" | "cross" | "cache">("overview");

  const timeRange = { from: from ? `${from}T00:00:00Z` : undefined, to: to ? `${to}T23:59:59Z` : undefined };

  const byModelQuery = trpc.usage.byModel.useQuery(
    { ...timeRange, source: source || undefined, agentId },
    { retry: 1, staleTime: 10_000 }
  );

  const byAgentQuery = trpc.usage.byAgent.useQuery(
    { ...timeRange, model: model || undefined, source: source || undefined },
    { retry: 1, staleTime: 10_000 }
  );

  const byAgentAndModelQuery = trpc.usage.byAgentAndModel.useQuery(
    { ...timeRange, model: model || undefined, agentId, source: source || undefined },
    { retry: 1, staleTime: 10_000 }
  );

  const cacheStatsQuery = trpc.usage.cacheStats.useQuery(
    { ...timeRange, agentId, model: model || undefined },
    { retry: 1, staleTime: 10_000 }
  );

  const byDayQuery = trpc.usage.byDay.useQuery(
    { ...timeRange, model: model || undefined, agentId },
    { retry: 1, staleTime: 10_000 }
  );

  const bySourceQuery = trpc.usage.bySource.useQuery(
    { ...timeRange, agentId },
    { retry: 1, staleTime: 10_000 }
  );

  const listQuery = trpc.usage.list.useQuery(
    {
      ...timeRange,
      model: model || undefined,
      source: source || undefined,
      agentId,
      limit: 50,
    },
    { retry: 1, staleTime: 10_000 }
  );

  const byModel = (byModelQuery.data as any[]) || [];
  const byAgent = (byAgentQuery.data as any[]) || [];
  const byAgentAndModel = (byAgentAndModelQuery.data as any[]) || [];
  const cacheStats = cacheStatsQuery.data as any;
  const byDay = (byDayQuery.data as any[]) || [];
  const bySource = (bySourceQuery.data as any[]) || [];
  const records = (listQuery.data as any[]) || [];
  const loading = byModelQuery.isLoading || byDayQuery.isLoading;

  const modelNames = useMemo(() => Array.from(new Set(byModel.map((m) => m.model))), [byModel]);
  const agentOptions = useMemo(() => Array.from(new Set(byAgent.map((a) => ({ id: a.agentId, name: a.agentName ?? `Agent#${a.agentId}` })))), [byAgent]);

  const handleRefresh = () => {
    byModelQuery.refetch();
    byAgentQuery.refetch();
    byAgentAndModelQuery.refetch();
    cacheStatsQuery.refetch();
    byDayQuery.refetch();
    listQuery.refetch();
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              成本分析
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              TOKEN 用量 · 多维度统计 · 缓存分析 · 双币种
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Display mode toggle */}
            <div className="flex items-center rounded overflow-hidden" style={{ border: "1px solid var(--border-default)" }}>
              <button
                onClick={() => setDisplayMode("m")}
                className="text-xs px-2 py-1 font-mono transition-colors"
                style={{ background: displayMode === "m" ? "var(--accent-red)" : "transparent", color: displayMode === "m" ? "#fff" : "var(--text-muted)" }}
              >
                M
              </button>
              <button
                onClick={() => setDisplayMode("raw")}
                className="text-xs px-2 py-1 font-mono transition-colors"
                style={{ background: displayMode === "raw" ? "var(--accent-red)" : "transparent", color: displayMode === "raw" ? "#fff" : "var(--text-muted)" }}
              >
                原始
              </button>
            </div>
            {/* Currency toggle */}
            <div className="flex items-center rounded overflow-hidden" style={{ border: "1px solid var(--border-default)" }}>
              <button
                onClick={() => setCurrency("USD")}
                className="text-xs px-2 py-1 font-mono transition-colors"
                style={{ background: currency === "USD" ? "var(--accent-red)" : "transparent", color: currency === "USD" ? "#fff" : "var(--text-muted)" }}
              >
                $
              </button>
              <button
                onClick={() => setCurrency("CNY")}
                className="text-xs px-2 py-1 font-mono transition-colors"
                style={{ background: currency === "CNY" ? "var(--accent-red)" : "transparent", color: currency === "CNY" ? "#fff" : "var(--text-muted)" }}
              >
                ¥
              </button>
            </div>
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
        </div>

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
          <div>
            <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>Agent</label>
            <select
              value={agentId ?? ""}
              onChange={(e) => setAgentId(e.target.value ? Number(e.target.value) : undefined)}
              className="px-3 py-2 rounded text-xs outline-none"
              style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
            >
              <option value="">全部 Agent</option>
              {agentOptions.map((a) => (
                <option key={a.id ?? "null"} value={a.id ?? ""}>{a.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>来源</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="px-3 py-2 rounded text-xs outline-none"
              style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
            >
              <option value="">全部来源</option>
              <option value="manual">manual</option>
              <option value="cron">cron</option>
              <option value="connector">connector</option>
              <option value="runner">runner</option>
              <option value="system">system</option>
              <option value="subagent">subagent</option>
            </select>
          </div>
          <div className="flex items-center gap-1 text-[10px] font-mono ml-2 self-center" style={{ color: "var(--text-muted)" }}>
            <Calendar size={12} />
            <span>最近 30 天</span>
          </div>
        </div>

        {/* Overview cards */}
        <OverviewCards byModel={byModel} cacheStats={cacheStats} currency={currency} displayMode={displayMode} />

        {/* Tab navigation */}
        <div className="flex items-center gap-1 mb-4 overflow-x-auto custom-scrollbar">
          {[
            { key: "overview", label: "概览", icon: <BarChart3 size={12} /> },
            { key: "agent", label: "按 Agent", icon: <Users size={12} /> },
            { key: "cross", label: "交叉统计", icon: <Layers size={12} /> },
            { key: "cache", label: "缓存分析", icon: <ShieldCheck size={12} /> },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key as any)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono whitespace-nowrap transition-colors"
              style={{
                background: activeTab === tab.key ? "rgba(180,200,255,0.06)" : "transparent",
                color: activeTab === tab.key ? "var(--text-primary)" : "var(--text-muted)",
                border: activeTab === tab.key ? "1px solid var(--border-hover)" : "1px solid transparent",
              }}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {activeTab === "overview" && (
          <>
            <div className="glass-panel p-4 sci-border mb-6">
              <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                按模型统计 · BY MODEL
              </div>
              <ModelTable byModel={byModel} loading={loading} currency={currency} displayMode={displayMode} />
            </div>

            {bySource.length > 0 && (
              <div className="glass-panel p-4 sci-border mb-6">
                <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                  按来源统计 · BY SOURCE
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                  {bySource.map((s) => (
                    <div key={s.source || "unknown"} className="p-3 rounded" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)" }}>
                      <div className="text-xs font-bold font-mono mb-1" style={{ color: "var(--accent-cyan)" }}>{s.source || "unknown"}</div>
                      <div className="text-[10px] font-mono" style={{ color: "var(--text-secondary)" }}>{fmtTokens(s.totalTokens, displayMode)} tok</div>
                      <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>{s.callCount} 次</div>
                      {s.costCents > 0 && (
                        <div className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>{fmtCost(s.costCents, currency, displayMode)}</div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <DailyTrend byDay={byDay} loading={byDayQuery.isLoading} currency={currency} displayMode={displayMode} />

            <div className="glass-panel p-4 sci-border mt-6">
              <RecordList records={records} loading={listQuery.isLoading} currency={currency} displayMode={displayMode} />
            </div>
          </>
        )}

        {activeTab === "agent" && (
          <div className="glass-panel p-4 sci-border">
            <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              按 Agent 统计 · BY AGENT
            </div>
            <AgentTable byAgent={byAgent} loading={byAgentQuery.isLoading} currency={currency} displayMode={displayMode} />
          </div>
        )}

        {activeTab === "cross" && (
          <div className="glass-panel p-4 sci-border">
            <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              Agent × 模型交叉统计 · CROSS MATRIX
            </div>
            <CrossTable byAgentAndModel={byAgentAndModel} loading={byAgentAndModelQuery.isLoading} currency={currency} displayMode={displayMode} />
          </div>
        )}

        {activeTab === "cache" && (
          <div className="glass-panel p-4 sci-border">
            <div className="text-[10px] font-mono mb-3 uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
              缓存命中率分析 · CACHE ANALYTICS
            </div>
            <CacheChart cacheStats={cacheStats} loading={cacheStatsQuery.isLoading} displayMode={displayMode} />
          </div>
        )}
      </div>
    </div>
  );
}
