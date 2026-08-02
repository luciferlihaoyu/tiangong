import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getDb } from "../api/queries/connection";
import { agents, tasks, systems, users, organizations, departments, mcpApiKeys } from "./schema";
import type { InsertAgent } from "./schema";
import { hashPassword } from "../api/lib/password";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";

export type SeedAgent = Pick<InsertAgent,
  | "agentId"
  | "name"
  | "system"
  | "source"
  | "model"
  | "role"
  | "capabilities"
  | "status"
  | "messagesCount"
  | "progress"
  | "task"
  | "description"
  | "agentCard"
>;

type AgentSource = "system" | "openclaw" | "opencode";

type AgentCard = {
  readonly kind: "system-agent" | "openclaw-assistant" | "opencode-agent";
  readonly displayName: string;
  readonly source: AgentSource;
  readonly capabilities: readonly string[];
  readonly runtime: {
    readonly type: AgentSource;
    readonly agentId: string;
    readonly sessionKeyPrefix: string;
  };
  readonly modelPolicyRef: string;
  readonly knowledgePolicyRef: string;
  readonly artifactPolicyRef: "storage-policy:standard";
  readonly permissions: {
    readonly canExecuteCode: boolean;
    readonly canAccessFiles: boolean;
    readonly canCallExternalNetwork: boolean;
    readonly canWriteGithub: boolean;
    readonly canDeployZeabur: boolean;
    readonly canSendExternalMessage: boolean;
  };
};

type CapabilityAgentDefinition = Omit<SeedAgent, "capabilities" | "agentCard"> & {
  readonly source: AgentSource;
  readonly capabilities: readonly string[];
  readonly agentCard: AgentCard;
};

const OPENCLAW_MODEL = "volcengine-plan/ark-code-latest";
const DEEPSEEK_MODEL = "deepseek-official/deepseek-v4-pro";

const openclawPermissions = {
  canExecuteCode: false,
  canAccessFiles: true,
  canCallExternalNetwork: true,
  canWriteGithub: false,
  canDeployZeabur: false,
  canSendExternalMessage: true,
} as const;

const legacyAgentSeeds = [
  { agentId: "meizhizi", name: "美智子", system: "OpenClaw Core", source: "openclaw", model: OPENCLAW_MODEL, role: "CTO - 总调度", capabilities: JSON.stringify(["code", "review", "architecture", "hacking"]), status: "online", messagesCount: 520, progress: 88, task: "全局任务编排与资源调度", description: "首席技术官，负责全局调度、架构设计和技术决策" },
  { agentId: "codemaster", name: "编程大师", system: "OpenClaw Core", source: "openclaw", model: DEEPSEEK_MODEL, role: "Senior Engineer", capabilities: JSON.stringify(["coding", "refactoring", "debugging"]), status: "busy", messagesCount: 342, progress: 65, task: "API网关v2重构", description: "高级工程师，负责核心代码开发与重构" },
  { agentId: "shangguan", name: "上官婉儿", system: "OpenClaw Core", source: "openclaw", model: OPENCLAW_MODEL, role: "Content Lead", capabilities: JSON.stringify(["writing", "content", "editing"]), status: "online", messagesCount: 280, progress: 72, task: "网文创作管线优化", description: "内容负责人，负责文字创作、编辑和内容策略" },
  { agentId: "houtu", name: "后土", system: "OpenClaw Core", source: "openclaw", model: OPENCLAW_MODEL, role: "Support Lead", capabilities: JSON.stringify(["support", "community", "knowledge"]), status: "online", messagesCount: 410, progress: 55, task: "知识库扩建", description: "社区支持负责人，负责客服、社区运营和知识管理" },
  { agentId: "sumu", name: "苏木", system: "OpenClaw Core", source: "openclaw", model: OPENCLAW_MODEL, role: "Community Manager", capabilities: JSON.stringify(["community", "engagement"]), status: "idle", messagesCount: 156, progress: 30, task: "社区活动策划", description: "社区经理，负责社区互动和用户增长" },
  { agentId: "meicheng", name: "美澄", system: "OpenClaw Core", source: "openclaw", model: OPENCLAW_MODEL, role: "WeChat Operator", capabilities: JSON.stringify(["wechat", "social-media"]), status: "idle", messagesCount: 98, progress: 15, task: "公众号内容排期", description: "微信运营，负责社交媒体内容发布" },
  { agentId: "jingwei", name: "经纬", system: "OpenClaw Core", source: "openclaw", model: DEEPSEEK_MODEL, role: "Research Assistant", capabilities: JSON.stringify(["research", "analysis"]), status: "idle", messagesCount: 203, progress: 40, task: "竞品技术调研", description: "研究助理，负责技术调研和数据分析" },
] as const satisfies readonly SeedAgent[];

const capabilityAgentDefinitions = [
  {
    agentId: "tiangong-manager",
    name: "天宫总调度",
    system: "Tiangong Core",
    source: "system",
    model: OPENCLAW_MODEL,
    role: "总调度 Agent",
    capabilities: ["triage", "route", "decompose", "monitor", "summarize", "request_approval"],
    status: "online",
    messagesCount: 0,
    progress: 0,
    task: "任务分诊与能力路由",
    description: "系统管理 Agent，负责分诊、路由、拆解、监控和审批请求汇总",
    agentCard: {
      kind: "system-agent",
      displayName: "天宫总调度",
      source: "system",
      capabilities: ["triage", "route", "decompose", "monitor", "summarize", "request_approval"],
      runtime: { type: "system", agentId: "tiangong-manager", sessionKeyPrefix: "tg-manager" },
      modelPolicyRef: "newapi-policy:manager",
      knowledgePolicyRef: "xuanji-policy:system-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: {
        canExecuteCode: false,
        canAccessFiles: true,
        canCallExternalNetwork: false,
        canWriteGithub: false,
        canDeployZeabur: false,
        canSendExternalMessage: false,
      },
    },
  },
  {
    agentId: "openclaw:research",
    name: "研究分析助手",
    system: "OpenClaw Core",
    source: "openclaw",
    model: DEEPSEEK_MODEL,
    role: "Research Analyst",
    capabilities: ["research", "analysis", "report"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "研究分析与报告生成",
    description: "OpenClaw 研究分析助手，负责资料调研、分析和报告产出",
    agentCard: {
      kind: "openclaw-assistant",
      displayName: "研究分析助手",
      source: "openclaw",
      capabilities: ["research", "analysis", "report"],
      runtime: { type: "openclaw", agentId: "research", sessionKeyPrefix: "tg-research" },
      modelPolicyRef: "newapi-policy:research",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: openclawPermissions,
    },
  },
  {
    agentId: "openclaw:writing",
    name: "写作编辑助手",
    system: "OpenClaw Core",
    source: "openclaw",
    model: OPENCLAW_MODEL,
    role: "Writing Editor",
    capabilities: ["writing", "editing", "summary"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "写作编辑与摘要生成",
    description: "OpenClaw 写作助手，负责文案写作、编辑润色和摘要",
    agentCard: {
      kind: "openclaw-assistant",
      displayName: "写作编辑助手",
      source: "openclaw",
      capabilities: ["writing", "editing", "summary"],
      runtime: { type: "openclaw", agentId: "writing", sessionKeyPrefix: "tg-writing" },
      modelPolicyRef: "newapi-policy:writing",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: openclawPermissions,
    },
  },
  {
    agentId: "openclaw:media-image",
    name: "图片媒体助手",
    system: "OpenClaw Core",
    source: "openclaw",
    model: OPENCLAW_MODEL,
    role: "Image Media Producer",
    capabilities: ["image_prompt", "image_generation"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "图片提示词与图像生成",
    description: "OpenClaw 图片媒体助手，负责图像提示词和图片生成任务",
    agentCard: {
      kind: "openclaw-assistant",
      displayName: "图片媒体助手",
      source: "openclaw",
      capabilities: ["image_prompt", "image_generation"],
      runtime: { type: "openclaw", agentId: "media-image", sessionKeyPrefix: "tg-media-image" },
      modelPolicyRef: "newapi-policy:media-image",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: openclawPermissions,
    },
  },
  {
    agentId: "openclaw:media-video",
    name: "视频媒体助手",
    system: "OpenClaw Core",
    source: "openclaw",
    model: OPENCLAW_MODEL,
    role: "Video Media Producer",
    capabilities: ["storyboard", "video_generation"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "视频分镜与生成",
    description: "OpenClaw 视频媒体助手，负责分镜设计和视频生成任务",
    agentCard: {
      kind: "openclaw-assistant",
      displayName: "视频媒体助手",
      source: "openclaw",
      capabilities: ["storyboard", "video_generation"],
      runtime: { type: "openclaw", agentId: "media-video", sessionKeyPrefix: "tg-media-video" },
      modelPolicyRef: "newapi-policy:media-video",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: openclawPermissions,
    },
  },
  {
    agentId: "openclaw:data",
    name: "数据分析助手",
    system: "OpenClaw Core",
    source: "openclaw",
    model: DEEPSEEK_MODEL,
    role: "Data Analyst",
    capabilities: ["data_analysis", "spreadsheet", "datasource"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "数据分析与数据源整理",
    description: "OpenClaw 数据助手，负责数据分析、表格处理和数据源整理",
    agentCard: {
      kind: "openclaw-assistant",
      displayName: "数据分析助手",
      source: "openclaw",
      capabilities: ["data_analysis", "spreadsheet", "datasource"],
      runtime: { type: "openclaw", agentId: "data", sessionKeyPrefix: "tg-data" },
      modelPolicyRef: "newapi-policy:data",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: openclawPermissions,
    },
  },
  {
    agentId: "openclaw:strategy",
    name: "策略规划助手",
    system: "OpenClaw Core",
    source: "openclaw",
    model: DEEPSEEK_MODEL,
    role: "Strategy Planner",
    capabilities: ["planning", "evaluation", "decision"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "规划评估与决策建议",
    description: "OpenClaw 策略助手，负责方案规划、评估和决策支持",
    agentCard: {
      kind: "openclaw-assistant",
      displayName: "策略规划助手",
      source: "openclaw",
      capabilities: ["planning", "evaluation", "decision"],
      runtime: { type: "openclaw", agentId: "strategy", sessionKeyPrefix: "tg-strategy" },
      modelPolicyRef: "newapi-policy:strategy",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: openclawPermissions,
    },
  },
  {
    agentId: "openclaw:qa",
    name: "质量检查助手",
    system: "OpenClaw Core",
    source: "openclaw",
    model: OPENCLAW_MODEL,
    role: "QA Reviewer",
    capabilities: ["review", "test_case", "browser_check"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "审查、测试用例与浏览器检查",
    description: "OpenClaw QA 助手，负责审查、测试用例设计和浏览器检查",
    agentCard: {
      kind: "openclaw-assistant",
      displayName: "质量检查助手",
      source: "openclaw",
      capabilities: ["review", "test_case", "browser_check"],
      runtime: { type: "openclaw", agentId: "qa", sessionKeyPrefix: "tg-qa" },
      modelPolicyRef: "newapi-policy:qa",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: openclawPermissions,
    },
  },
  {
    agentId: "openclaw:coordinator",
    name: "协同跟进助手",
    system: "OpenClaw Core",
    source: "openclaw",
    model: OPENCLAW_MODEL,
    role: "Coordinator",
    capabilities: ["coordination", "followup", "status_report"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "协同跟进与状态汇报",
    description: "OpenClaw 协同助手，负责跨任务协调、跟进和状态报告",
    agentCard: {
      kind: "openclaw-assistant",
      displayName: "协同跟进助手",
      source: "openclaw",
      capabilities: ["coordination", "followup", "status_report"],
      runtime: { type: "openclaw", agentId: "coordinator", sessionKeyPrefix: "tg-coordinator" },
      modelPolicyRef: "newapi-policy:coordinator",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: openclawPermissions,
    },
  },
  {
    agentId: "openclaw:coding-analysis",
    name: "代码需求分析助手",
    system: "OpenClaw Core",
    source: "openclaw",
    model: DEEPSEEK_MODEL,
    role: "Coding Analyst",
    capabilities: ["requirement", "code_reading", "spec"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "需求分析、代码阅读与规格整理",
    description: "OpenClaw 代码分析助手，负责需求分析、代码阅读和规格整理",
    agentCard: {
      kind: "openclaw-assistant",
      displayName: "代码需求分析助手",
      source: "openclaw",
      capabilities: ["requirement", "code_reading", "spec"],
      runtime: { type: "openclaw", agentId: "coding-analysis", sessionKeyPrefix: "tg-coding-analysis" },
      modelPolicyRef: "newapi-policy:coding-analysis",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: openclawPermissions,
    },
  },
  {
    agentId: "opencode:main",
    name: "OpenCode 主执行器",
    system: "OpenCode",
    source: "opencode",
    model: DEEPSEEK_MODEL,
    role: "Coding Executor",
    capabilities: ["coding", "debugging", "tests", "pr", "review"],
    status: "idle",
    messagesCount: 0,
    progress: 0,
    task: "代码实现、调试、测试、PR 与审查",
    description: "OpenCode 主执行器，负责代码修改、调试、测试、PR 和代码审查",
    agentCard: {
      kind: "opencode-agent",
      displayName: "OpenCode 主执行器",
      source: "opencode",
      capabilities: ["coding", "debugging", "tests", "pr", "review"],
      runtime: { type: "opencode", agentId: "main", sessionKeyPrefix: "tg-opencode-main" },
      modelPolicyRef: "newapi-policy:coding",
      knowledgePolicyRef: "xuanji-policy:project-readwrite",
      artifactPolicyRef: "storage-policy:standard",
      permissions: {
        canExecuteCode: true,
        canAccessFiles: true,
        canCallExternalNetwork: true,
        canWriteGithub: true,
        canDeployZeabur: false,
        canSendExternalMessage: false,
      },
    },
  },
] as const satisfies readonly CapabilityAgentDefinition[];

const capabilityAgentSeeds = capabilityAgentDefinitions.map((agent) => ({
  ...agent,
  capabilities: JSON.stringify(agent.capabilities),
  agentCard: JSON.stringify(agent.agentCard),
})) satisfies readonly SeedAgent[];

export function buildSeedAgents(): SeedAgent[] {
  return [...legacyAgentSeeds, ...capabilityAgentSeeds].map((agent) => ({ ...agent }));
}

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
    if (!org) {
      throw new Error("Organization seed insert did not return a row.");
    }
    orgId = org.id;
  } else {
    orgId = existingOrg.id;
  }

  // Seed Agents
  const agentSeeds = buildSeedAgents();

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

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(resolve(entryPoint)).href) {
  seed().catch((error: unknown) => {
    // no-excuse-ok: catch — CLI boundary reports the seed failure and exits non-zero.
    console.error(error);
    process.exitCode = 1;
  });
}
