/**
 * 天宫 成本分析面板 — UsagePanel (P13)
 *
 * 多维度用量统计：按模型 / 按Agent / Agent×模型交叉 / 缓存命中率
 * 双币种显示（USD / CNY），支持汇率切换
 */
import { useState, useMemo } from "react";
import type { ReactNode } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { trpc } from "@/providers/trpc";
import type { AppRouter } from "../../api/router";
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
  Cpu,
} from "lucide-react";
import { localDayKey, localDayRange } from "@/lib/day";

const EXCHANGE_RATE = 7.2;

type Currency = "USD" | "CNY";
type DisplayMode = "m" | "raw";
type ActiveTab = "overview" | "agent" | "cross" | "cache";
type RouterOutputs = inferRouterOutputs<AppRouter>;
type UsageByModel = RouterOutputs["usage"]["byModel"];
type UsageByAgent = RouterOutputs["usage"]["byAgent"];
type UsageByAgentAndModel = RouterOutputs["usage"]["byAgentAndModel"];
type UsageCacheStats = RouterOutputs["usage"]["cacheStats"];
type UsageByDay = RouterOutputs["usage"]["byDay"];
type UsageBySource = RouterOutputs["usage"]["bySource"];
type UsageRecord = RouterOutputs["usage"]["list"][number];
/** model_pricing 行（api/pricing-router.ts list，publicQuery） */
type PricingRow = RouterOutputs["pricing"]["list"][number];
/** cacheStats.byModel 的单项 */
type CacheModelRow = UsageCacheStats["byModel"][number];

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

/** 成本格式化：入参为微美元（1e-6 USD）。聚合值可能是字符串（MySQL SUM），统一 Number 强制转换 */
function fmtCost(micros: number | string | null | undefined, currency: Currency): string {
  const usd = Number(micros ?? 0) / 1_000_000;
  if (currency === "CNY") {
    const cny = usd * EXCHANGE_RATE;
    return cny >= 1 ? `¥${cny.toFixed(2)}` : `¥${cny.toFixed(4)}`;
  }
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(6)}`;
}

/** 兼容旧数据：优先 costMicros，缺失时回退 costCents × 1e6 */
function microsOf(row: { costMicros?: number | string | null; costCents?: number | string | null }): number {
  const m = Number(row.costMicros ?? 0);
  if (m > 0) return m;
  return Number(row.costCents ?? 0) * 1_000_000;
}

function fmtUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

function fmtCny(usd: number): string {
  return `¥${(usd * EXCHANGE_RATE).toFixed(2)}`;
}

/** 缓存节省折算结果；null = 定价表里没有任何一个模型能算出价差（此时不显示金额） */
interface CacheSavings {
  /** 按 model_pricing 真实价差折算的节省金额（USD） */
  usd: number;
  /** 有可用价差（cachedInputPrice < inputPrice）并参与折算的模型数 */
  pricedModels: number;
  /** 命中过缓存、但定价表里查不到价差的 token 数（这部分不折算） */
  unpricedCachedTokens: number;
}

/**
 * 用后端 model_pricing 的真实价差折算缓存节省，取代原先写死的「每 1K token
 * 固定价差系数」折算（那是一个凭空约定的常数，与任何模型的实际定价无关）。
 *
 * 公式与 api/lib/model-pricing.ts 的 calculateCost 同源：
 *   saved = Σ cachedTokens × (inputPrice − cachedInputPrice) / 1000
 * 价格单位是 USD / 1K tokens（New API 口径）。
 *
 * 为什么宁可返回 null 也不给个数字：
 * 定价表里没这个模型、或 cachedInputPrice 为空（= 上游没有缓存折扣）时，
 * 真实的节省就是「算不出来」，编一个平均价差等于造数据。
 * 渠道前缀模型（如 newapi/xxx）按后端 getModelPricing 的同一套规则回退到末段匹配。
 */
function computeCacheSavings(
  rows: readonly CacheModelRow[],
  pricing: readonly PricingRow[] | undefined
): CacheSavings | null {
  if (!pricing || pricing.length === 0) return null;

  const byModel = new Map<string, PricingRow>();
  for (const p of pricing) byModel.set(p.model, p);
  const lookup = (model: string): PricingRow | undefined => {
    const direct = byModel.get(model);
    if (direct) return direct;
    const tail = model.includes("/") ? model.split("/").pop() : undefined;
    return tail && tail !== model ? byModel.get(tail) : undefined;
  };

  let usd = 0;
  let pricedModels = 0;
  let unpricedCachedTokens = 0;

  for (const row of rows) {
    const cached = Number(row.cachedPromptTokens ?? 0);
    if (!(cached > 0)) continue;
    const p = lookup(row.model);
    const inputPrice = p ? Number(p.inputPrice) : NaN;
    const cachedPrice = p?.cachedInputPrice != null ? Number(p.cachedInputPrice) : NaN;
    const discount = inputPrice - cachedPrice;
    if (Number.isFinite(inputPrice) && Number.isFinite(cachedPrice) && discount > 0) {
      usd += (cached * discount) / 1000;
      pricedModels += 1;
    } else {
      unpricedCachedTokens += cached;
    }
  }

  if (pricedModels === 0) return null;
  return { usd, pricedModels, unpricedCachedTokens };
}

/**
 * 本月已用金额（取代原来的「月度预算进度条」）
 *
 * 为什么改：原实现把一个写死的固定金额（$10）当月度预算分母画进度条，
 * 但后端根本没有"月度预算"这个配置项可读 ——
 *   · api/usage-router.ts 只有用量聚合（byModel/byDay/cacheStats…），无预算字段；
 *   · api/guard-router.ts 的预算是 agents.budgetCents / agents.spentCents（按 Agent、
 *     按美分、且在 guard.check 里实时校验），不是全局月度刻度；
 *   · 全库唯一的 monthlyBudgetCents 只是 api/connectors/newapi/types.ts 里的
 *     契约字段声明，没有任何路由读取或写入它。
 * 也就是说那条进度条对所有人都是假的（永远显示「$X / $10」）。这里只保留可验证的
 * 事实——本月实际花费 + 由本月数据外推的月底预计，并明确标注「未设置月度预算」。
 */
function MonthlySpendBar({ byDay, currency }: { byDay: UsageByDay; currency: Currency }) {
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthCost = byDay
    .filter(d => d.date?.startsWith(monthPrefix))
    .reduce((sum, d) => sum + microsOf(d), 0);

  const currentDay = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  // 预计月底 = 本月已用 / 已过天数 × 当月天数（外推值，不是预算，故文案单独标注）
  const projected = currentDay > 0 && monthCost > 0 ? Math.round((monthCost / currentDay) * daysInMonth) : 0;

  return (
    <div className="glass-panel p-3 sci-border mb-4">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          本月已用 · MONTHLY SPEND
        </div>
        <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
          {fmtCost(monthCost, currency)}
          {currency === "USD" && <span className="ml-1">({fmtCost(monthCost, "CNY")})</span>}
          {currency === "CNY" && <span className="ml-1">({fmtCost(monthCost, "USD")})</span>}
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span style={{ color: "var(--text-muted)" }} title="后端没有月度预算配置项，故不显示进度条与剩余额度">
          未设置月度预算 · {now.getFullYear()}/{now.getMonth() + 1} 累计
        </span>
        {projected > 0 && (
          <span style={{ color: "var(--text-muted)" }}>
            按日均外推月底 {fmtCost(projected, currency)}
            {currency === "USD" && <span className="ml-1">({fmtCost(projected, "CNY")})</span>}
            {currency === "CNY" && <span className="ml-1">({fmtCost(projected, "USD")})</span>}
          </span>
        )}
      </div>
    </div>
  );
}

/** 概览统计卡片 */
function OverviewCards({
  byModel,
  cacheStats,
  cacheSaved,
  cacheNote,
  currency,
  displayMode,
}: {
  byModel: { totalTokens: number | string; callCount: number | string; costCents: number | string; costMicros?: number | string }[];
  cacheStats: { overall?: { cacheHitRate: number; cachedPromptTokens: number; uncachedPromptTokens: number; costCents: number | string; costMicros?: number | string } } | undefined;
  /** 由 model_pricing 真实价差算出的缓存节省；null = 定价不足，不折算金额 */
  cacheSaved: CacheSavings | null;
  /** cacheSaved 为 null 时的原因说明（定价表为空/读取失败/无价差），避免笼统措辞 */
  cacheNote: string;
  currency: Currency;
  displayMode: DisplayMode;
}) {
  const totals = byModel.reduce(
    (acc, m) => ({
      totalTokens: acc.totalTokens + Number(m.totalTokens),
      callCount: acc.callCount + Number(m.callCount),
      costMicros: acc.costMicros + microsOf(m),
    }),
    { totalTokens: 0, callCount: 0, costMicros: 0 }
  );

  const costUsd = totals.costMicros / 1_000_000;
  // 缓存命中 token 数是可验证的事实；金额只在定价表能算出真实价差时才展示
  const cachedTokens = Number(cacheStats?.overall?.cachedPromptTokens ?? 0);

  const cards = [
    {
      label: currency === "CNY" ? "总花费 (CNY)" : "总花费 (USD)",
      value: currency === "CNY" ? fmtCny(costUsd) : fmtUsd(costUsd),
      sub: currency === "CNY" ? fmtUsd(costUsd) : fmtCny(costUsd),
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
    cacheSaved
      ? {
          label: "缓存节省",
          value: currency === "CNY" ? fmtCny(cacheSaved.usd) : fmtUsd(cacheSaved.usd),
          sub: `${currency === "CNY" ? fmtUsd(cacheSaved.usd) : fmtCny(cacheSaved.usd)} · 定价表 ${cacheSaved.pricedModels} 模型`,
          color: "var(--warning)",
          icon: <ShieldCheck size={16} />,
        }
      : {
          label: "缓存命中 Token",
          value: fmtTokens(cachedTokens, displayMode),
          sub: cacheNote,
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
function ModelTable({ byModel, loading, currency, displayMode }: { byModel: UsageByModel; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
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
              <td className="py-2 px-3" style={{ color: "var(--accent-gold)" }}>{fmtCost(microsOf(m), currency)}</td>
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
function AgentTable({ byAgent, loading, currency, displayMode }: { byAgent: UsageByAgent; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
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
              <td className="py-2 px-3" style={{ color: "var(--accent-gold)" }}>{fmtCost(microsOf(a), currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Agent × Model 交叉表 */
function CrossTable({ byAgentAndModel, loading, currency, displayMode }: { byAgentAndModel: UsageByAgentAndModel; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
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
              <td className="py-2 px-3" style={{ color: "var(--accent-gold)" }}>{fmtCost(microsOf(row), currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 缓存命中率图表 */
function CacheChart({ cacheStats, cacheSaved, cacheNote, loading, displayMode }: { cacheStats: UsageCacheStats | undefined; cacheSaved: CacheSavings | null; cacheNote: string; loading: boolean; displayMode: DisplayMode }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  if (!cacheStats || cacheStats.byModel.length === 0) return <EmptyState title="暂无缓存数据" desc="Connector 上报缓存信息后可分析" />;

  const maxCached = Math.max(...cacheStats.byModel.map((m) => m.cachedPromptTokens), 1);
  const cachedTokens = Number(cacheStats.overall?.cachedPromptTokens ?? 0);

  return (
    <div className="space-y-4">
      {/* By model bar chart */}
      <div>
        <div className="text-[10px] font-mono mb-2" style={{ color: "var(--text-muted)" }}>按模型缓存命中</div>
        <div className="space-y-2">
          {cacheStats.byModel.map((m) => {
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
          {/* 原来这里用一个写死的每 1K 价差系数乘上命中 token 数，当作「节省金额」，
              既不读 model_pricing 也不代表任何真实价差。改为只报可验证的命中 token 数，
              金额仅在定价表算得出真实价差时附带展示。 */}
          <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>缓存命中 Token</div>
          <div className="text-xl font-bold font-mono" style={{ color: "var(--success)" }}>
            {fmtTokens(cachedTokens, displayMode)}
          </div>
          <div className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
            {cacheSaved
              ? `按定价表价差 ≈ ${fmtUsd(cacheSaved.usd)}（${cacheSaved.pricedModels} 个模型可折算）`
              : cacheNote}
          </div>
          {cacheSaved && cacheSaved.unpricedCachedTokens > 0 && (
            <div className="text-[9px] font-mono mt-0.5" style={{ color: "var(--text-muted)" }}>
              另有 {fmtTokens(cacheSaved.unpricedCachedTokens, displayMode)} 命中 token 无定价，未折算
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** 日趋势图 */
function DailyTrend({ byDay, loading, currency, displayMode }: { byDay: UsageByDay; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
  if (loading) return <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>;
  if (byDay.length === 0) return null;

  const maxTokens = Math.max(...byDay.map((d) => d.totalTokens), 1);
  const maxCost = Math.max(...byDay.map((d) => microsOf(d)), 1);
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
                    {d.date?.slice(5) ?? "—"}
                  </div>
                </div>
              );
            })}
        </div>
        {/* Cost line chart */}
        <div className="relative mb-3" style={{ height: "60px" }}>
          <svg className="w-full h-full" viewBox={`0 0 ${byDay.length} 60`} preserveAspectRatio="none">
            <polyline
              fill="none"
              stroke="var(--accent-gold)"
              strokeWidth="0.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={byDay
                .slice()
                .reverse()
                .map((d, i) => `${i + 0.5},${60 - Math.max(1, (microsOf(d) / maxCost) * 56)}`)
                .join(" ")}
            />
            {byDay.slice().reverse().map((d, i) => {
              const y = 60 - Math.max(1, (microsOf(d) / maxCost) * 56);
              return <circle key={i} cx={i + 0.5} cy={y} r="0.25" fill="var(--accent-gold)" />;
            })}
          </svg>
          <div className="absolute inset-0 flex">
            {byDay.slice().reverse().map((d, i) => (
              <div key={i} className="flex-1 group relative">
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity font-mono whitespace-nowrap pointer-events-none z-10" style={{ color: "var(--accent-gold)" }}>
                  {fmtCost(microsOf(d), currency)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Cost mini bars */}
        <div className="flex items-end gap-1" style={{ height: "40px" }}>
          {byDay
            .slice()
            .reverse()
            .map((d, i) => {
              const h = Math.max(2, (microsOf(d) / maxCost) * 40);
              return (
                <div key={i} className="flex-1 flex flex-col items-center group relative" style={{ minWidth: "20px" }}>
                  <div className="absolute -top-4 text-[9px] opacity-0 group-hover:opacity-100 transition-opacity font-mono whitespace-nowrap" style={{ color: "var(--accent-gold)" }}>
                    {fmtCost(microsOf(d), currency)}
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
function RecordList({ records, loading, currency, displayMode }: { records: readonly UsageRecord[]; loading: boolean; currency: Currency; displayMode: DisplayMode }) {
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
                  缓存 {fmtTokens(r.cachedPromptTokens ?? 0, displayMode)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 flex-shrink-0">
              <span className="font-mono text-[10px]" style={{ color: "var(--accent-cyan)" }}>{fmtTokens(r.totalTokens, displayMode)} tok</span>
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                {r.promptTokens}+{r.completionTokens}
              </span>
              <span className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>{fmtCost(microsOf(r), currency)}</span>
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
  // 日期一律用**本地日**（与后端 api/lib/day-sql.ts 的 'localtime' 分组口径一致）。
  // 原先 toISOString() 是 UTC 日：北京时间 0~8 点时"今天"取到的是昨天，
  // 选出来的区间与后端按本地日分组的行对不齐。
  const [from, setFrom] = useState(() => {
    const d = new Date(now);
    d.setDate(d.getDate() - 30);
    return localDayKey(d);
  });
  const [to, setTo] = useState(() => localDayKey(now));
  const [model, setModel] = useState("");
  const [source, setSource] = useState("");
  const [agentId, setAgentId] = useState<number | undefined>(undefined);
  const [currency, setCurrency] = useState<Currency>("USD");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("m");
  const [activeTab, setActiveTab] = useState<ActiveTab>("overview");

  // localDayRange：不带 Z 后缀按本地时区解释，与后端本地日分组边界对齐。
  const timeRange = {
    from: from ? localDayRange(from).from : undefined,
    to: to ? localDayRange(to).to : undefined,
  };

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

  /**
   * 定价表（publicQuery）：缓存节省金额的唯一合法来源。
   * 读不到或没有可用价差时 computeCacheSavings 返回 null，界面就只报命中的 token 数，
   * 绝不回退到写死系数。
   */
  const pricingQuery = trpc.pricing.list.useQuery(undefined, { retry: 1, staleTime: 60_000 });

  const byModel: UsageByModel = byModelQuery.data ?? [];
  const byAgent: UsageByAgent = byAgentQuery.data ?? [];
  const byAgentAndModel: UsageByAgentAndModel = byAgentAndModelQuery.data ?? [];
  const cacheStats = cacheStatsQuery.data;
  const byDay: UsageByDay = byDayQuery.data ?? [];
  const bySource: UsageBySource = bySourceQuery.data ?? [];
  const records: readonly UsageRecord[] = listQuery.data ?? [];
  const loading = byModelQuery.isLoading || byDayQuery.isLoading;

  /** 缓存节省：按 model_pricing 真实价差折算（无可用价差 → null，只显示命中量） */
  const cacheSaved = useMemo(
    () => computeCacheSavings(cacheStats?.byModel ?? [], pricingQuery.data),
    [cacheStats, pricingQuery.data]
  );

  /** 折算不出来时把原因写清楚：定价表没读到 ≠ 定价表没有缓存价 */
  const cacheNote = useMemo(() => {
    if (pricingQuery.isError) return "定价表读取失败，不折算金额";
    if ((pricingQuery.data?.length ?? 0) === 0) return "定价表为空，不折算金额";
    return "定价表无可用价差，仅显示命中量";
  }, [pricingQuery.isError, pricingQuery.data]);

  /**
   * 审计：把任意查询的失败显式呈现，避免数字悄悄归零。
   * 这里刻意不含 pricingQuery —— 定价表只是缓存节省金额的"可选增强"，
   * 它失败时页面照常给出 token 事实（并在卡片上注明"定价表读取失败"），
   * 拉到顶部红条会把一次可选增强的失败放大成整页故障。
   */
  const firstError = [
    byModelQuery,
    byAgentQuery,
    byAgentAndModelQuery,
    cacheStatsQuery,
    byDayQuery,
    bySourceQuery,
    listQuery,
  ].find((q) => q.isError);

  const tabs = [
    { key: "overview", label: "概览", icon: <BarChart3 size={12} /> },
    { key: "agent", label: "按 Agent", icon: <Users size={12} /> },
    { key: "cross", label: "交叉统计", icon: <Layers size={12} /> },
    { key: "cache", label: "缓存分析", icon: <ShieldCheck size={12} /> },
  ] satisfies readonly { readonly key: ActiveTab; readonly label: string; readonly icon: ReactNode }[];

  const modelNames = useMemo(() => Array.from(new Set(byModel.map((m) => m.model))), [byModel]);
  const agentOptions = useMemo(() => Array.from(new Set(byAgent.map((a) => ({ id: a.agentId, name: a.agentName ?? `Agent#${a.agentId}` })))), [byAgent]);

  const handleRefresh = () => {
    byModelQuery.refetch();
    byAgentQuery.refetch();
    byAgentAndModelQuery.refetch();
    cacheStatsQuery.refetch();
    byDayQuery.refetch();
    listQuery.refetch();
    pricingQuery.refetch(); // 定价变了缓存节省金额就变，手动刷新时一并拉
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Error banner — 任一查询失败都显式呈现，避免数字悄悄归零 */}
        {firstError && (
          <div
            className="text-xs px-3 py-2 rounded mb-4 font-mono"
            style={{
              background: "rgba(220,38,38,0.12)",
              border: "1px solid rgba(220,38,38,0.35)",
              color: "#fca5a5",
            }}
            onClick={handleRefresh}
            role="alert"
            title="点击重新加载"
          >
            加载失败：{firstError.error?.message ?? "未知错误"}（点击重试）
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              成本分析
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              TOKEN 用量 · 多维度统计 · 缓存分析 · 双币种
            </p>
            <a
              href="#/models"
              className="inline-flex items-center gap-1.5 mt-2 text-[10px] font-mono px-2 py-1 rounded transition-colors hover:bg-[rgba(74,158,255,0.08)]"
              style={{
                background: "rgba(74,158,255,0.04)",
                color: "var(--accent-cyan)",
                border: "1px solid rgba(74,158,255,0.2)",
                textDecoration: "none",
              }}
              title="管理模型列表 / 定价 / 熔断 / 一键同步上游"
            >
              <Cpu size={10} />
              模型管理 / 定价 / 熔断 →
            </a>
          </div>
          <div className="flex items-center gap-3">
            {/* Display mode toggle switch */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <span className="text-[10px] font-mono" style={{ color: displayMode === "raw" ? "var(--text-muted)" : "var(--text-primary)" }}>M</span>
              <div
                onClick={() => setDisplayMode(displayMode === "m" ? "raw" : "m")}
                className="relative w-8 h-4 rounded-full transition-colors cursor-pointer"
                style={{
                  background: displayMode === "raw" ? "var(--accent-red)" : "rgba(255,255,255,0.1)",
                  border: "1px solid var(--border-default)",
                }}
              >
                <div
                  className="absolute top-0.5 w-3 h-3 rounded-full transition-all duration-200"
                  style={{
                    background: "var(--text-primary)",
                    left: displayMode === "raw" ? "19px" : "3px",
                  }}
                />
              </div>
              <span className="text-[10px] font-mono" style={{ color: displayMode === "m" ? "var(--text-muted)" : "var(--text-primary)" }}>原始</span>
            </label>
            {/* Currency toggle switch */}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <span className="text-[10px] font-mono" style={{ color: currency === "CNY" ? "var(--text-muted)" : "var(--text-primary)" }}>$</span>
              <div
                onClick={() => setCurrency(currency === "USD" ? "CNY" : "USD")}
                className="relative w-8 h-4 rounded-full transition-colors cursor-pointer"
                style={{
                  background: currency === "CNY" ? "var(--accent-red)" : "rgba(255,255,255,0.1)",
                  border: "1px solid var(--border-default)",
                }}
              >
                <div
                  className="absolute top-0.5 w-3 h-3 rounded-full transition-all duration-200"
                  style={{
                    background: "var(--text-primary)",
                    left: currency === "CNY" ? "19px" : "3px",
                  }}
                />
              </div>
              <span className="text-[10px] font-mono" style={{ color: currency === "USD" ? "var(--text-muted)" : "var(--text-primary)" }}>¥</span>
            </label>
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
        <OverviewCards byModel={byModel} cacheStats={cacheStats} cacheSaved={cacheSaved} cacheNote={cacheNote} currency={currency} displayMode={displayMode} />

        <MonthlySpendBar byDay={byDay} currency={currency} />

        {/* Tab navigation */}
        <div className="flex items-center gap-1 mb-4 overflow-x-auto custom-scrollbar">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
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
                      {microsOf(s) > 0 && (
                        <div className="text-[10px] font-mono" style={{ color: "var(--accent-gold)" }}>{fmtCost(microsOf(s), currency)}</div>
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
            <CacheChart cacheStats={cacheStats} cacheSaved={cacheSaved} cacheNote={cacheNote} loading={cacheStatsQuery.isLoading} displayMode={displayMode} />
          </div>
        )}
      </div>
    </div>
  );
}

