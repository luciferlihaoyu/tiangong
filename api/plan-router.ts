/**
 * 任务 DAG + 组织架构 + 任务计划生成器
 */
import { z } from "zod";
import { createRouter, publicQuery } from "./middleware";
import { getDb } from "./queries/connection";
import { tasks, taskDependencies, agents, organizations, departments } from "@db/schema";
import { eq, and, inArray, asc, desc, isNull } from "drizzle-orm";

export const planRouter = createRouter({
  /* ═══════════════════════════════════════════
     任务 DAG
     ═══════════════════════════════════════════ */

  /**
   * 获取任务 DAG（有向无环图）
   * 返回所有任务节点 + 依赖边
   */
  dag: publicQuery
    .input(
      z
        .object({
          parentTaskId: z.number().optional(),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const db = getDb();

      let taskRows;
      if (input?.parentTaskId) {
        // 获取父任务及其所有子任务
        taskRows = await db
          .select()
          .from(tasks)
          .where(
            eq(tasks.parentTaskId, input.parentTaskId)
          )
          .orderBy(asc(tasks.createdAt));

        const parent = await db
          .select()
          .from(tasks)
          .where(eq(tasks.id, input.parentTaskId))
          .then((rows) => rows[0]);

        if (parent) {
          taskRows = [parent, ...taskRows];
        }
      } else {
        // 获取最近的顶层任务（没有 parentTaskId 的）
        taskRows = await db
          .select()
          .from(tasks)
          .where(isNull(tasks.parentTaskId))
          .orderBy(desc(tasks.createdAt))
          .limit(input?.limit ?? 100);
      }

      const taskIds = taskRows.map((t) => t.id);

      // 获取依赖关系
      const deps = taskIds.length > 0
        ? await db
            .select()
            .from(taskDependencies)
            .where(inArray(taskDependencies.taskId, taskIds))
        : [];

      // 获取 Agent 信息
      const agentIds = Array.from(new Set(taskRows.map((t) => t.agentId).filter((id): id is number => id !== null)));
      const agentRows = agentIds.length > 0
        ? await db.select({ id: agents.id, name: agents.name, agentId: agents.agentId }).from(agents).where(inArray(agents.id, agentIds))
        : [];
      const agentMap = new Map(agentRows.map((a) => [a.id, a]));

      return {
        nodes: taskRows.map((t) => ({
          id: t.id,
          taskId: t.taskId,
          name: t.name,
          status: t.status,
          progress: t.progress,
          priority: t.priority,
          agentId: t.agentId,
          agentName: t.agentId ? agentMap.get(t.agentId)?.name || null : null,
          parentTaskId: t.parentTaskId,
          output: t.output?.slice(0, 200) || null,
          error: t.error,
          outputValid: t.outputValid,
          createdAt: t.createdAt?.toISOString?.() || String(t.createdAt),
          updatedAt: t.updatedAt?.toISOString?.() || String(t.updatedAt),
        })),
        edges: deps.map((d) => ({
          from: d.dependsOnTaskId,
          to: d.taskId,
        })),
      };
    }),

  /**
   * 获取单个任务的完整 DAG（含子任务和依赖）
   */
  taskDag: publicQuery
    .input(z.object({ taskId: z.number() }))
    .query(async ({ input }) => {
      const db = getDb();

      // 获取任务本身
      const task = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .then((rows) => rows[0]);

      if (!task) return null;

      // 如果是子任务，获取兄弟任务
      let allTasks = [task];
      if (task.parentTaskId) {
        const siblings = await db
          .select()
          .from(tasks)
          .where(eq(tasks.parentTaskId, task.parentTaskId))
          .orderBy(asc(tasks.createdAt));
        allTasks = [...new Map([...allTasks, ...siblings].map((t) => [t.id, t])).values()];

        // 也获取父任务
        const parent = await db
          .select()
          .from(tasks)
          .where(eq(tasks.id, task.parentTaskId))
          .then((rows) => rows[0]);
        if (parent) {
          allTasks = [parent, ...allTasks];
        }
      }

      const taskIds = allTasks.map((t) => t.id);
      const deps = await db
        .select()
        .from(taskDependencies)
        .where(inArray(taskDependencies.taskId, taskIds));

      const agentIds = Array.from(new Set(allTasks.map((t) => t.agentId).filter((id): id is number => id !== null)));
      const agentRows = agentIds.length > 0
        ? await db.select({ id: agents.id, name: agents.name, agentId: agents.agentId }).from(agents).where(inArray(agents.id, agentIds))
        : [];
      const agentMap = new Map(agentRows.map((a) => [a.id, a]));

      return {
        nodes: allTasks.map((t) => ({
          id: t.id,
          taskId: t.taskId,
          name: t.name,
          status: t.status,
          progress: t.progress,
          priority: t.priority,
          agentId: t.agentId,
          agentName: t.agentId ? agentMap.get(t.agentId)?.name || null : null,
          parentTaskId: t.parentTaskId,
          output: t.output?.slice(0, 200) || null,
          error: t.error,
          outputValid: t.outputValid,
          createdAt: t.createdAt?.toISOString?.() || String(t.createdAt),
        })),
        edges: deps.map((d) => ({
          from: d.dependsOnTaskId,
          to: d.taskId,
        })),
      };
    }),

  /* ═══════════════════════════════════════════
     组织架构
     ═══════════════════════════════════════════ */

  /**
   * 组织架构树
   */
  orgTree: publicQuery.query(async () => {
    const db = getDb();

    const orgRows = await db.select().from(organizations);
    const deptRows = await db.select().from(departments);
    const agentRows = await db
      .select({
        id: agents.id,
        agentId: agents.agentId,
        name: agents.name,
        role: agents.role,
        status: agents.status,
        reportsTo: agents.reportsTo,
        departmentId: agents.departmentId,
        orgId: agents.orgId,
        model: agents.model,
      })
      .from(agents);

    return {
      organizations: orgRows.map((org) => ({
        id: org.id,
        name: org.name,
        description: org.description,
        departments: deptRows
          .filter((d) => d.orgId === org.id)
          .map((dept) => ({
            id: dept.id,
            name: dept.name,
            description: dept.description,
            leadAgentId: dept.leadAgentId,
            agents: agentRows
              .filter((a) => a.departmentId === dept.id || a.orgId === org.id)
              .map((a) => ({
                id: a.id,
                agentId: a.agentId,
                name: a.name,
                role: a.role,
                status: a.status,
                reportsTo: a.reportsTo,
                model: a.model,
              })),
          })),
      })),
      // 扁平化 Agent 层级（谁向谁汇报）
      hierarchy: buildAgentHierarchy(agentRows),
    };
  }),

  /* ═══════════════════════════════════════════
     任务计划生成器
     ═══════════════════════════════════════════ */

  /**
   * 生成任务计划
   * 输入一个需求描述，输出拆解后的子任务列表
   */
  generatePlan: publicQuery
    .input(
      z.object({
        title: z.string().min(1).max(255),
        description: z.string().min(1),
        availableAgentIds: z.array(z.number()).optional(),
      })
    )
    .query(async ({ input }) => {
      const db = getDb();

      // 获取可用 Agent
      let availableAgents;
      if (input.availableAgentIds && input.availableAgentIds.length > 0) {
        availableAgents = await db
          .select({ id: agents.id, name: agents.name, role: agents.role, capabilities: agents.capabilities, model: agents.model })
          .from(agents)
          .where(inArray(agents.id, input.availableAgentIds));
      } else {
        availableAgents = await db
          .select({ id: agents.id, name: agents.name, role: agents.role, capabilities: agents.capabilities, model: agents.model })
          .from(agents)
          .where(eq(agents.status, "online"));
      }

      // 根据需求描述生成任务计划
      // 这里返回一个结构化计划，前端可以展示并让用户确认
      const plan = {
        title: input.title,
        description: input.description,
        estimatedSubtasks: estimateSubtasks(input.title, input.description),
        availableAgents: availableAgents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          capabilities: a.capabilities,
          model: a.model,
        })),
      };

      return plan;
    }),
});

/* ═══════════════════════════════════════════
   辅助函数
   ═══════════════════════════════════════════ */

function buildAgentHierarchy(
  agentRows: Array<{ id: number; name: string; role: string | null; reportsTo: number | null; status: string }>
) {
  const tree: Array<{
    id: number;
    name: string;
    role: string | null;
    status: string;
    reportsTo: number | null;
    children: any[];
  }> = [];

  const agentMap = new Map(agentRows.map((a) => [a.id, { ...a, children: [] as any[] }]));

  for (const agent of agentMap.values()) {
    if (agent.reportsTo && agentMap.has(agent.reportsTo)) {
      agentMap.get(agent.reportsTo)!.children.push(agent);
    } else {
      tree.push(agent);
    }
  }

  return tree;
}

function estimateSubtasks(title: string, description: string): Array<{
  name: string;
  description: string;
  estimatedEffort: string;
  suggestedRole: string;
}> {
  const tasks: Array<{
    name: string;
    description: string;
    estimatedEffort: string;
    suggestedRole: string;
  }> = [];

  const lower = (title + " " + description).toLowerCase();

  // 根据关键词估算子任务
  if (lower.includes("代码") || lower.includes("开发") || lower.includes("实现") || lower.includes("功能")) {
    tasks.push({
      name: "代码实现",
      description: "根据需求实现核心功能代码",
      estimatedEffort: "中",
      suggestedRole: "Code Master",
    });
    tasks.push({
      name: "代码审查",
      description: "审查代码质量、安全性、性能",
      estimatedEffort: "低",
      suggestedRole: "CTO",
    });
  }

  if (lower.includes("部署") || lower.includes("发布") || lower.includes("上线")) {
    tasks.push({
      name: "部署配置",
      description: "配置部署环境、CI/CD、域名等",
      estimatedEffort: "中",
      suggestedRole: "Security & Deployment Engineer",
    });
  }

  if (lower.includes("设计") || lower.includes("UI") || lower.includes("界面") || lower.includes("视觉")) {
    tasks.push({
      name: "视觉设计",
      description: "设计 UI 界面、视觉方案",
      estimatedEffort: "中",
      suggestedRole: "Visual Designer",
    });
  }

  if (lower.includes("文档") || lower.includes("文案") || lower.includes("公告") || lower.includes("宣传")) {
    tasks.push({
      name: "文档/文案编写",
      description: "编写文档、公告或宣传文案",
      estimatedEffort: "低",
      suggestedRole: "Content Operations Lead",
    });
  }

  if (lower.includes("测试") || lower.includes("验收") || lower.includes("QA")) {
    tasks.push({
      name: "测试验收",
      description: "功能测试、集成测试、验收",
      estimatedEffort: "中",
      suggestedRole: "Code Master",
    });
  }

  if (lower.includes("图片") || lower.includes("生成") || lower.includes("漫剧") || lower.includes("创意")) {
    tasks.push({
      name: "创意生产",
      description: "图片生成、漫剧制作等创意任务",
      estimatedEffort: "中",
      suggestedRole: "Creative Director",
    });
  }

  if (lower.includes("金融") || lower.includes("理财") || lower.includes("预算") || lower.includes("财务")) {
    tasks.push({
      name: "财务分析",
      description: "财务分析、预算评估",
      estimatedEffort: "低",
      suggestedRole: "Finance & Legal Lead",
    });
  }

  // 如果没匹配到任何关键词，加一个通用任务
  if (tasks.length === 0) {
    tasks.push({
      name: "需求分析",
      description: "分析需求并制定执行方案",
      estimatedEffort: "低",
      suggestedRole: "CEO",
    });
    tasks.push({
      name: "执行",
      description: "执行具体任务",
      estimatedEffort: "中",
      suggestedRole: "Code Master",
    });
  }

  return tasks;
}
