import { useState } from 'react';

const MOCK_AGENTS = [
  { id: 1, agentId: "AG-01", name: "CEO-01", system: "Claude", status: "online" as const, task: "策略规划与目标对齐", progress: 78, messagesCount: 142, description: "负责整体策略规划", createdBy: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 2, agentId: "AG-02", name: "CTO-02", system: "Codex", status: "busy" as const, task: "代码审查与架构评审", progress: 45, messagesCount: 89, description: "负责技术架构", createdBy: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 3, agentId: "AG-03", name: "CMO-03", system: "Cursor", status: "online" as const, task: "用户增长数据分析", progress: 92, messagesCount: 203, description: "负责市场营销", createdBy: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 4, agentId: "AG-04", name: "COO-04", system: "Claude", status: "idle" as const, task: "资源调度与成本控制", progress: 0, messagesCount: 56, description: "负责运营管理", createdBy: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 5, agentId: "AG-05", name: "DEV-05", system: "GPT-4", status: "busy" as const, task: "API网关部署 v2.1.0", progress: 63, messagesCount: 178, description: "负责开发部署", createdBy: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 6, agentId: "AG-06", name: "QA-06", system: "Claude", status: "online" as const, task: "端到端自动化测试", progress: 34, messagesCount: 67, description: "负责质量保证", createdBy: null, createdAt: new Date(), updatedAt: new Date() },
];

const MOCK_TASKS = [
  { id: 1, taskId: "#142", name: "数据清洗与结构化分析", agentId: 1, status: "running" as const, progress: 78, description: "", createdAt: new Date(), updatedAt: new Date() },
  { id: 2, taskId: "#143", name: "用户行为路径建模", agentId: 2, status: "running" as const, progress: 45, description: "", createdAt: new Date(), updatedAt: new Date() },
  { id: 3, taskId: "#144", name: "API 网关性能优化", agentId: 5, status: "pending" as const, progress: 12, description: "", createdAt: new Date(), updatedAt: new Date() },
  { id: 4, taskId: "#145", name: "多语言内容本地化", agentId: 3, status: "done" as const, progress: 92, description: "", createdAt: new Date(), updatedAt: new Date() },
  { id: 5, taskId: "#146", name: "安全审计日志分析", agentId: 6, status: "running" as const, progress: 63, description: "", createdAt: new Date(), updatedAt: new Date() },
  { id: 6, taskId: "#147", name: "智能推荐算法调优", agentId: 2, status: "pending" as const, progress: 28, description: "", createdAt: new Date(), updatedAt: new Date() },
  { id: 7, taskId: "#148", name: "数据库索引优化", agentId: 5, status: "done" as const, progress: 100, description: "", createdAt: new Date(), updatedAt: new Date() },
];

const MOCK_SYSTEMS = [
  { id: 1, name: "Slack", slug: "slack", status: "connected" as const, config: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 2, name: "Email", slug: "email", status: "connected" as const, config: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 3, name: "Webhook", slug: "webhook", status: "connected" as const, config: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 4, name: "GitHub", slug: "github", status: "syncing" as const, config: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 5, name: "Jira", slug: "jira", status: "connected" as const, config: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 6, name: "Notion", slug: "notion", status: "disconnected" as const, config: null, createdAt: new Date(), updatedAt: new Date() },
];

export function useMockData() {
  const [agents, setAgents] = useState(MOCK_AGENTS);
  const [tasks, setTasks] = useState(MOCK_TASKS);
  const [systems, setSystems] = useState(MOCK_SYSTEMS);

  const updateAgentStatus = (id: number, status: 'idle' | 'online' | 'busy') => {
    setAgents(prev => prev.map(a => a.id === id ? { ...a, status } : a));
  };

  const updateSystemStatus = (id: number, status: 'connected' | 'syncing' | 'disconnected') => {
    setSystems(prev => prev.map(s => s.id === id ? { ...s, status } : s));
  };

  const updateTaskProgress = (id: number, progress: number, status?: string) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, progress, status: (status as any) || t.status } : t));
  };

  return {
    agents,
    tasks,
    systems,
    msgStats: { total: 735 },
    updateAgentStatus,
    updateSystemStatus,
    updateTaskProgress,
  };
}
