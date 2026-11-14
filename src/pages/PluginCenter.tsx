/**
 * 插件中心（P2-1）
 * - 受保护路由 /plugins：全部插件一览（名称 / 描述 / 状态灯 / 工具数 / 启用开关）
 * - 数据源：trpc.pluginCenter.list（retry:1 + 30s 轮询）；切换走 pluginCenter.setEnable，成功后 invalidate list
 * - 状态灯复用 HealthLight，status 直接映射 ok / down / unknown
 * - 接入 / 移除：pluginCenter.upsert（key/name/description/url/tokenEnvKey，同 key 覆盖）
 *   与 pluginCenter.remove（幂等）；两者成功后都 invalidate list 让服务端状态回灌
 * - 编辑回填（2026-11-14）：list 契约不返回 url/tokenEnvKey，编辑走 admin-only 的
 *   pluginCenter.get 拉详情再预填；保存仍是同 key upsert 覆盖
 */
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import HealthLight from "@/components/HealthLight";
import { Switch } from "@/components/ui/switch";
import { Puzzle, RefreshCw, Plus, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";

type PluginStatus = "ok" | "down" | "unknown";

/** pluginCenter.list 返回的单个插件（与后端契约字段一一对应） */
interface PluginInfo {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  status: PluginStatus;
  latencyMs?: number;
  toolCount?: number;
}

/** 接入表单（字段与后端 upsert 的 zod schema 一一对应；tokenEnvKey 可空） */
interface PluginForm {
  key: string;
  name: string;
  description: string;
  url: string;
  tokenEnvKey: string;
}

const emptyForm: PluginForm = { key: "", name: "", description: "", url: "", tokenEnvKey: "" };

const inputStyle: React.CSSProperties = {
  background: "rgba(10, 16, 34, 0.6)",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
};

/** status → 中文文案（灯珠颜色之外给文字语义） */
const STATUS_LABEL: Record<PluginStatus, string> = {
  ok: "正常",
  down: "异常",
  unknown: "未知",
};

function PluginCard({
  plugin,
  switchDisabled,
  removeDisabled,
  editDisabled,
  onToggle,
  onEdit,
  onRemove,
}: {
  plugin: PluginInfo;
  switchDisabled: boolean;
  removeDisabled: boolean;
  editDisabled: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="glass-panel p-4 sci-border flex flex-col">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-sm font-bold tracking-wide truncate"
            style={{ color: "var(--text-primary)" }}
          >
            {plugin.name}
          </span>
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded flex-shrink-0"
            style={{ background: "rgba(255,255,255,0.03)", color: "var(--text-muted)" }}
          >
            {plugin.key}
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <HealthLight status={plugin.status} latencyMs={plugin.latencyMs} />
          <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            {STATUS_LABEL[plugin.status]}
          </span>
        </div>
      </div>
      <div className="text-xs mb-3" style={{ color: "var(--text-secondary)" }}>
        {plugin.description}
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
          {typeof plugin.toolCount === "number" && (
            <span
              className="px-1.5 py-0.5 rounded"
              style={{ background: "var(--accent-glow-gold)", color: "var(--accent-gold)" }}
            >
              {plugin.toolCount} 工具
            </span>
          )}
          {typeof plugin.latencyMs === "number" && <span>{plugin.latencyMs}ms</span>}
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] font-mono"
            style={{ color: plugin.enabled ? "var(--success)" : "var(--text-muted)" }}
          >
            {plugin.enabled ? "已启用" : "已停用"}
          </span>
          <Switch
            checked={plugin.enabled}
            disabled={switchDisabled}
            onCheckedChange={onToggle}
          />
          {/* 编辑：走 admin-only get 拉详情回填表单（list 契约不含 url/tokenEnvKey，不能凭空预填） */}
          <button
            onClick={onEdit}
            disabled={editDisabled}
            title="编辑插件（回填地址与 token 环境变量名）"
            className="p-1 rounded transition-colors hover:bg-[rgba(74,158,255,0.1)] disabled:opacity-40"
            style={{ color: "var(--accent-cyan)" }}
          >
            {editDisabled ? <RefreshCw size={13} className="animate-spin" /> : <Pencil size={13} />}
          </button>
          {/* 移除是不可逆的（注册信息直接 delete），卡片上只放图标按钮，点击后仍要二次确认 */}
          <button
            onClick={onRemove}
            disabled={removeDisabled}
            title="移除插件"
            className="p-1 rounded transition-colors hover:bg-[rgba(255,50,50,0.1)] disabled:opacity-40"
            style={{ color: "var(--accent-red-bright)" }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PluginCenter() {
  const utils = trpc.useUtils();
  const listQuery = trpc.pluginCenter.list.useQuery(undefined, {
    retry: 1,
    staleTime: 30_000,
    refetchInterval: 30000,
  });

  const setEnableMutation = trpc.pluginCenter.setEnable.useMutation({
    onSuccess: (res, vars) => {
      const name = listQuery.data?.plugins.find((p) => p.key === vars.key)?.name ?? vars.key;
      if (res.ok) {
        toast.success(`已${vars.enabled ? "启用" : "停用"}插件：${name}`);
      } else {
        toast.error(`切换失败：${res.error ?? "未知错误"}`);
      }
      // 成败都刷新清单：成功拿到服务端最新状态；失败让开关回弹到真实值
      utils.pluginCenter.list.invalidate();
    },
    onError: (e) => toast.error(`切换失败：${e.message}`),
  });

  const plugins: PluginInfo[] = listQuery.data?.plugins ?? [];
  // 仅禁用正在切换的那颗开关（灰态防连击），其余开关不受影响
  const isToggling = (key: string) =>
    setEnableMutation.isPending && setEnableMutation.variables?.key === key;

  // ─── 接入 / 编辑插件（upsert；编辑预填走 admin-only get）───
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<PluginForm>(emptyForm);
  // 非 null = 表单处于「编辑既有插件」态：标题/按钮文案变化，key 锁死（改 key 等于另建插件）
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState<string | null>(null);
  const setField = (patch: Partial<PluginForm>) => setForm((prev) => ({ ...prev, ...patch }));

  // 命令式拉详情（utils.client.<proc>.query）而不是 useQuery+useEffect 回填：
  // 后者会被缓存 data 的 stale 引用重复触发，编辑态最容易踩这种竞态。
  const handleEdit = async (plugin: PluginInfo) => {
    setEditBusy(plugin.key);
    try {
      const p = await utils.client.pluginCenter.get.query({ key: plugin.key });
      if (!p) {
        toast.error(`插件 ${plugin.key} 不存在（可能刚被移除），请刷新清单`);
        return;
      }
      setForm({ key: p.key, name: p.name, description: p.description, url: p.url, tokenEnvKey: p.tokenEnvKey });
      setEditingKey(p.key);
      setFormOpen(true);
    } catch (e) {
      toast.error(`读取插件详情失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setEditBusy(null);
    }
  };

  const upsertMutation = trpc.pluginCenter.upsert.useMutation({
    onSuccess: (res, vars) => {
      if (res.ok) {
        // 新增与编辑共用 upsert（key 存在即覆盖），文案不猜意图，统一「已保存」
        toast.success(`已保存插件：${vars.name}`);
        setForm(emptyForm);
        setFormOpen(false);
        setEditingKey(null);
      } else {
        toast.error(`接入失败：${res.error ?? "未知错误"}`);
      }
      utils.pluginCenter.list.invalidate();
    },
    onError: (e) => toast.error(`接入失败：${e.message}`),
  });

  // ─── 移除插件（remove）───
  const removeMutation = trpc.pluginCenter.remove.useMutation({
    onSuccess: (res, vars) => {
      if (res.ok) {
        toast.success(`已移除插件：${vars.key}`);
      } else {
        toast.error(`移除失败：${res.error ?? "未知错误"}`);
      }
      utils.pluginCenter.list.invalidate();
    },
    onError: (e) => toast.error(`移除失败：${e.message}`),
  });

  /** 前端先按后端 zod 约束做一遍校验，免得用户提交后才吃 400 */
  const handleUpsert = () => {
    const key = form.key.trim();
    const name = form.name.trim();
    const description = form.description.trim();
    const url = form.url.trim();
    const tokenEnvKey = form.tokenEnvKey.trim();
    if (!key) return toast.error("请填写插件 key");
    if (key.length > 50) return toast.error("插件 key 最多 50 字符");
    if (!name) return toast.error("请填写插件名称");
    if (!description) return toast.error("请填写插件描述");
    if (!url) return toast.error("请填写 MCP 地址");
    // 后端是 z.string().url()，这里顺带要求 http(s)，否则探活必然失败
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return toast.error("MCP 地址必须以 http:// 或 https:// 开头");
      }
    } catch {
      return toast.error("MCP 地址不是合法 URL");
    }
    upsertMutation.mutate({
      key,
      name,
      description,
      url,
      // 空串不传：后端 tokenEnvKey 可选，传 "" 会落成空字符串而不是 null
      ...(tokenEnvKey ? { tokenEnvKey } : {}),
    });
  };

  const handleRemove = (plugin: PluginInfo) => {
    // 删除不可逆且会连带丢掉启用状态，必须二次确认
    if (!window.confirm(`确定移除插件「${plugin.name}」（${plugin.key}）？该操作不可撤销。`)) return;
    removeMutation.mutate({ key: plugin.key });
  };

  const isRemoving = (key: string) =>
    removeMutation.isPending && removeMutation.variables?.key === key;

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-primary)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 pt-24 pb-16">
        {/* 标题栏 */}
        <div className="flex items-center justify-between flex-wrap gap-4 mb-6">
          <div>
            <h1
              className="text-2xl font-black tracking-wider flex items-center gap-2"
              style={{ color: "var(--text-primary)" }}
            >
              <Puzzle size={22} style={{ color: "var(--accent-cyan)" }} />
              插件中心
            </h1>
            <p className="text-[10px] font-mono mt-1" style={{ color: "var(--text-muted)" }}>
              PLUGIN CENTER · 能力可插拔 · 状态 / 工具数 / 启用开关 / 接入与移除
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setFormOpen((v) => !v); }}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono transition-colors"
              style={{
                color: formOpen ? "var(--accent-cyan)" : "var(--text-muted)",
                border: `1px solid ${formOpen ? "var(--accent-cyan)" : "var(--border-default)"}`,
              }}
            >
              {formOpen ? <X size={13} /> : <Plus size={13} />} {formOpen ? "收起" : "接入插件"}
            </button>
            <button
              onClick={() => listQuery.refetch()}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
              style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
            >
              <RefreshCw size={13} /> 刷新
            </button>
          </div>
        </div>

        {/* 接入表单（字段严格对齐 api/plugin-center-router.ts 的 upsert schema） */}
        {formOpen && (
          <div className="glass-panel p-4 sci-border mb-6">
            <div className="text-xs font-mono font-bold mb-3" style={{ color: "var(--text-primary)" }}>
              {editingKey ? `编辑插件：${editingKey}` : "接入 / 更新插件"}
              <span className="ml-2 text-[10px] font-normal" style={{ color: "var(--text-muted)" }}>
                key 已存在则覆盖名称/描述/地址，启用状态保留原值；新插件默认停用
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
              <label className="block">
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                  {editingKey ? "key（编辑态锁死：改 key 等于另建插件，请取消后重新接入）" : "key（唯一标识，≤50）"}
                </div>
                <input
                  value={form.key}
                  disabled={!!editingKey}
                  onChange={(e) => setField({ key: e.target.value })}
                  placeholder="xuanji-memory"
                  className="w-full text-xs font-mono px-2.5 py-1.5 rounded outline-none"
                  style={inputStyle}
                />
              </label>
              <label className="block">
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>名称</div>
                <input
                  value={form.name}
                  onChange={(e) => setField({ name: e.target.value })}
                  placeholder="璇玑记忆"
                  className="w-full text-xs font-mono px-2.5 py-1.5 rounded outline-none"
                  style={inputStyle}
                />
              </label>
              <label className="block">
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>描述（≤200）</div>
                <input
                  value={form.description}
                  onChange={(e) => setField({ description: e.target.value })}
                  placeholder="长期记忆与知识库检索"
                  className="w-full text-xs font-mono px-2.5 py-1.5 rounded outline-none"
                  style={inputStyle}
                />
              </label>
              <label className="block">
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>MCP 地址（POST tools/list 的 URL）</div>
                <input
                  value={form.url}
                  onChange={(e) => setField({ url: e.target.value })}
                  placeholder="http://service-xuanji:8080/mcp"
                  className="w-full text-xs font-mono px-2.5 py-1.5 rounded outline-none"
                  style={inputStyle}
                />
              </label>
              <label className="block sm:col-span-2">
                <div className="text-[10px] font-mono mb-1" style={{ color: "var(--text-muted)" }}>
                  token 环境变量名（可选：填变量名，不填 token 本身）
                </div>
                <input
                  value={form.tokenEnvKey}
                  onChange={(e) => setField({ tokenEnvKey: e.target.value })}
                  placeholder="XUANJI_MCP_TOKEN"
                  className="w-full text-xs font-mono px-2.5 py-1.5 rounded outline-none"
                  style={inputStyle}
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleUpsert}
                disabled={upsertMutation.isPending}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono transition-colors disabled:opacity-50"
                style={{ color: "var(--accent-cyan)", border: "1px solid var(--accent-cyan)" }}
              >
                {editingKey ? <Pencil size={13} /> : <Plus size={13} />}{" "}
                {upsertMutation.isPending ? "提交中..." : editingKey ? "更新插件" : "保存插件"}
              </button>
              <button
                onClick={() => { setForm(emptyForm); setFormOpen(false); setEditingKey(null); }}
                disabled={upsertMutation.isPending}
                className="text-xs px-3 py-1.5 rounded font-mono transition-colors disabled:opacity-50"
                style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
              >
                取消
              </button>
            </div>
            <div className="text-[10px] font-mono mt-3 leading-relaxed" style={{ color: "var(--text-muted)" }}>
              清单接口（list）不返回 url 与 token 变量名；「编辑」按钮经 admin-only 的 get 拉取详情后预填，保存按同 key upsert 覆盖。
            </div>
          </div>
        )}

        {/* 列表 / 空态 / 异常态 */}
        {listQuery.isPending ? (
          <div
            className="glass-panel sci-border px-4 py-16 text-center text-xs font-mono animate-pulse"
            style={{ color: "var(--text-muted)" }}
          >
            正在加载插件清单...
          </div>
        ) : listQuery.isError ? (
          <div
            className="glass-panel sci-border px-4 py-16 text-center text-xs font-mono"
            style={{ color: "var(--accent-red)" }}
          >
            插件清单加载失败：{listQuery.error.message}（将自动重试）
          </div>
        ) : plugins.length === 0 ? (
          <div className="glass-panel sci-border flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Puzzle size={32} style={{ color: "var(--text-muted)" }} />
            <span className="text-sm" style={{ color: "var(--text-primary)" }}>
              暂无插件
            </span>
            <span className="text-xs font-mono" style={{ color: "var(--text-muted)" }}>
              点右上角「接入插件」填写 key / 名称 / 描述 / MCP 地址即可注册
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {plugins.map((p) => (
              <PluginCard
                key={p.key}
                plugin={p}
                switchDisabled={isToggling(p.key)}
                removeDisabled={isRemoving(p.key)}
                editDisabled={editBusy === p.key}
                onEdit={() => handleEdit(p)}
                onToggle={(enabled) => setEnableMutation.mutate({ key: p.key, enabled })}
                onRemove={() => handleRemove(p)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
