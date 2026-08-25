import { useMemo, useEffect, useState, useCallback } from "react";
import { trpc } from "@/providers/trpc";

// Helper: call tRPC via fetch (avoids React hook issues in callbacks)
async function trpcFetch(path: string, input?: any): Promise<any> {
  const token = localStorage.getItem("tiangong_token");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const isQuery = !["create", "update", "delete", "changePassword", "register", "login", "revoke", "activate", "addDep", "removeDep"].some(s => path.includes(s));
  const url = `/api/trpc/${path}${isQuery && input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`;
  const res = await fetch(url, {
    method: input !== undefined && !isQuery ? "POST" : "GET",
    headers,
    body: input !== undefined && !isQuery ? JSON.stringify(input) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: `HTTP ${res.status}` }));
    throw new Error(err?.message || err?.[0]?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

// Reuse DB types
export interface MockAgent {
  id: number; agentId: string; name: string; system: string;
  status: string; task: string | null; progress: number; messagesCount: number;
  description?: string | null;
  source?: string | null; model?: string | null; role?: string | null;
  capabilities?: string | null;
  orgId?: number | null; departmentId?: number | null;
  reportsTo?: number | null;
  currentTask?: string | null;
  budgetCents?: number; spentCents?: number;
  lastHeartbeat?: string | null;
  sourceApiKey?: string | null;
}
export interface MockTask {
  id: number; taskId: string; name: string; agentId: number | null;
  status: string; progress: number; description?: string | null;
  priority?: number; input?: string | null; output?: string | null;
  error?: string | null; retryCount?: number; maxRetries?: number;
  timeoutMs?: number; parentTaskId?: number | null;
}
export interface MockSystem {
  id: number; name: string; slug: string; status: string;
  config?: string | null;
}
export interface MockOrg {
  id: number; name: string; description: string | null;
  goals?: string | null; budget?: number;
  createdAt: string; updatedAt: string;
}
export interface MockDept {
  id: number; name: string; description: string | null;
  orgId: number; leadAgentId: number | null;
}

let nextId = 300;

export function useDataSource() {
  const agentQuery = trpc.agent.list.useQuery(undefined, { retry: 1, staleTime: 30000 });
  const taskQuery = trpc.task.list.useQuery(undefined, { retry: 1, staleTime: 30000, enabled: agentQuery.isSuccess });
  const systemQuery = trpc.system.list.useQuery(undefined, { retry: 1, staleTime: 30000, enabled: agentQuery.isSuccess });
  const msgStatsQuery = trpc.message.stats.useQuery(undefined, { retry: 1, staleTime: 30000, enabled: agentQuery.isSuccess });
  const orgListQuery = trpc.org.orgList.useQuery(undefined, { retry: 1, staleTime: 30000, enabled: agentQuery.isSuccess });

  const hasBackend = agentQuery.isSuccess;

  // Local optimistic state when backend unavailable
  const [localAgents, setLocalAgents] = useState<MockAgent[]>([]);
  const [localTasks, setLocalTasks] = useState<MockTask[]>([]);
  const [localSystems, setLocalSystems] = useState<MockSystem[]>([]);
  const [localOrgs, setLocalOrgs] = useState<MockOrg[]>([]);

  const agents = hasBackend ? (agentQuery.data || []) as MockAgent[] : localAgents;
  const tasks = hasBackend ? (taskQuery.data || []) as MockTask[] : localTasks;
  const systems = hasBackend ? (systemQuery.data || []) as MockSystem[] : localSystems;
  const orgs = hasBackend ? (orgListQuery.data || []) as MockOrg[] : localOrgs;
  const msgStats = hasBackend
    ? (msgStatsQuery.data || { total: 0 })
    : { total: agents.reduce((s: number, a: MockAgent) => s + (a.messagesCount || 0), 0) };

  // ── Agent mutations ──
  const addAgent = useCallback(async (data: Record<string, string>) => {
    if (hasBackend) {
      await trpcFetch("agent.create", {
        agentId: data.agentId || `AG-${String(Date.now()).slice(-4)}`,
        name: data.name,
        system: data.system || "custom",
        description: data.description,
        source: data.source || "custom",
        model: data.model,
        role: data.role,
        capabilities: data.capabilities,
      });
      await agentQuery.refetch();
      return;
    }
    const id = ++nextId;
    const newAgent: MockAgent = {
      id, agentId: data.agentId || `AG-${String(id).padStart(2, "0")}`,
      name: data.name, system: data.system || "custom", status: "idle",
      task: data.task || null, progress: 0, messagesCount: 0,
      description: data.description || null,
      source: data.source || "custom", model: data.model || null,
      role: data.role || null, capabilities: data.capabilities || null,
    };
    setLocalAgents(prev => [...prev, newAgent]);
  }, [hasBackend, agentQuery]);
  const updateAgent = useCallback(async (id: number, data: Partial<MockAgent>) => {
    if (hasBackend) {
      await trpcFetch("agent.update", { id, ...data });
      await agentQuery.refetch();
      return;
    }
    setLocalAgents(prev => prev.map(a => a.id === id ? { ...a, ...data } : a));
  }, [hasBackend, agentQuery]);
  const deleteAgent = useCallback(async (id: number) => {
    if (hasBackend) {
      await trpcFetch("agent.delete", { id });
      await agentQuery.refetch();
      await taskQuery.refetch();
      return;
    }
    setLocalAgents(prev => prev.filter(a => a.id !== id));
    setLocalTasks(prev => prev.filter(t => t.agentId !== id));
  }, [hasBackend, agentQuery, taskQuery]);
  const updateAgentStatus = useCallback(async (id: number, status: string) => {
    if (hasBackend) {
      await trpcFetch("agent.update", { id, status });
      await agentQuery.refetch();
      return;
    }
    setLocalAgents(prev => prev.map(a => a.id === id ? { ...a, status } : a));
  }, [hasBackend, agentQuery]);

  // ── Task mutations ──
  const addTask = useCallback(async (data: Record<string, string>) => {
    if (hasBackend) {
      await trpcFetch("task.create", {
        taskId: data.taskId || `TASK-${Date.now()}`,
        name: data.name,
        agentId: data.agentId ? Number(data.agentId) : undefined,
        description: data.description,
        priority: Number(data.priority) || 0,
      });
      await taskQuery.refetch();
      return;
    }
    const id = ++nextId;
    const newTask: MockTask = {
      id, taskId: `#${nextId}`, name: data.name,
      agentId: data.agentId ? Number(data.agentId) : null,
      status: "pending", progress: 0, description: data.description || null,
      priority: Number(data.priority) || 0,
    };
    setLocalTasks(prev => [newTask, ...prev]);
  }, [hasBackend, taskQuery]);
  const deleteTask = useCallback(async (id: number) => {
    if (hasBackend) {
      await trpcFetch("task.delete", { id });
      await taskQuery.refetch();
      return;
    }
    setLocalTasks(prev => prev.filter(t => t.id !== id));
  }, [hasBackend, taskQuery]);
  const updateTaskProgress = useCallback(async (id: number, progress: number, status: string) => {
    if (hasBackend) {
      await trpcFetch("orch.updateStatus", { id, status, progress });
      await taskQuery.refetch();
      return;
    }
    setLocalTasks(prev => prev.map(t => t.id === id ? { ...t, progress, status } : t));
  }, [hasBackend, taskQuery]);

  // ── System mutations ──
  // admin-only 后端端点（普通用户会 403，Batch 2 加角色门控）；失败不再静默。
  const updateSystemStatus = useCallback(async (id: number, status: string) => {
    if (hasBackend) {
      try {
        await trpcFetch("system.updateStatus", { id, status });
        await systemQuery.refetch();
      } catch (err) {
        console.error("[useDataSource] system.updateStatus failed:", err);
      }
      return;
    }
    setLocalSystems(prev => prev.map(s => s.id === id ? { ...s, status } : s));
  }, [hasBackend, systemQuery]);
  // updateSystemConfig 已移除：后端无 system.updateConfig 端点，且全仓库无消费点，
  // 之前的实现只改内存 state 造成「假持久化」。

  // ── Org mutations ──
  const addOrg = useCallback(async (data: Record<string, string>) => {
    if (hasBackend) {
      try {
        await trpcFetch("org.orgCreate", { name: data.name, description: data.description || undefined });
        await orgListQuery.refetch();
      } catch (err) {
        console.error("[useDataSource] org.orgCreate failed:", err);
      }
      return;
    }
    const id = ++nextId;
    const now = new Date().toISOString();
    setLocalOrgs(prev => [...prev, { id, name: data.name, description: data.description || null, createdAt: now, updatedAt: now }]);
  }, [hasBackend, orgListQuery]);
  const updateOrg = useCallback(async (id: number, data: Partial<MockOrg>) => {
    if (hasBackend) {
      // 后端 zod 只接受字符串字段非 null，过滤掉未提供/空字段
      const payload: Record<string, unknown> = { id };
      if (data.name !== undefined) payload.name = data.name;
      if (data.description != null) payload.description = data.description;
      if (data.goals != null) payload.goals = data.goals;
      if (data.budget !== undefined) payload.budget = Number(data.budget);
      try {
        await trpcFetch("org.orgUpdate", payload);
        await orgListQuery.refetch();
      } catch (err) {
        console.error("[useDataSource] org.orgUpdate failed:", err);
      }
      return;
    }
    setLocalOrgs(prev => prev.map(o => o.id === id ? { ...o, ...data, updatedAt: new Date().toISOString() } : o));
  }, [hasBackend, orgListQuery]);
  const deleteOrg = useCallback(async (id: number) => {
    if (hasBackend) {
      try {
        await trpcFetch("org.orgDelete", { id });
        await orgListQuery.refetch();
      } catch (err) {
        console.error("[useDataSource] org.orgDelete failed:", err);
      }
      return;
    }
    setLocalOrgs(prev => prev.filter(o => o.id !== id));
  }, [hasBackend, orgListQuery]);

  return {
    agents, tasks, systems, orgs, msgStats,
    isLoading: !hasBackend && agentQuery.isPending,
    hasBackend,
    addAgent, updateAgent, deleteAgent,
    addTask, deleteTask,
    addOrg, updateOrg, deleteOrg,
    updateAgentStatus, updateSystemStatus, updateTaskProgress,
  };
}
