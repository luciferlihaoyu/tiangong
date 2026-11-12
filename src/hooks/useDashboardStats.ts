import { useMemo } from "react";
import { trpc } from "@/providers/trpc";
import type { MockAgent, MockTask } from "@/hooks/useDataSource";

export interface DashboardStats {
  agents: MockAgent[];
  tasks: MockTask[];
  totalMsgs: number;
  orgs: number;
  todayCostCents: number | undefined;
  isLoading: boolean;
  hasBackend: boolean;
}

export function useDashboardStats(): DashboardStats {
  const agentQuery = trpc.agent.list.useQuery(undefined, {
    retry: 1,
    staleTime: 30000,
  });

  const taskQuery = trpc.taskboard.list.useQuery(undefined, {
    retry: 1,
    staleTime: 30000,
    enabled: agentQuery.isSuccess,
  });

  const msgStatsQuery = trpc.message.stats.useQuery(undefined, {
    retry: 1,
    staleTime: 30000,
    enabled: agentQuery.isSuccess,
  });

  const orgListQuery = trpc.org.orgList.useQuery(undefined, {
    retry: 1,
    staleTime: 30000,
    enabled: agentQuery.isSuccess,
  });

  const usageByDayQuery = trpc.usage.byDay.useQuery(
    { limit: 7 },
    { retry: 1, staleTime: 30000, enabled: agentQuery.isSuccess }
  );

  const hasBackend = agentQuery.isSuccess;

  const agents = hasBackend ? ((agentQuery.data ?? []) as MockAgent[]) : [];
  const tasks = hasBackend ? ((taskQuery.data ?? []) as MockTask[]) : [];
  const totalMsgs = hasBackend
    ? ((msgStatsQuery.data as { total?: number } | undefined)?.total ?? 0)
    : 0;
  const orgs = hasBackend ? ((orgListQuery.data ?? []) as unknown[]).length : 0;

  const todayCostCents = useMemo(() => {
    if (!usageByDayQuery.data || !Array.isArray(usageByDayQuery.data)) {
      return undefined;
    }
    // 与后端口径对齐：usage.byDay 现在按**本地日**聚合（api/lib/day-sql.ts），
    // 这里也必须用本地日（原先 toISOString 是 UTC 日，北京时间 0~8 点会取到昨天那一行，
    // 首页「今日成本」与用量页对不上）。
    const today = localDayKey(new Date());
    const todayRow = (usageByDayQuery.data as Array<{ date: string; costCents: number }>).find(
      (r) => r.date === today
    );
    return todayRow?.costCents ?? 0;
  }, [usageByDayQuery.data]);

  const isLoading = !hasBackend && agentQuery.isPending;

  return {
    agents,
    tasks,
    totalMsgs,
    orgs,
    todayCostCents,
    isLoading,
    hasBackend,
  };
}

/** 本地时区的 YYYY-MM-DD（与后端 sqlDayOf 的 localtime 口径一致）。 */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
