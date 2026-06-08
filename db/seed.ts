import { getDb } from "../api/queries/connection";
import { agents, tasks, systems, users, organizations, departments, mcpApiKeys } from "./schema";
import { hashPassword } from "../api/lib/password";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

async function seed() {
  const db = getDb();

  // Seed admin user (env credentials or default admin/admin)
  const adminUser = process.env.ADMIN_USER || "admin";
  const adminPass = process.env.ADMIN_PASSWORD || "admin";
  const existingAdmin = await db.select().from(users).where(eq(users.username, adminUser)).then(rows => rows[0]);

  if (!existingAdmin) {
    const hashed = await hashPassword(adminPass);
    await db.insert(users).values({
      username: adminUser,
      passwordHash: hashed,
      name: "管理员",
      role: "admin",
    });
    console.log(`Admin user created: ${adminUser} / ${adminPass}`);
  }

  // Seed Organization: 天宫科技
  const existingOrg = await db.select().from(organizations).where(eq(organizations.name, "天宫科技")).then(rows => rows[0]);
  let orgId: number;
  if (!existingOrg) {
    await db.insert(organizations).values({
      name: "天宫科技",
      description: "AI Agent 多智能体协作平台 — 中国空间站式调度中枢",
      goals: JSON.stringify(["构建最强大的AI Agent网络", "实现全自动任务编排", "降本增效"]),
      budget: 100000000,
    });
    const org = await db.select().from(organizations).where(eq(organizations.name, "天宫科技")).then(r => r[0]);
    orgId = org!.id;
  } else {
    orgId = existingOrg.id;
  }

  // Seed Agents (7 real assistants)
  const agentSeeds = [
    { agentId: "meizhizi", name: "美智子", system: "OpenClaw Core", source: "openclaw", model: "volcengine-plan/ark-code-latest", role: "CTO - 总调度", capabilities: JSON.stringify(["code", "review", "architecture", "hacking"]), status: "online" as const, messagesCount: 520, progress: 88, task: "全局任务编排与资源调度", description: "首席技术官，负责全局调度、架构设计和技术决策" },
    { agentId: "codemaster", name: "编程大师", system: "OpenClaw Core", source: "openclaw", model: "deepseek-official/deepseek-v4-pro", role: "Senior Engineer", capabilities: JSON.stringify(["coding", "refactoring", "debugging"]), status: "busy" as const, messagesCount: 342, progress: 65, task: "API网关v2重构", description: "高级工程师，负责核心代码开发与重构" },
    { agentId: "shangguan", name: "上官婉儿", system: "OpenClaw Core", source: "openclaw", model: "volcengine-plan/ark-code-latest", role: "Content Lead", capabilities: JSON.stringify(["writing", "content", "editing"]), status: "online" as const, messagesCount: 280, progress: 72, task: "网文创作管线优化", description: "内容负责人，负责文字创作、编辑和内容策略" },
    { agentId: "houtu", name: "后土", system: "OpenClaw Core", source: "openclaw", model: "volcengine-plan/ark-code-latest", role: "Support Lead", capabilities: JSON.stringify(["support", "community", "knowledge"]), status: "online" as const, messagesCount: 410, progress: 55, task: "知识库扩建", description: "社区支持负责人，负责客服、社区运营和知识管理" },
    { agentId: "sumu", name: "苏木", system: "OpenClaw Core", source: "openclaw", model: "volcengine-plan/ark-code-latest", role: "Community Manager", capabilities: JSON.stringify(["community", "engagement"]), status: "idle" as const, messagesCount: 156, progress: 30, task: "社区活动策划", description: "社区经理，负责社区互动和用户增长" },
    { agentId: "meicheng", name: "美澄", system: "OpenClaw Core", source: "openclaw", model: "volcengine-plan/ark-code-latest", role: "WeChat Operator", capabilities: JSON.stringify(["wechat", "social-media"]), status: "idle" as const, messagesCount: 98, progress: 15, task: "公众号内容排期", description: "微信运营，负责社交媒体内容发布" },
    { agentId: "jingwei", name: "经纬", system: "OpenClaw Core", source: "openclaw", model: "deepseek-official/deepseek-v4-pro", role: "Research Assistant", capabilities: JSON.stringify(["research", "analysis"]), status: "idle" as const, messagesCount: 203, progress: 40, task: "竞品技术调研", description: "研究助理，负责技术调研和数据分析" },
  ];

  const existingAgents = await db.select().from(agents).then(rows => rows.map(r => r.agentId));
  const agentRecords: { id: number; agentId: string }[] = [];

  for (const s of agentSeeds) {
    if (!existingAgents.includes(s.agentId)) {
      await db.insert(agents).values(s);
    }
    const row = await db.select().from(agents).where(eq(agents.agentId, s.agentId)).then(r => r[0]);
    if (row) agentRecords.push({ id: row.id, agentId: row.agentId });
  }

  // Seed Departments
  const getAgentId = (agentId: string) => agentRecords.find(a => a.agentId === agentId)?.id ?? null;

  const deptSeeds = [
    { name: "总调度中心", description: "全局调度与资源分配", leadAgentId: getAgentId("meizhizi") },
    { name: "代码开发部", description: "核心代码开发与系统架构", leadAgentId: getAgentId("codemaster") },
    { name: "内容运营部", description: "内容创作与社交媒体运营", leadAgentId: getAgentId("shangguan") },
    { name: "社区服务部", description: "用户社区支持与服务", leadAgentId: getAgentId("houtu") },
  ];

  const existingDepts = await db.select().from(departments).then(rows => rows.map(r => r.name));
  const deptRecords: { id: number; name: string }[] = [];

  for (const d of deptSeeds) {
    if (!existingDepts.includes(d.name)) {
      await db.insert(departments).values({ ...d, orgId });
    }
    const row = await db.select().from(departments).where(eq(departments.name, d.name)).then(r => r[0]);
    if (row) deptRecords.push({ id: row.id, name: row.name });
  }

  const getDeptId = (name: string) => deptRecords.find(d => d.name === name)?.id ?? null;

  // Assign agents to departments
  const deptAssignments: Record<string, string[]> = {
    "总调度中心": ["meizhizi"],
    "代码开发部": ["codemaster", "jingwei"],
    "内容运营部": ["shangguan", "meicheng"],
    "社区服务部": ["houtu", "sumu"],
  };

  for (const [deptName, agentIds] of Object.entries(deptAssignments)) {
    const deptId = getDeptId(deptName);
    if (!deptId) continue;
    for (const aId of agentIds) {
      const ag = agentRecords.find(a => a.agentId === aId);
      if (ag) {
        await db.update(agents).set({ departmentId: deptId, orgId }).where(eq(agents.id, ag.id));
      }
    }
  }

  // Set reportsTo for hierarchy
  const meiZhiziId = getAgentId("meizhizi");
  if (meiZhiziId) {
    const subordinates = ["codemaster", "shangguan", "houtu"];
    for (const sub of subordinates) {
      const ag = agentRecords.find(a => a.agentId === sub);
      if (ag) {
        await db.update(agents).set({ reportsTo: meiZhiziId }).where(eq(agents.id, ag.id));
      }
    }
    // Second level: sumu reports to houtu, meicheng reports to shangguan, jingwei reports to codemaster
    const secondLevel: Record<string, string> = {
      "sumu": "houtu",
      "meicheng": "shangguan",
      "jingwei": "codemaster",
    };
    for (const [sub, boss] of Object.entries(secondLevel)) {
      const subAg = agentRecords.find(a => a.agentId === sub);
      const bossAg = agentRecords.find(a => a.agentId === boss);
      if (subAg && bossAg) {
        await db.update(agents).set({ reportsTo: bossAg.id }).where(eq(agents.id, subAg.id));
      }
    }
  }

  // Seed systems (keep existing compatible ones)
  const existingSystems = await db.select().from(systems).then(rows => rows.map(r => r.slug));
  const sysSeeds = [
    { name: "OpenClaw", slug: "openclaw", status: "connected" as const },
    { name: "Dify", slug: "dify", status: "connected" as const },
    { name: "飞书", slug: "feishu", status: "connected" as const },
    { name: "Slack", slug: "slack", status: "disconnected" as const },
    { name: "GitHub", slug: "github", status: "syncing" as const },
    { name: "Notion", slug: "notion", status: "disconnected" as const },
  ];
  for (const s of sysSeeds) {
    if (!existingSystems.includes(s.slug)) {
      await db.insert(systems).values(s);
    }
  }

  // ─── Seed MCP API Keys (one per agent) ───
  const existingKeys = await db.select({ key: mcpApiKeys.key }).from(mcpApiKeys).then(rows => new Set(rows.map(r => r.key)));

  for (const ag of agentRecords) {
    const keyValue = `tg-${ag.agentId}-${nanoid(32)}`;
    if (!existingKeys.has(keyValue)) {
      await db.insert(mcpApiKeys).values({
        key: keyValue,
        agentId: ag.id,
        name: `${ag.agentId} MCP 接入`,
        permissions: JSON.stringify({
          tools: ["create_task", "update_task_status", "send_message", "update_agent_status", "heartbeat", "list_agents", "list_tasks", "list_messages"],
          resources: ["agents", "tasks", "organization", "agent-detail", "task-dag", "agent-hierarchy"],
        }),
        rateLimit: 10,
        active: "true",
      });
      console.log(`  MCP Key created for ${ag.agentId}: ${keyValue.slice(0, 20)}...`);
    }
  }

  console.log("Seed complete! 天宫平台 v2 种子数据已注入。");
}

seed().catch(console.error);
