import { trpc } from "@/providers/trpc";
import AppCard from "@/components/AppCard";

type AppStatus = "ok" | "down" | "unknown";

/** 各平台应用固定文案；key 未命中时用 registry 的 label 兜底 */
const APP_META: Record<string, { description: string }> = {
  tiangong: { description: "智能体编排 · 任务看板" },
  beidou: { description: "AI 写作" },
  xuanji: { description: "知识库与记忆" },
  tianshu: { description: "模型网关" },
  alist: { description: "文件存储" },
};

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

  const services = registryQuery.data ?? [];

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
              return (
                <AppCard
                  key={svc.key}
                  label={svc.label}
                  description={meta?.description ?? svc.label}
                  url={isSelf ? undefined : svc.url || undefined}
                  status={resolved.status}
                  latencyMs={health?.latencyMs}
                  reason={resolved.reason}
                  badge={isSelf ? "当前平台" : undefined}
                />
              );
            })}
            <AppCard label="插件中心" description="即将上线" status="unknown" disabled />
          </div>
        )}
      </div>
    </section>
  );
}
