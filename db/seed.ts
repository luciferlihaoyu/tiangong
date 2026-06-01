import { getDb } from "../api/queries/connection";
import { agents, tasks, systems } from "./schema";

async function seed() {
  const db = getDb();

  // Seed Agents
  await db.insert(agents).values([
    { agentId: "AG-01", name: "CEO-01", system: "Claude", status: "online", task: "策略规划与目标对齐", progress: 78, messagesCount: 142, description: "负责整体策略规划和目标对齐" },
    { agentId: "AG-02", name: "CTO-02", system: "Codex", status: "busy", task: "代码审查与架构评审", progress: 45, messagesCount: 89, description: "负责技术架构和代码审查" },
    { agentId: "AG-03", name: "CMO-03", system: "Cursor", status: "online", task: "用户增长数据分析", progress: 92, messagesCount: 203, description: "负责市场营销和用户增长" },
    { agentId: "AG-04", name: "COO-04", system: "Claude", status: "idle", task: "资源调度与成本控制", progress: 0, messagesCount: 56, description: "负责运营管理和成本控制" },
    { agentId: "AG-05", name: "DEV-05", system: "GPT-4", status: "busy", task: "API网关部署 v2.1.0", progress: 63, messagesCount: 178, description: "负责开发和部署" },
    { agentId: "AG-06", name: "QA-06", system: "Claude", status: "online", task: "端到端自动化测试", progress: 34, messagesCount: 67, description: "负责质量保证和测试" },
  ]);

  // Seed Tasks
  await db.insert(tasks).values([
    { taskId: "#142", name: "数据清洗与结构化分析", agentId: 1, status: "running", progress: 78, description: "清洗和结构化用户行为数据" },
    { taskId: "#143", name: "用户行为路径建模", agentId: 2, status: "running", progress: 45, description: "构建用户行为路径模型" },
    { taskId: "#144", name: "API 网关性能优化", agentId: 5, status: "pending", progress: 12, description: "优化API网关响应时间" },
    { taskId: "#145", name: "多语言内容本地化", agentId: 3, status: "done", progress: 92, description: "支持中文、英文、日文本地化" },
    { taskId: "#146", name: "安全审计日志分析", agentId: 6, status: "running", progress: 63, description: "分析安全审计日志" },
    { taskId: "#147", name: "智能推荐算法调优", agentId: 2, status: "pending", progress: 28, description: "调优推荐算法参数" },
    { taskId: "#148", name: "数据库索引优化", agentId: 5, status: "done", progress: 100, description: "优化数据库查询性能" },
  ]);

  // Seed Systems
  await db.insert(systems).values([
    { name: "Slack", slug: "slack", status: "connected" },
    { name: "Email", slug: "email", status: "connected" },
    { name: "Webhook", slug: "webhook", status: "connected" },
    { name: "GitHub", slug: "github", status: "syncing" },
    { name: "Jira", slug: "jira", status: "connected" },
    { name: "Notion", slug: "notion", status: "disconnected" },
  ]);

  console.log("Seed complete!");
}

seed().catch(console.error);
