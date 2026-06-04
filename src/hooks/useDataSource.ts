import { useState, useEffect, useCallback } from "react";
import { trpc } from "@/providers/trpc";

export interface MockAgent {
  id: number; agentId: string; name: string; system: string;
  status: string; task: string | null; progress: number; messagesCount: number;
  description?: string | null;
}
export interface MockTask {
  id: number; taskId: string; name: string; agentId: number | null;
  status: string; progress: number; description?: string | null;
}
export interface MockSystem {
  id: number; name: string; slug: string; status: string;
  config?: string | null;
}
export interface MockOrg {
  id: number; name: string; description: string | null;
  agents: number; createdAt: string;
}

const INITIAL_AGENTS: MockAgent[] = [
  { id: 1, agentId: "AG-01", name: "CEO-01", system: "Claude", status: "online", task: "策略规划与目标对齐", progress: 78, messagesCount: 142, description: "负责整体策略规划与目标对齐" },
  { id: 2, agentId: "AG-02", name: "CTO-02", system: "Codex", status: "busy", task: "代码审查与架构评审", progress: 45, messagesCount: 89, description: "负责技术架构与代码审查" },
  { id: 3, agentId: "AG-03", name: "CMO-03", system: "Cursor", status: "online", task: "用户增长数据分析", progress: 92, messagesCount: 203, description: "负责市场营销与用户增长" },
  { id: 4, agentId: "AG-04", name: "COO-04", system: "Claude", status: "idle", task: "资源调度与成本控制", progress: 0, messagesCount: 56, description: "负责运营管理与成本控制" },
  { id: 5, agentId: "AG-05", name: "DEV-05", system: "GPT-4", status: "busy", task: "API网关部署 v2.1.0", progress: 63, messagesCount: 178, description: "负责开发与部署" },
  { id: 6, agentId: "AG-06", name: "QA-06", system: "Claude", status: "online", task: "端到端自动化测试", progress: 34, messagesCount: 67, description: "负责质量保证与测试" },
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
  { id: 1, name: "Slack", slug: "slack", status: "connected", config: '{"webhookUrl":"https://hooks.slack.com/xxx","channel":"#agent-alerts"}' },
  { id: 2, name: "Email", slug: "email", status: "connected", config: '{"smtpHost":"smtp.gmail.com","port":"587"}' },
  { id: 3, name: "Webhook", slug: "webhook", status: "connected", config: '{"webhookUrl":"https://api.example.com/webhook"}' },
  { id: 4, name: "GitHub", slug: "github", status: "syncing", config: '{"repo":"luciferlihaoyu/tiangong","token":"ghp_xxx"}' },
  { id: 5, name: "Jira", slug: "jira", status: "connected", config: '{"project":"TIAN","url":"https://tiangong.atlassian.net"}' },
  { id: 6, name: "Notion", slug: "notion", status: "disconnected", config: null },
];

const INITIAL_ORGS: MockOrg[] = [
  { id: 1, name: "天宫科技", description: "主公司 - AI Agent调度平台", agents: 6, createdAt: "2026-01-15" },
];

const LS_KEY = "tiangong_data";

interface StoredData {
  agents: MockAgent[];
  tasks: MockTask[];
  systems: MockSystem[];
  orgs: MockOrg[];
}

function loadFromStorage(): StoredData | null {
  try { const raw = localStorage.getItem(LS_KEY); if (raw) return JSON.parse(raw); } catch { /* ignore */ }
  return null;
}
function saveToStorage(data: StoredData) { localStorage.setItem(LS_KEY, JSON.stringify(data)); }

let nextId = 200;

export function useDataSource() {
  // All hooks must be called unconditionally at the top level
  const agentQuery = trpc.agent.list.useQuery(undefined, { retry: 0, staleTime: Infinity });
  const taskQuery = trpc.task.list.useQuery(undefined, { retry: 0, staleTime: Infinity, enabled: agentQuery.isSuccess });
  const systemQuery = trpc.system.list.useQuery(undefined, { retry: 0, staleTime: Infinity, enabled: agentQuery.isSuccess });
  const msgStatsQuery = trpc.message.stats.useQuery(undefined, { retry: 0, staleTime: Infinity, enabled: agentQuery.isSuccess });

  const hasBackend = agentQuery.isSuccess;

  const [mockData, setMockData] = useState<StoredData>(() => {
    const saved = loadFromStorage();
    return saved || { agents: INITIAL_AGENTS, tasks: INITIAL_TASKS, systems: INITIAL_SYSTEMS, orgs: INITIAL_ORGS };
  });
  useEffect(() => { saveToStorage(mockData); }, [mockData]);

  const agents = hasBackend ? (agentQuery.data || []) : mockData.agents;
  const tasks = hasBackend ? (taskQuery.data || []) : mockData.tasks;
  const systems = hasBackend ? (systemQuery.data || []) : mockData.systems;
  const orgs = mockData.orgs;
  const msgStats = hasBackend
    ? (msgStatsQuery.data || { total: 0 })
    : { total: mockData.agents.reduce((s: number, a: MockAgent) => s + a.messagesCount, 0) };

  // Agent CRUD
  const addAgent = useCallback((data: { name: string; system: string; task: string; description: string }) => {
    const id = ++nextId;
    const newAgent: MockAgent = { id, agentId: `AG-${String(id).padStart(2, '0')}`, name: data.name, system: data.system, status: "idle", task: data.task || null, progress: 0, messagesCount: 0, description: data.description || null };
    setMockData(prev => ({ ...prev, agents: [...prev.agents, newAgent] }));
  }, []);
  const updateAgent = useCallback((id: number, data: Partial<MockAgent>) => {
    setMockData(prev => ({ ...prev, agents: prev.agents.map(a => a.id === id ? { ...a, ...data } : a) }));
  }, []);
  const deleteAgent = useCallback((id: number) => {
    setMockData(prev => ({ ...prev, agents: prev.agents.filter(a => a.id !== id), tasks: prev.tasks.filter(t => t.agentId !== id) }));
  }, []);

  // Task CRUD
  const addTask = useCallback((data: { name: string; agentId: number | null; description: string }) => {
    const id = ++nextId;
    const taskCount = mockData.tasks.length + 149;
    const newTask: MockTask = { id, taskId: `#${taskCount}`, name: data.name, agentId: data.agentId, status: "pending", progress: 0, description: data.description || null };
    setMockData(prev => ({ ...prev, tasks: [newTask, ...prev.tasks] }));
  }, [mockData.tasks.length]);
  const deleteTask = useCallback((id: number) => {
    setMockData(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== id) }));
  }, []);

  // System config
  const updateSystemConfig = useCallback((id: number, config: string) => {
    setMockData(prev => ({ ...prev, systems: prev.systems.map(s => s.id === id ? { ...s, config } : s) }));
  }, []);

  // Org CRUD
  const addOrg = useCallback((data: { name: string; description: string }) => {
    const id = ++nextId;
    const newOrg: MockOrg = { id, name: data.name, description: data.description || null, agents: 0, createdAt: new Date().toISOString().slice(0, 10) };
    setMockData(prev => ({ ...prev, orgs: [...prev.orgs, newOrg] }));
  }, []);
  const updateOrg = useCallback((id: number, data: Partial<MockOrg>) => {
    setMockData(prev => ({ ...prev, orgs: prev.orgs.map(o => o.id === id ? { ...o, ...data } : o) }));
  }, []);
  const deleteOrg = useCallback((id: number) => {
    setMockData(prev => ({ ...prev, orgs: prev.orgs.filter(o => o.id !== id) }));
  }, []);

  // Status toggles
  const updateAgentStatus = useCallback((id: number, status: string) => {
    setMockData(prev => ({ ...prev, agents: prev.agents.map(a => a.id === id ? { ...a, status } : a) }));
  }, []);
  const updateSystemStatus = useCallback((id: number, status: string) => {
    setMockData(prev => ({ ...prev, systems: prev.systems.map(s => s.id === id ? { ...s, status } : s) }));
  }, []);
  const updateTaskProgress = useCallback((id: number, progress: number, status: string) => {
    setMockData(prev => ({ ...prev, tasks: prev.tasks.map(t => t.id === id ? { ...t, progress, status } : t) }));
  }, []);

  return {
    agents, tasks, systems, orgs, msgStats,
    isLoading: !hasBackend && agentQuery.isPending,
    hasBackend,
    addAgent, updateAgent, deleteAgent,
    addTask, deleteTask,
    updateSystemConfig,
    addOrg, updateOrg, deleteOrg,
    updateAgentStatus, updateSystemStatus, updateTaskProgress,
  };
}
