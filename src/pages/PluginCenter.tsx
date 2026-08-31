/**
 * 插件中心（P2-1）
 * - 受保护路由 /plugins：全部插件一览（名称 / 描述 / 状态灯 / 工具数 / 启用开关）
 * - 数据源：trpc.pluginCenter.list（retry:1 + 30s 轮询）；切换走 pluginCenter.setEnable，成功后 invalidate list
 * - 状态灯复用 HealthLight，status 直接映射 ok / down / unknown
 * 注：接入与移除插件（upsert / remove）的表单 UI 由后续迭代提供，接入规范见 docs/PLUGIN_SPEC.md。
 */
import { trpc } from "@/providers/trpc";
import HealthLight from "@/components/HealthLight";
import { Switch } from "@/components/ui/switch";
import { Puzzle, RefreshCw } from "lucide-react";
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

/** status → 中文文案（灯珠颜色之外给文字语义） */
const STATUS_LABEL: Record<PluginStatus, string> = {
  ok: "正常",
  down: "异常",
  unknown: "未知",
};

function PluginCard({
  plugin,
  switchDisabled,
  onToggle,
}: {
  plugin: PluginInfo;
  switchDisabled: boolean;
  onToggle: (enabled: boolean) => void;
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
              PLUGIN CENTER · 能力可插拔 · 状态 / 工具数 / 启用开关
            </p>
          </div>
          <button
            onClick={() => listQuery.refetch()}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-mono hover:bg-[rgba(180,200,255,0.05)] transition-colors"
            style={{ color: "var(--text-muted)", border: "1px solid var(--border-default)" }}
          >
            <RefreshCw size={13} /> 刷新
          </button>
        </div>

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
              接入规范见 docs/PLUGIN_SPEC.md（P2-3 将提供）
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {plugins.map((p) => (
              <PluginCard
                key={p.key}
                plugin={p}
                switchDisabled={isToggling(p.key)}
                onToggle={(enabled) => setEnableMutation.mutate({ key: p.key, enabled })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
