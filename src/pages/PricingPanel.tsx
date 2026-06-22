/**
 * P13: 模型定价管理页面
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { DollarSign, Plus, Trash2, Edit3, Save, X, RefreshCw } from "lucide-react";

interface PricingForm {
  model: string;
  provider: string;
  inputPrice: string;
  outputPrice: string;
  cachedInputPrice: string;
  notes: string;
}

const emptyForm: PricingForm = {
  model: "",
  provider: "",
  inputPrice: "",
  outputPrice: "",
  cachedInputPrice: "",
  notes: "",
};

function fmtPrice(v: string | number | null): string {
  if (v === null || v === undefined || v === "") return "-";
  const n = Number(v);
  if (isNaN(n)) return "-";
  if (n === 0) return "$0";
  return `$${n.toFixed(6)}`;
}

export default function PricingPanel() {
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<PricingForm | null>(null);
  const [form, setForm] = useState<PricingForm>(emptyForm);

  const listQuery = trpc.pricing.list.useQuery(undefined, { retry: 1, staleTime: 30_000 });
  const utils = trpc.useUtils();

  const upsertMutation = trpc.pricing.upsert.useMutation({
    onSuccess: () => {
      utils.pricing.list.invalidate();
      setShowModal(false);
      setForm(emptyForm);
      setEditing(null);
    },
  });

  const deleteMutation = trpc.pricing.delete.useMutation({
    onSuccess: () => utils.pricing.list.invalidate(),
  });

  const handleOpenCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const handleOpenEdit = (row: {
    model: string;
    provider: string | null;
    inputPrice: string | number | null;
    outputPrice: string | number | null;
    cachedInputPrice: string | number | null;
    notes: string | null;
  }) => {
    setEditing({
      model: row.model,
      provider: row.provider ?? "",
      inputPrice: String(row.inputPrice ?? ""),
      outputPrice: String(row.outputPrice ?? ""),
      cachedInputPrice: row.cachedInputPrice != null ? String(row.cachedInputPrice) : "",
      notes: row.notes ?? "",
    });
    setForm({
      model: row.model,
      provider: row.provider ?? "",
      inputPrice: String(row.inputPrice ?? ""),
      outputPrice: String(row.outputPrice ?? ""),
      cachedInputPrice: row.cachedInputPrice != null ? String(row.cachedInputPrice) : "",
      notes: row.notes ?? "",
    });
    setShowModal(true);
  };

  const handleSave = () => {
    if (!form.model.trim()) return;
    upsertMutation.mutate({
      model: form.model.trim(),
      provider: form.provider.trim() || undefined,
      inputPrice: form.inputPrice,
      outputPrice: form.outputPrice,
      cachedInputPrice: form.cachedInputPrice || undefined,
      notes: form.notes || undefined,
    });
  };

  const handleDelete = (model: string) => {
    if (!confirm(`确认删除模型 "${model}" 的定价?`)) return;
    deleteMutation.mutate({ model });
  };

  const rows = (listQuery.data ?? []) as Array<{
    model: string;
    provider: string | null;
    inputPrice: string | number | null;
    outputPrice: string | number | null;
    cachedInputPrice: string | number | null;
    currency: string | null;
    notes: string | null;
  }>;

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-6xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-black tracking-wider" style={{ color: "var(--text-primary)" }}>
              模型定价管理
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              MODEL PRICING · USD / 1K tokens
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => listQuery.refetch()}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={14} /> 刷新
            </button>
            <button
              onClick={handleOpenCreate}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono transition-colors"
              style={{ background: "var(--accent-red)", color: "#fff" }}
            >
              <Plus size={14} /> 新增定价
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="glass-panel p-4 sci-border">
          {listQuery.isLoading ? (
            <div className="text-xs p-4" style={{ color: "var(--text-muted)" }}>加载中...</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-12" style={{ color: "var(--text-muted)" }}>
              <DollarSign size={32} className="mx-auto mb-3 opacity-30" />
              <div className="text-sm font-mono">暂无定价数据</div>
              <div className="text-[10px]">点击「新增定价」添加模型</div>
            </div>
          ) : (
            <div className="overflow-x-auto custom-scrollbar">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
                    {["模型", "提供方", "输入价/1K", "输出价/1K", "缓存价/1K", "货币", "备注", "操作"].map((h) => (
                      <th key={h} className="text-left py-2 px-3" style={{ color: "var(--text-muted)", fontWeight: 400 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.model} className="hover:bg-[rgba(180,200,255,0.02)]" style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                      <td className="py-2 px-3 truncate max-w-48" style={{ color: "var(--text-primary)" }}>{r.model}</td>
                      <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{r.provider}</td>
                      <td className="py-2 px-3" style={{ color: "var(--accent-cyan)" }}>{fmtPrice(r.inputPrice)}</td>
                      <td className="py-2 px-3" style={{ color: "var(--warning)" }}>{fmtPrice(r.outputPrice)}</td>
                      <td className="py-2 px-3" style={{ color: "var(--success)" }}>{fmtPrice(r.cachedInputPrice)}</td>
                      <td className="py-2 px-3" style={{ color: "var(--text-muted)" }}>{r.currency}</td>
                      <td className="py-2 px-3 truncate max-w-40" style={{ color: "var(--text-secondary)" }}>{r.notes ?? "-"}</td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <button onClick={() => handleOpenEdit(r)} className="p-1 rounded hover:bg-[rgba(180,200,255,0.05)]" style={{ color: "var(--text-muted)" }} title="编辑">
                            <Edit3 size={12} />
                          </button>
                          <button onClick={() => handleDelete(r.model)} className="p-1 rounded hover:bg-[rgba(255,50,50,0.1)]" style={{ color: "var(--accent-red-bright)" }} title="删除">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Modal */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }}>
          <div className="glass-panel p-6 sci-border w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold font-mono" style={{ color: "var(--text-primary)" }}>
                {editing ? "编辑定价" : "新增定价"}
              </h3>
              <button onClick={() => setShowModal(false)} className="p-1 rounded hover:bg-[rgba(180,200,255,0.05)]" style={{ color: "var(--text-muted)" }}>
                <X size={14} />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>模型名称 *</label>
                <input
                  type="text"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                  disabled={!!editing}
                  className="w-full px-3 py-2 rounded text-xs outline-none"
                  style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                  placeholder="如 gpt-4o"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>提供方</label>
                <input
                  type="text"
                  value={form.provider}
                  onChange={(e) => setForm({ ...form, provider: e.target.value })}
                  className="w-full px-3 py-2 rounded text-xs outline-none"
                  style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                  placeholder="如 openai"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>输入价 / 1K (USD)</label>
                  <input
                    type="number"
                    step="0.000001"
                    value={form.inputPrice}
                    onChange={(e) => setForm({ ...form, inputPrice: e.target.value })}
                    className="w-full px-3 py-2 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>输出价 / 1K (USD)</label>
                  <input
                    type="number"
                    step="0.000001"
                    value={form.outputPrice}
                    onChange={(e) => setForm({ ...form, outputPrice: e.target.value })}
                    className="w-full px-3 py-2 rounded text-xs outline-none"
                    style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                  />
                </div>
              </div>
              <div>
                <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>缓存输入价 / 1K (USD, 可选)</label>
                <input
                  type="number"
                  step="0.000001"
                  value={form.cachedInputPrice}
                  onChange={(e) => setForm({ ...form, cachedInputPrice: e.target.value })}
                  className="w-full px-3 py-2 rounded text-xs outline-none"
                  style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                  placeholder="留空表示无缓存折扣"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono mb-1 block" style={{ color: "var(--text-muted)" }}>备注</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 rounded text-xs outline-none"
                  style={{ background: "rgba(0,0,0,0.2)", border: "1px solid var(--border-default)", color: "var(--text-primary)" }}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 mt-5">
              <button
                onClick={() => setShowModal(false)}
                className="text-xs px-3 py-1.5 rounded font-mono"
                style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
              >
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={!form.model.trim() || upsertMutation.isPending}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono disabled:opacity-50"
                style={{ background: "var(--accent-red)", color: "#fff" }}
              >
                <Save size={12} /> {upsertMutation.isPending ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
