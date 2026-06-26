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

  const taskQuery = trpc.task.list.useQuery(undefined, {
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
    const today = new Date().toISOString().slice(0, 10);
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
