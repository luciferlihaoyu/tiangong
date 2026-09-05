import { useState } from "react";
import { trpc } from "@/providers/trpc";
import AppCard from "@/components/AppCard";
import { toast } from "sonner";

type AppStatus = "ok" | "down" | "unknown";

/** 各平台应用固定文案；key 未命中时用 registry 的 label 兜底 */
const APP_META: Record<string, { description: string }> = {
  tiangong: { description: "智能体编排 · 任务看板" },
  beidou: { description: "AI 写作" },
  xuanji: { description: "知识库与记忆" },
  tianshu: { description: "模型网关" },
  alist: { description: "文件存储" },
  dsh: { description: "编程 · 部署执行" },
};

/** 仅这些平台有 SSO /sso/launch 接收端：点击先调 launch 签票，成功后再开窗免登进入 */
const SSO_KEYS = new Set(["beidou", "xuanji"]);

interface HealthEntry {
  ok: boolean;
  reason?: string;
}

function resolveStatus(
  health: HealthEntry | undefined,
  loading: boolean
): { status: AppStatus; reason?: string } {
  if (loading || health === undefined) {
    return { status: "unknown" };
  }
  if (!health.ok && health.reason?.includes("not configured")) {
    return { status: "unknown", reason: "未配置" };
  }
  return health.ok
    ? { status: "ok" }
    : { status: "down", reason: health.reason };
}

export default function AppHub() {
  const registryQuery = trpc.platform.registry.useQuery(undefined, {
    retry: 1,
    staleTime: 300000,
  });
  const healthQuery = trpc.platform.health.all.useQuery(undefined, {
    retry: 1,
    refetchInterval: 30000,
  });
  // 动态 MCP 插件卡片（来自 pluginCenter.list，30s 轮询；新插件无需改前端）
  const pluginCenterQuery = trpc.pluginCenter.list.useQuery(undefined, {
    retry: 1,
    refetchInterval: 30000,
    staleTime: 30_000,
  });
  /** 正在走 SSO 签票的平台 key；非空时对应卡片禁点，防连击 */
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const launchMutation = trpc.platform.launch.useMutation({
    onSuccess: (res) => {
      if (res.ok) {
        window.open(res.url, "_blank", "noopener,noreferrer");
      } else {
        toast.error(`进入失败：${res.error ?? "未知错误"}`);
      }
    },
    onError: (e) => toast.error(`进入失败：${e.message}`),
    onSettled: () => setBusyKey(null),
  });

  const handleOpen = (key: string, url: string) => {
    if (SSO_KEYS.has(key)) {
      setBusyKey(key);
      launchMutation.mutate({ app: key });
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const services = registryQuery.data ?? [];
  // 已启用 MCP 插件按 key 建索引：网页平台卡若命中，则合入 MCP 能力徽标
  const pluginByKey = new Map(
    (pluginCenterQuery.data?.plugins ?? [])
      .filter((p) => p.enabled && p.key !== "echo" /* 演练后未启用的 echo 不展示 */)
      .map((p) => [p.key, p]),
  );
  // 有网页入口的平台 key（registry 里 kind !== self 且有 url 的）：其 MCP 能力并入顶部卡，底部不再重复展示
  const platformKeysWithUrl = new Set(
    services.filter((s) => s.kind !== "self" && s.url).map((s) => s.key),
  );

  return (
    <section className="relative z-10 pt-6 pb-2 px-4 md:px-6">
      <div className="max-w-7xl mx-auto">
        <h2 className="text-xl md:text-2xl font-black tracking-wider mb-1" style={{ color: "var(--text-primary)" }}>
          平台入口
        </h2>
        <p className="text-sm mb-4" style={{ color: "var(--text-muted)" }}>
          一个入口，直达三仙岛全部能力
        </p>

        {registryQuery.isError ? (
          <div
            className="text-xs font-mono px-3 py-2 rounded"
            style={{ background: "rgba(255,255,255,0.03)", color: "var(--text-muted)" }}
          >
            平台服务清单加载失败
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            {services.map((svc) => {
              const meta = APP_META[svc.key];
              const health = healthQuery.data?.results?.[svc.key];
              const resolved = resolveStatus(health, healthQuery.isPending);
              const isSelf = svc.kind === "self";
              const plugin = pluginByKey.get(svc.key);
              // MCP 能力并入平台卡：仅当服务已配置网页 url 才挂徽标（未配置视为纯 MCP，不占顶部位）
              const mcpBadge =
                plugin && svc.url
                  ? plugin.toolCount !== undefined
                    ? `MCP ${plugin.toolCount} 工具`
                    : "MCP 可用"
                  : undefined;
              return (
                <AppCard
                  key={svc.key}
                  label={svc.label}
                  description={meta?.description ?? svc.label}
                  url={isSelf ? undefined : svc.url || undefined}
                  status={resolved.status}
                  latencyMs={health?.latencyMs}
                  reason={resolved.reason}
                  badge={isSelf ? "当前平台" : mcpBadge}
                  busy={busyKey === svc.key}
                  onOpen={(url) => handleOpen(svc.key, url)}
                />
              );
            })}
            <AppCard label="插件中心" description="能力可插拔" status="ok" internalHref="/plugins" />
            {/* 动态 MCP 插件卡片：只展示「无独立网页入口」的纯 MCP 插件（如 ollama/fmg），
                避免与顶部平台卡重复；有网页的平台其 MCP 能力已并到顶部卡徽标 */}
            {pluginCenterQuery.data?.plugins
              ?.filter(
                (p) => p.enabled && p.key !== "echo" && !platformKeysWithUrl.has(p.key),
              )
              .map((p) => (
                <AppCard
                  key={p.key}
                  label={p.name}
                  description={
                    p.key === "ollama"
                      ? "本地 LLM 推理 · MCP 8 工具"
                      : p.key === "fmg"
                        ? "奇幻地图 · MCP 5 工具"
                        : `${p.description ?? "MCP 插件"} · MCP ${p.toolCount ?? 0} 工具`
                  }
                  status={p.status}
                  latencyMs={p.latencyMs}
                  internalHref="/plugins"
                />
              ))}
            {/* 外部应用卡片：Open Web UI（Ollama 的聊天界面） */}
            <AppCard
              label="Open Web UI"
              description="Ollama Web 对话界面"
              status="ok"
              url="https://oll199h.zeabur.app/"
            />
          </div>
        )}
      </div>
    </section>
  );
}
