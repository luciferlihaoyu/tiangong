/**
 * 天宫助手设置区块（用于模型管理页 Tabs）。
 * - 助手模型：消息对话 / 任务执行使用的模型
 * - 自动审批：开关 + 日限额 + 今日计数 + 红线风险类型
 * - 失败任务归档：批量把 failed 任务归档（璇玑 lesson + AList）
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { AdminGate } from "@/components/AdminGate";
import { toast } from "sonner";
import { Bot, ShieldCheck, Archive, RefreshCw, AlertTriangle, Wrench, Clock } from "lucide-react";

export function AssistantSection() {
  const utils = trpc.useUtils();
  const [limitDraft, setLimitDraft] = useState<string>("");
  const [archivePreview, setArchivePreview] = useState<{ count: number; ids: number[] } | null>(null);

  const [repairResult, setRepairResult] = useState<{ rows: Array<{ table: string; column: string; dirty: number }>; totalDirty: number } | null>(null);
  const modelQuery = trpc.assistant.getModel.useQuery(undefined, { retry: 1 });
  const fallbackQuery = trpc.tianshu.getFallbackModel.useQuery(undefined, { retry: 1 });
  const repairScanQuery = trpc.assistant.timestampRepairScan.useQuery(undefined, { retry: 0, enabled: false });
  const modelsQuery = trpc.tianshu.listModels.useQuery(undefined, { retry: 1, staleTime: 60_000 });
  const autoQuery = trpc.assistant.getAutoApprove.useQuery(undefined, { retry: 1 });

  const setModelMutation = trpc.assistant.setModel.useMutation({
    onSuccess: (d) => {
      utils.assistant.getModel.invalidate();
      toast.success(`助手模型已切换为 ${d.model}`);
    },
    onError: (e) => toast.error(`切换失败：${e.message}`),
  });

  const setAutoMutation = trpc.assistant.setAutoApprove.useMutation({
    onSuccess: (d) => {
      utils.assistant.getAutoApprove.invalidate();
      toast.success(d.enabled ? "自动审批已开启" : "自动审批已关闭");
    },
    onError: (e) => toast.error(`操作失败：${e.message}`),
  });

  const archiveMutation = trpc.assistant.archiveFailedTasks.useMutation({
    onSuccess: (d) => {
      if (d.dryRun) {
        setArchivePreview({ count: d.candidateCount ?? 0, ids: d.ids ?? [] });
        toast.info(`预演：${d.candidateCount ?? 0} 个失败任务待归档`);
      } else {
        setArchivePreview(null);
        const errs = d.errors?.length ?? 0;
        toast.success(`已归档 ${d.archived ?? 0}/${d.total ?? 0} 个失败任务${errs ? `（${errs} 个出错）` : ""}`);
      }
    },
    onError: (e) => toast.error(`归档失败：${e.message}`),
  });

  const setFallbackMutation = trpc.tianshu.setFallbackModel.useMutation({
    onSuccess: (d) => {
      utils.tianshu.getFallbackModel.invalidate();
      toast.success(d.model ? `兜底模型已设为 ${d.model}` : "已清除兜底模型（回退助手模型）");
    },
    onError: (e) => toast.error(`设置失败：${e.message}`),
  });

  const repairApplyMutation = trpc.assistant.timestampRepairApply.useMutation({
    onSuccess: (d) => {
      toast.success(`已修复 ${d.totalUpdated} 行时间戳`);
      setRepairResult(null);
      repairScanQuery.refetch();
    },
    onError: (e) => toast.error(`修复失败：${e.message}`),
  });

  const auto = autoQuery.data;
  const fallbackModel = fallbackQuery.data?.model ?? "";
  const models = modelsQuery.data?.models ?? [];
  const currentModel = modelQuery.data?.model ?? "";

  return (
    <div className="space-y-5">
      {/* ── 助手模型 ── */}
      <div className="glass-panel p-4 sci-border">
        <div className="flex items-center gap-2 mb-3">
          <Bot size={14} style={{ color: "#a78bfa" }} />
          <span className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>
            天宫助手 · 模型
          </span>
        </div>
        <p className="text-[10px] font-mono mb-3" style={{ color: "var(--text-muted)" }}>
          消息面板对话 + 分配给天宫助手的任务执行，共用此模型
        </p>
        <AdminGate fallback={
          <div className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
            当前模型：<span style={{ color: "var(--accent-gold)" }}>{currentModel || "—"}</span>
            <span className="ml-2" style={{ color: "var(--text-muted)" }}>（仅管理员可切换）</span>
          </div>
        }>
          <div className="flex items-center gap-2">
            <select
              value={currentModel}
              onChange={(e) => setModelMutation.mutate({ model: e.target.value })}
              disabled={setModelMutation.isPending || models.length === 0}
              className="text-xs font-mono px-2 py-1.5 rounded"
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border-default)",
                color: "var(--accent-gold)",
                minWidth: "220px",
              }}
            >
              {models.length === 0 && <option value={currentModel}>{currentModel || "（模型列表未加载）"}</option>}
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            {setModelMutation.isPending && (
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>切换中…</span>
            )}
          </div>
        </AdminGate>
      </div>

      {/* ── 死模型兜底 ── */}
      <div className="glass-panel p-4 sci-border">
        <div className="flex items-center gap-2 mb-3">
          <Wrench size={14} style={{ color: "var(--accent-gold)" }} />
          <span className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>
            任务执行 · 死模型兜底
          </span>
        </div>
        <p className="text-[10px] font-mono mb-3 leading-relaxed" style={{ color: "var(--text-muted)" }}>
          任务执行时若配置的模型在网关**频道已下线**（永久性错误，重试也没用），
          自动换到此模型再试一次，不再烧完 3 轮退避重试才失败。留空 = 回退助手模型。
        </p>
        <AdminGate fallback={
          <div className="text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
            当前兜底：<span style={{ color: "var(--accent-gold)" }}>{fallbackModel || "（助手模型）"}</span>
          </div>
        }>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={fallbackModel}
              onChange={(e) => setFallbackMutation.mutate({ model: e.target.value })}
              disabled={setFallbackMutation.isPending || models.length === 0}
              className="text-xs font-mono px-2 py-1.5 rounded"
              style={{
                background: "var(--bg-card)",
                border: "1px solid var(--border-default)",
                color: "var(--accent-gold)",
                minWidth: "220px",
              }}
            >
              <option value="">（回退助手模型）</option>
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            {fallbackQuery.data?.effectiveFromAssistant && (
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                未配置，当前实际用助手模型兜底
              </span>
            )}
          </div>
        </AdminGate>
      </div>

      {/* ── 自动审批 ── */}
      <div className="glass-panel p-4 sci-border">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck size={14} style={{ color: auto?.enabled ? "var(--success)" : "var(--text-muted)" }} />
            <span className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>
              自动审批 · 天宫助手代审
            </span>
          </div>
          <AdminGate fallback={
            <span className="text-[10px] font-mono px-2 py-1 rounded"
              style={{
                background: auto?.enabled ? "rgba(52,211,153,0.12)" : "rgba(255,255,255,0.05)",
                color: auto?.enabled ? "var(--success)" : "var(--text-muted)",
              }}>
              {auto?.enabled ? "已开启" : "已关闭"}
            </span>
          }>
            <button
              onClick={() => setAutoMutation.mutate({ enabled: !auto?.enabled })}
              disabled={setAutoMutation.isPending}
              className="text-[11px] font-mono px-3 py-1.5 rounded font-bold transition-all disabled:opacity-50"
              style={{
                background: auto?.enabled ? "rgba(248,113,113,0.12)" : "rgba(52,211,153,0.14)",
                color: auto?.enabled ? "var(--accent-red)" : "var(--success)",
                border: `1px solid ${auto?.enabled ? "rgba(248,113,113,0.3)" : "rgba(52,211,153,0.35)"}`,
              }}
            >
              {auto?.enabled ? "关闭自动审批" : "开启自动审批"}
            </button>
          </AdminGate>
        </div>

        <p className="text-[10px] font-mono mb-3 leading-relaxed" style={{ color: "var(--text-muted)" }}>
          被审批闸门停放的任务由天宫助手自动审查：命中红线的永久转人工；其余交给 LLM 判断，
          仅明确批准才放行。开启后任务不再卡在「待审批」等待人工。
        </p>

        <div className="flex flex-wrap items-center gap-5 text-[10px] font-mono">
          <div>
            <div style={{ color: "var(--text-muted)" }}>今日自动批准</div>
            <div style={{ color: "var(--text-primary)" }}>
              {auto?.todayCount ?? 0} / {auto?.dailyLimit ?? 10}
            </div>
          </div>
          <AdminGate>
            <div>
              <div style={{ color: "var(--text-muted)" }}>每日限额</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={limitDraft || String(auto?.dailyLimit ?? 10)}
                  onChange={(e) => setLimitDraft(e.target.value)}
                  className="w-16 px-1.5 py-0.5 rounded text-[10px] font-mono"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                />
                <button
                  onClick={() => {
                    const n = parseInt(limitDraft, 10);
                    if (!Number.isFinite(n) || n < 1 || n > 100) { toast.error("限额需 1-100"); return; }
                    setAutoMutation.mutate({ enabled: auto?.enabled ?? false, dailyLimit: n });
                    setLimitDraft("");
                  }}
                  className="px-1.5 py-0.5 rounded"
                  style={{ color: "var(--accent-cyan)", border: "1px solid var(--border-default)" }}
                >
                  保存
                </button>
              </div>
            </div>
          </AdminGate>
        </div>

        <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border-default)" }}>
          <div className="flex items-center gap-1.5 mb-1.5">
            <AlertTriangle size={11} style={{ color: "var(--accent-red)" }} />
            <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
              红线（永不自动批准，必须人工）
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(auto?.redLineRisks ?? []).map((r) => (
              <span key={r} className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: "rgba(248,113,113,0.08)", color: "var(--accent-red)" }}>
                {r}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ── 失败任务归档 ── */}
      <div className="glass-panel p-4 sci-border">
        <div className="flex items-center gap-2 mb-3">
          <Archive size={14} style={{ color: "var(--accent-cyan)" }} />
          <span className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>
            失败任务归档
          </span>
        </div>
        <p className="text-[10px] font-mono mb-3 leading-relaxed" style={{ color: "var(--text-muted)" }}>
          把 status=failed 的任务归档：失败教训写入璇玑记忆 + 附件上传 AList（与成功任务归档对称）。
          已取消（cancelled）的任务不在范围内。
        </p>

        <AdminGate fallback={
          <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>仅管理员可执行归档</div>
        }>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => archiveMutation.mutate({ dryRun: true, limit: 100 })}
              disabled={archiveMutation.isPending}
              className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded disabled:opacity-50"
              style={{ color: "var(--text-secondary)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={12} className={archiveMutation.isPending ? "animate-pulse" : ""} />
              预演（看有多少待归档）
            </button>
            <button
              onClick={() => archiveMutation.mutate({ dryRun: false, limit: 100 })}
              disabled={archiveMutation.isPending}
              className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded font-bold disabled:opacity-50"
              style={{
                background: "rgba(14,116,144,0.12)",
                color: "var(--accent-cyan)",
                border: "1px solid rgba(14,116,144,0.3)",
              }}
            >
              <Archive size={12} />
              {archiveMutation.isPending ? "归档中…" : "归档全部失败任务"}
            </button>
            {archivePreview && (
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                待归档 {archivePreview.count} 个：{archivePreview.ids.map((i) => `#${i}`).join(" ")}
              </span>
            )}
          </div>
        </AdminGate>
      </div>

      {/* ── 时间戳修复（58669 年存量脏数据） ── */}
      <div className="glass-panel p-4 sci-border">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={14} style={{ color: "#f472b6" }} />
          <span className="text-xs font-mono font-bold" style={{ color: "var(--text-primary)" }}>
            时间戳存量修复
          </span>
        </div>
        <p className="text-[10px] font-mono mb-3 leading-relaxed" style={{ color: "var(--text-muted)" }}>
          历史数据侧收尾：早期 `defaultNow()` 写入的是毫秒但按秒读，导致线程/消息时间
          显示成 +58669 年（新写入已修）。这里一次性把库里 &gt;5138 年的秒值 ÷1000 修回。
          **幂等**，重复执行不会二次除；只读扫描先行，确认后再修。
        </p>
        <AdminGate fallback={
          <div className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>仅管理员可执行</div>
        }>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={async () => {
                const res = await repairScanQuery.refetch();
                const d = res.data;
                if (d) {
                  setRepairResult({ rows: d.rows, totalDirty: d.totalDirty });
                  toast.info(d.totalDirty === 0 ? "没有需要修复的时间戳" : `发现 ${d.totalDirty} 行待修复`);
                }
              }}
              className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded"
              style={{ color: "var(--text-secondary)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={12} /> 扫描（只读）
            </button>
            <button
              onClick={() => repairApplyMutation.mutate()}
              disabled={repairApplyMutation.isPending}
              className="flex items-center gap-1.5 text-[11px] font-mono px-3 py-1.5 rounded font-bold disabled:opacity-50"
              style={{
                background: "rgba(244,114,182,0.12)",
                color: "#f472b6",
                border: "1px solid rgba(244,114,182,0.3)",
              }}
            >
              <Wrench size={12} />
              {repairApplyMutation.isPending ? "修复中…" : "修复时间戳"}
            </button>
          </div>
          {repairResult && (
            <div className="mt-2 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
              {repairResult.totalDirty === 0 ? (
                "全部干净，无需修复"
              ) : (
                <>
                  <div>待修复 {repairResult.totalDirty} 行：</div>
                  {repairResult.rows.map((r) => (
                    <div key={`${r.table}.${r.column}`} className="ml-2">
                      {r.table}.{r.column} — {r.dirty} 行
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </AdminGate>
      </div>
    </div>
  );
}
