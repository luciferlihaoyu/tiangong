import { useState, useEffect, useCallback } from "react";
import { trpc } from "@/providers/trpc";

// ─── Mock 数据类型 ───
export interface MockAgent {
  id: number; agentId: string; name: string; system: string;
  status: string; task: string | null; progress: number; messagesCount: number;
}
export interface MockTask {
  id: number; taskId: string; name: string; agentId: number | null;
  status: string; progress: number;
}
export interface MockSystem {
  id: number; name: string; slug: string; status: string;
}

// ─── Mock 数据 ───
const INITIAL_AGENTS: MockAgent[] = [
  { id: 1, agentId: "AG-01", name: "CEO-01", system: "Claude", status: "online", task: "策略规划与目标对齐", progress: 78, messagesCount: 142 },
  { id: 2, agentId: "AG-02", name: "CTO-02", system: "Codex", status: "busy", task: "代码审查与架构评审", progress: 45, messagesCount: 89 },
  { id: 3, agentId: "AG-03", name: "CMO-03", system: "Cursor", status: "online", task: "用户增长数据分析", progress: 92, messagesCount: 203 },
  { id: 4, agentId: "AG-04", name: "COO-04", system: "Claude", status: "idle", task: "资源调度与成本控制", progress: 0, messagesCount: 56 },
  { id: 5, agentId: "AG-05", name: "DEV-05", system: "GPT-4", status: "busy", task: "API网关部署 v2.1.0", progress: 63, messagesCount: 178 },
  { id: 6, agentId: "AG-06", name: "QA-06", system: "Claude", status: "online", task: "端到端自动化测试", progress: 34, messagesCount: 67 },
];

const INITIAL_TASKS: MockTask[] = [
  { id: 1, taskId: "#142", name: "数据清洗与结构化分析", agentId: 1, status: "running", progress: 78 },
  { id: 2, taskId: "#143", name: "用户行为路径建模", agentId: 2, status: "running", progress: 45 },
  { id: 3, taskId: "#144", name: "API 网关性能优化", agentId: 5, status: "pending", progress: 12 },
  { id: 4, taskId: "#145", name: "多语言内容本地化", agentId: 3, status: "done", progress: 92 },
  { id: 5, taskId: "#146", name: "安全审计日志分析", agentId: 6, status: "running", progress: 63 },
  { id: 6, taskId: "#147", name: "智能推荐算法调优", agentId: 2, status: "pending", progress: 28 },
  { id: 7, taskId: "#148", name: "数据库索引优化", agentId: 5, status: "done", progress: 100 },
];

const INITIAL_SYSTEMS: MockSystem[] = [
  { id: 1, name: "Slack", slug: "slack", status: "connected" },
  { id: 2, name: "Email", slug: "email", status: "connected" },
  { id: 3, name: "Webhook", slug: "webhook", status: "connected" },
  { id: 4, name: "GitHub", slug: "github", status: "syncing" },
  { id: 5, name: "Jira", slug: "jira", status: "connected" },
  { id: 6, name: "Notion", slug: "notion", status: "disconnected" },
];

const LS_KEY = "tiangong_data";

interface StoredData {
  agents: MockAgent[];
  tasks: MockTask[];
  systems: MockSystem[];
}

function loadFromStorage(): StoredData | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as StoredData;
  } catch { /* ignore */ }
  return null;
}

function saveToStorage(data: StoredData) {
  localStorage.setItem(LS_KEY, JSON.stringify(data));
}

export function useDataSource() {
  // Try backend first, with fast timeout
  const agentQuery = trpc.agent.list.useQuery(undefined, {
    retry: 0,
    staleTime: Infinity,
  });

  const hasBackend = agentQuery.isSuccess;

  // Frontend state (with localStorage persistence)
  const [mockData, setMockData] = useState<StoredData>(() => {
    const saved = loadFromStorage();
    return saved || {
      agents: INITIAL_AGENTS,
      tasks: INITIAL_TASKS,
      systems: INITIAL_SYSTEMS,
    };
  });

  // Save to localStorage on change
  useEffect(() => {
    saveToStorage(mockData);
  }, [mockData]);

  // Use backend data if available, otherwise mock
  const agents: MockAgent[] = hasBackend ? (agentQuery.data || []) : mockData.agents;
  const tasks: MockTask[] = hasBackend
    ? (trpc.task.list.useQuery(undefined, { enabled: hasBackend }).data || [])
    : mockData.tasks;
  const systems: MockSystem[] = hasBackend
    ? (trpc.system.list.useQuery(undefined, { enabled: hasBackend }).data || [])
    : mockData.systems;
  const msgStats = hasBackend
    ? (trpc.message.stats.useQuery(undefined, { enabled: hasBackend }).data || { total: 0 })
    : { total: mockData.agents.reduce((s: number, a: MockAgent) => s + a.messagesCount, 0) };

  // Mock update functions
  const updateAgentStatus = useCallback((id: number, status: string) => {
    setMockData((prev: StoredData) => ({
      ...prev,
      agents: prev.agents.map((a: MockAgent) => a.id === id ? { ...a, status } : a),
    }));
  }, []);

  const updateSystemStatus = useCallback((id: number, status: string) => {
    setMockData((prev: StoredData) => ({
      ...prev,
      systems: prev.systems.map((s: MockSystem) => s.id === id ? { ...s, status } : s),
    }));
  }, []);

  const updateTaskProgress = useCallback((id: number, progress: number, status: string) => {
    setMockData((prev: StoredData) => ({
      ...prev,
      tasks: prev.tasks.map((t: MockTask) => t.id === id ? { ...t, progress, status } : t),
    }));
  }, []);

  return {
    agents,
    tasks,
    systems,
    msgStats,
    isLoading: !hasBackend && agentQuery.isPending,
    hasBackend,
    updateAgentStatus,
    updateSystemStatus,
    updateTaskProgress,
  };
}
