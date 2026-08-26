/**
 * 天枢模型管理页面
 * - 从天枢拉取可用模型列表
 * - 选择全局默认模型（任务执行时未分配模型的智能体使用）
 * - 按智能体分配模型
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { AdminGate } from "@/components/AdminGate";
import { Cpu, RefreshCw, Star, Check, Users, CloudDownload } from "lucide-react";
import { toast } from "sonner";

export default function ModelsPanel() {
  const utils = trpc.useUtils();
  const listQuery = trpc.tianshu.listModels.useQuery(undefined, { retry: 1, staleTime: 30_000 });
  const agentsQuery = trpc.tianshu.listAgents.useQuery(undefined, { retry: 1, staleTime: 30_000 });
  const pricingStatusQuery = trpc.pricing.officialStatus.useQuery(undefined, { retry: 1, staleTime: 30_000 });

  const syncPricingMutation = trpc.pricing.syncOfficial.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        toast.success(`官方定价已同步：共 ${data.total} 个模型（新增 ${data.created} / 更新 ${data.updated}${data.tiered ? `，含分层定价 ${data.tiered}` : ""}）`);
      } else {
        toast.error(`同步失败: ${data.error ?? "未知错误"}`);
      }
      utils.tianshu.listModels.invalidate();
      utils.pricing.officialStatus.invalidate();
      utils.pricing.list.invalidate();
    },
    onError: (e) => toast.error(`同步失败: ${e.message}`),
  });

  const setDefaultMutation = trpc.tianshu.setDefaultModel.useMutation({
    onSuccess: (data) => {
      toast.success(`默认模型已切换为 ${data.defaultModel}`);
      utils.tianshu.listModels.invalidate();
    },
    onError: (e) => toast.error(`设置失败: ${e.message}`),
  });

  const setAgentModelMutation = trpc.tianshu.setAgentModel.useMutation({
    onSuccess: () => {
      toast.success("智能体模型已更新");
      utils.tianshu.listAgents.invalidate();
    },
    onError: (e) => toast.error(`设置失败: ${e.message}`),
  });

  const data = listQuery.data;
  const models = data?.models ?? [];
  const defaultModel = data?.defaultModel ?? "";
  const pricing = data?.pricing ?? {};
  const agentRows = agentsQuery.data ?? [];

  const fmtPrice = (v: string | undefined) => {
    if (!v) return "-";
    const n = Number(v);
    if (isNaN(n) || n === 0) return "-";
    return `$${n.toFixed(6)}`;
  };

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              模型管理
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              TIANSHU MODELS · 模型来源：天枢聚合网关
            </p>
          </div>
          <div className="flex items-center gap-2">
            <AdminGate>
              <button
                onClick={() => syncPricingMutation.mutate()}
                disabled={syncPricingMutation.isPending}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors disabled:opacity-50"
                style={{ color: "var(--accent-cyan)", border: "1px solid var(--border-default)" }}
                title={`从官方定价源（${pricingStatusQuery.data?.sourceHost ?? "basellm.github.io"}）同步最新定价，与天枢同源`}
              >
                <CloudDownload size={14} className={syncPricingMutation.isPending ? "animate-pulse" : ""} />
                {syncPricingMutation.isPending ? "同步中..." : "同步官方定价"}
              </button>
            </AdminGate>
            <button
              onClick={() => { listQuery.refetch(); agentsQuery.refetch(); }}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
          </div>
        </div>

        {/* 状态卡片 */}
        <div className="glass-panel p-4 sci-border mb-6 flex flex-wrap items-center gap-6">
          <div>
            <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>天枢网关</div>
            <div className="text-sm font-mono" style={{ color: data?.ok ? "var(--success)" : "var(--accent-red)" }}>
              {data?.ok ? "● 已连接" : `○ ${(data && "error" in data ? data.error : undefined) ?? "未配置"}`}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>当前默认模型</div>
            <div className="text-sm font-mono font-bold" style={{ color: "var(--accent-gold)" }}>
              {defaultModel || "未设置（任务将报错提示）"}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>可用模型数</div>
            <div className="text-sm font-mono" style={{ color: "var(--text-primary)" }}>{models.length}</div>
          </div>
          <div>
            <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
              官方定价（{pricingStatusQuery.data?.sourceHost ?? "basellm.github.io"}）
            </div>
            <div className="text-sm font-mono" style={{ color: "var(--text-primary)" }}>
              {pricingStatusQuery.data?.syncedAt
                ? `${new Date(pricingStatusQuery.data.syncedAt).toLocaleString("zh-CN", { hour12: false })} · ${pricingStatusQuery.data.total} 个模型`
                : "未同步 · 点击右上角「同步官方定价」"}
            </div>
          </div>
        </div>

        {/* 模型列表 */}
        <div className="glass-panel p-4 sci-border mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Cpu size={14} style={{ color: "var(--accent-cyan)" }} />
            <span className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>可用模型</span>
          </div>
          {listQuery.isLoading ? (
            <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>
          ) : models.length === 0 ? (
            <div className="text-center py-12" style={{ color: "var(--text-muted)" }}>
              <Cpu size={32} className="mx-auto mb-3 opacity-30" />
              <div className="text-sm font-mono">未获取到模型</div>
              <div className="text-[10px]">{(data && "error" in data ? data.error : undefined) ?? "请检查 TIANSHU_API_KEY 配置"}</div>
            </div>
          ) : (
            <div className="overflow-x-auto custom-scrollbar">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                    {["模型 ID", "输入价/1K", "输出价/1K", "缓存价/1K", "默认", "操作"].map((h) => (
                      <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => {
                    const isDefault = m === defaultModel;
                    return (
                      <tr key={m} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                        <td className="py-2 px-3" style={{ color: isDefault ? "var(--accent-gold)" : "var(--text-primary)", fontWeight: isDefault ? 700 : 400 }}>
                          {m}
                          {pricing[m]?.tiered && (
                            <span
                              className="ml-1.5 text-[9px] px-1 py-0.5 rounded align-middle"
                              style={{ background: "rgba(180,200,255,0.08)", color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
                              title="分层定价：价格随上下文长度分档，表中为基础档，成本核算按实际长度选档"
                            >
                              分层
                            </span>
                          )}
                        </td>
                        <td className="py-2 px-3" style={{ color: "var(--accent-cyan)" }}>{fmtPrice(pricing[m]?.inputPrice)}</td>
                        <td className="py-2 px-3" style={{ color: "var(--warning)" }}>{fmtPrice(pricing[m]?.outputPrice)}</td>
                        <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{fmtPrice(pricing[m]?.cachedInputPrice ?? undefined)}</td>
                        <td className="py-2 px-3">
                          {isDefault && <Star size={13} style={{ color: "var(--accent-gold)" }} fill="currentColor" />}
                        </td>
                        <td className="py-2 px-3">
                          {!isDefault && (
                            <AdminGate>
                              <button
                                onClick={() => setDefaultMutation.mutate({ model: m })}
                                disabled={setDefaultMutation.isPending}
                                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded transition-colors hover:bg-[rgba(180,200,255,0.06)]"
                                style={{ color: "var(--accent-cyan)", border: "1px solid var(--border-default)" }}
                              >
                                <Check size={11} /> 设为默认
                              </button>
                            </AdminGate>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* 智能体模型分配 */}
        <div className="glass-panel p-4 sci-border">
          <div className="flex items-center gap-2 mb-3">
            <Users size={14} style={{ color: "var(--accent-cyan)" }} />
            <span className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>智能体模型分配</span>
            <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>（优先级高于全局默认）</span>
          </div>
          {agentRows.length === 0 ? (
            <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>暂无智能体</div>
          ) : (
            <div className="overflow-x-auto custom-scrollbar">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                    {["智能体", "标识", "状态", "当前模型", "分配模型"].map((h) => (
                      <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {agentRows.map((a) => (
                    <tr key={a.id} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                      <td className="py-2 px-3" style={{ color: "var(--text-primary)" }}>{a.name}</td>
                      <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{a.agentId}</td>
                      <td className="py-2 px-3" style={{ color: a.status === "online" ? "var(--success)" : "var(--text-muted)" }}>{a.status}</td>
                      <td className="py-2 px-3" style={{ color: a.model ? "var(--accent-gold)" : "var(--text-muted)" }}>
                        {a.model || "跟随默认"}
                      </td>
                      <td className="py-2 px-3">
                        <AdminGate>
                          <select
                            value={a.model ?? ""}
                            onChange={(e) =>
                              setAgentModelMutation.mutate({ agentId: a.id, model: e.target.value === "" ? null : e.target.value })
                            }
                            className="text-[11px] px-2 py-1 rounded font-mono"
                            style={{
                              background: "rgba(0,0,0,0.3)",
                              border: "1px solid var(--border-default)",
                              color: "var(--text-primary)",
                            }}
                          >
                            <option value="">跟随默认{defaultModel ? ` (${defaultModel})` : ""}</option>
                            {models.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        </AdminGate>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
