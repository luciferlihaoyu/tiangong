/**
 * 天宫 MCP Server 核心 — Tools + Resources
 * Task 2: MCP Server core with tools and resources
 *
 * 暴露给外部 Agent 系统（OpenClaw、Dify、Claude、GPT 等）
 * 通过标准 MCP 协议接入天宫平台
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../queries/connection";
import { agents, tasks, messages, organizations, departments, taskDependencies } from "@db/schema";
import { eq, and, desc, inArray, sql } from "drizzle-orm";

// ─── Helpers (same as orchestration-router) ───

const validTaskStatuses = ["pending", "queued", "running", "done", "failed"] as const;
type TaskStatus = (typeof validTaskStatuses)[number];

const statusTransitions: Record<string, string[]> = {
  pending: ["queued", "running", "failed"],
  queued: ["running", "failed"],
  running: ["done", "failed"],
  done: [],
  failed: ["queued"],
};

async function triggerDownstream(completedTaskId: number) {
  const db = getDb();
  const downstream = await db
    .select({ taskId: taskDependencies.taskId })
    .from(taskDependencies)
    .where(eq(taskDependencies.dependsOnTaskId, completedTaskId));

  for (const d of downstream) {
    // Check all deps completed
    const deps = await db
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, d.taskId));
    const depIds = deps.map(dd => dd.dependsOnTaskId);
    const depTasks = await db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, depIds));
    const allDone = depTasks.every(t => t.status === "done");

    if (allDone) {
      const t = await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, d.taskId))
        .then(r => r[0]);
      if (t && t.status === "pending") {
        await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, d.taskId));
      }
    }
  }
}

// ─── Server instance ───

let _server: McpServer | null = null;

export function getMcpServer(): McpServer {
  if (_server) return _server;

  const server = new McpServer({
    name: "Tiangong",
    version: "2.0.0",
  });

  // ═══════════════════════════════════════════
  // TOOLS
  // ═══════════════════════════════════════════

  // Tool 1: 创建任务
  server.tool(
    "create_task",
    "[天宫] 创建新任务，支持依赖其他任务",
    {
      name: z.string().describe("任务名称"),
      agentId: z.number().optional().describe("分配给的 Agent ID"),
      description: z.string().optional().describe("任务描述"),
      priority: z.number().min(0).max(100).optional().default(0).describe("优先级 0-100"),
      dependencies: z.array(z.number()).optional().describe("依赖的任务 ID 列表"),
      input: z.string().optional().describe("输入数据 (JSON 字符串)"),
      maxRetries: z.number().min(0).max(10).optional().default(3).describe("最大重试次数"),
      timeoutMs: z.number().min(1000).max(3600000).optional().default(300000).describe("超时毫秒"),
    },
    async (params) => {
      const db = getDb();
      const taskId = `T-${Date.now().toString(36).toUpperCase()}`;

      await db.insert(tasks).values({
        taskId,
        name: params.name,
        agentId: params.agentId ?? null,
        description: params.description ?? null,
        priority: params.priority ?? 0,
        input: params.input ?? null,
        maxRetries: params.maxRetries ?? 3,
        timeoutMs: params.timeoutMs ?? 300000,
      });

      const created = await db
        .select()
        .from(tasks)
        .where(eq(tasks.taskId, taskId))
        .then(r => r[0]);

      if (created && params.dependencies && params.dependencies.length > 0) {
        for (const depId of params.dependencies) {
          await db
            .insert(taskDependencies)
            .values({ taskId: created.id, dependsOnTaskId: depId });
        }
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: true,
                task: {
                  id: created?.id,
                  taskId: created?.taskId,
                  name: created?.name,
                  status: created?.status,
                  priority: created?.priority,
                  dependencies: params.dependencies ?? [],
                },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // Tool 2: 更新任务状态
  server.tool(
    "update_task_status",
    "[天宫] 更新任务状态（带状态机检查，完成时自动触发下游任务）",
    {
      taskId: z.number().describe("任务 ID（数字）"),
      status: z
        .enum(["pending", "queued", "running", "done", "failed"])
        .describe("新状态"),
      output: z.string().optional().describe("输出数据 (JSON 字符串)"),
      error: z.string().optional().describe("错误信息"),
      progress: z.number().min(0).max(100).optional().describe("进度 0-100"),
    },
    async (params) => {
      const db = getDb();
      const task = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, params.taskId))
        .then(r => r[0]);

      if (!task) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "任务不存在" }) }],
        };
      }

      // State machine validation
      const allowed = statusTransitions[task.status] || [];
      if (!allowed.includes(params.status)) {
        // Auto-retry: failed → queued
        if (task.status === "failed" && params.status === "queued") {
          const retryCount = task.retryCount ?? 0;
          const maxRetries = task.maxRetries ?? 3;
          if (retryCount >= maxRetries) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    success: false,
                    error: `已达最大重试次数 (${maxRetries})`,
                  }),
                },
              ],
            };
          }
          await db
            .update(tasks)
            .set({ status: "queued", retryCount: retryCount + 1, error: null })
            .where(eq(tasks.id, params.taskId));
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: true,
                  status: "queued",
                  retryCount: retryCount + 1,
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: `状态转移无效: ${task.status} → ${params.status}`,
              }),
            },
          ],
        };
      }

      const updates: Record<string, unknown> = { status: params.status };
      if (params.progress !== undefined) updates.progress = params.progress;
      if (params.output !== undefined) updates.output = params.output;
      if (params.error !== undefined) updates.error = params.error;

      await db.update(tasks).set(updates).where(eq(tasks.id, params.taskId));

      // Auto-trigger downstream
      if (params.status === "done") {
        await triggerDownstream(params.taskId);
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, status: params.status }),
          },
        ],
      };
    }
  );

  // Tool 3: 发送消息
  server.tool(
    "send_message",
    "[天宫] 向其他 Agent 发送消息",
    {
      fromAgentId: z.number().describe("发送方 Agent ID"),
      toAgentId: z.number().describe("目标 Agent ID"),
      content: z.string().min(1).max(5000).describe("消息内容"),
      type: z
        .enum(["command", "response", "broadcast", "system"])
        .optional()
        .default("command")
        .describe("消息类型"),
    },
    async (params) => {
      const db = getDb();

      // Verify agents exist
      const fromAgent = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, params.fromAgentId))
        .then(r => r[0]);

      const toAgent = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, params.toAgentId))
        .then(r => r[0]);

      if (!fromAgent || !toAgent) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "发送方或目标 Agent 不存在",
              }),
            },
          ],
        };
      }

      await db.insert(messages).values({
        fromAgent: params.fromAgentId,
        toAgent: params.toAgentId,
        content: params.content,
        type: params.type ?? "command",
      });

      await db
        .update(agents)
        .set({ messagesCount: sql`${agents.messagesCount} + 1` })
        .where(eq(agents.id, params.fromAgentId));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              from: fromAgent.name,
              to: toAgent.name,
              type: params.type,
            }),
          },
        ],
      };
    }
  );

  // Tool 4: 更新 Agent 状态
  server.tool(
    "update_agent_status",
    "[天宫] 更新 Agent 在线状态和当前任务",
    {
      agentId: z.number().describe("Agent ID"),
      status: z.enum(["online", "busy", "idle"]).optional().describe("在线状态"),
      currentTask: z.string().optional().describe("当前正在执行的任务描述"),
      progress: z.number().min(0).max(100).optional().describe("当前任务进度 0-100"),
    },
    async (params) => {
      const db = getDb();
      const agent = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, params.agentId))
        .then(r => r[0]);

      if (!agent) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: false, error: "Agent 不存在" }),
            },
          ],
        };
      }

      const updates: Record<string, unknown> = {};
      if (params.status) updates.status = params.status;
      if (params.currentTask !== undefined) updates.currentTask = params.currentTask;
      if (params.progress !== undefined) updates.progress = params.progress;

      if (Object.keys(updates).length > 0) {
        await db
          .update(agents)
          .set(updates)
          .where(eq(agents.id, params.agentId));
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, agentId: params.agentId, ...updates }),
          },
        ],
      };
    }
  );

  // Tool 5: 心跳上报
  server.tool(
    "heartbeat",
    "[天宫] Agent 心跳上报",
    {
      agentId: z.number().describe("Agent ID"),
      status: z.enum(["online", "busy", "idle"]).describe("当前状态"),
      currentTask: z.string().optional().describe("当前任务"),
      progress: z.number().min(0).max(100).optional().describe("当前任务进度"),
    },
    async (params) => {
      const db = getDb();

      const updates: Record<string, unknown> = {
        status: params.status,
        lastHeartbeat: new Date(),
      };
      if (params.currentTask !== undefined) updates.currentTask = params.currentTask;
      if (params.progress !== undefined) updates.progress = params.progress;

      await db
        .update(agents)
        .set(updates)
        .where(eq(agents.id, params.agentId));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              agentId: params.agentId,
              status: params.status,
              heartbeat: new Date().toISOString(),
            }),
          },
        ],
      };
    }
  );

  // Tool 6: 列出 Agent
  server.tool(
    "list_agents",
    "[天宫] 列出所有 Agent 及其状态",
    {
      status: z.enum(["online", "busy", "idle"]).optional().describe("按状态过滤"),
      source: z.string().optional().describe("按来源过滤"),
    },
    async (params) => {
      const db = getDb();
      let query = db.select().from(agents).orderBy(agents.updatedAt);
      const result = await query;

      let filtered = result;
      if (params.status) filtered = filtered.filter(a => a.status === params.status);
      if (params.source) filtered = filtered.filter(a => a.source?.includes(params.source!));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(filtered.map(a => ({
              id: a.id,
              agentId: a.agentId,
              name: a.name,
              status: a.status,
              role: a.role,
              source: a.source,
              model: a.model,
              currentTask: a.currentTask,
              progress: a.progress,
              lastHeartbeat: a.lastHeartbeat,
            })), null, 2),
          },
        ],
      };
    }
  );

  // Tool 7: 列出任务
  server.tool(
    "list_tasks",
    "[天宫] 列出所有任务",
    {
      status: z
        .enum(["pending", "queued", "running", "done", "failed"])
        .optional()
        .describe("按状态过滤"),
      agentId: z.number().optional().describe("按 Agent ID 过滤"),
      limit: z.number().min(1).max(100).optional().default(50).describe("返回数量"),
    },
    async (params) => {
      const db = getDb();

      let query = db
        .select()
        .from(tasks)
        .orderBy(desc(tasks.createdAt));

      if (params.limit) {
        const allTasks = await query;
        let filtered = allTasks;
        if (params.status) filtered = filtered.filter(t => t.status === params.status);
        if (params.agentId) filtered = filtered.filter(t => t.agentId === params.agentId);
        filtered = filtered.slice(0, params.limit);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(filtered, null, 2),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(await query, null, 2),
          },
        ],
      };
    }
  );

  // Tool 8: 列出消息
  server.tool(
    "list_messages",
    "[天宫] 列出 Agent 消息",
    {
      agentId: z.number().describe("Agent ID（查该 Agent 收发的消息）"),
      limit: z.number().min(1).max(200).optional().default(50).describe("返回数量"),
    },
    async (params) => {
      const db = getDb();
      const result = await db
        .select()
        .from(messages)
        .where(
          sql`${messages.fromAgent} = ${params.agentId} OR ${messages.toAgent} = ${params.agentId}`
        )
        .orderBy(desc(messages.createdAt))
        .then(rows => rows.slice(0, params.limit || 50));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ═══════════════════════════════════════════
  // RESOURCES
  // ═══════════════════════════════════════════

  // Resource 1: All agents
  server.resource("agents", "tiangong://agents", async () => {
    const db = getDb();
    const allAgents = await db.select().from(agents).orderBy(agents.updatedAt);

    return {
      contents: [
        {
          uri: "tiangong://agents",
          mimeType: "application/json",
          text: JSON.stringify(
            allAgents.map(a => ({
              id: a.id,
              agentId: a.agentId,
              name: a.name,
              system: a.system,
              status: a.status,
              role: a.role,
              source: a.source,
              model: a.model,
              currentTask: a.currentTask,
              progress: a.progress,
              capabilities: a.capabilities,
              lastHeartbeat: a.lastHeartbeat,
              messagesCount: a.messagesCount,
              budgetCents: a.budgetCents,
              spentCents: a.spentCents,
            })),
            null,
            2
          ),
        },
      ],
    };
  });

  // Resource 2: All tasks
  server.resource("tasks", "tiangong://tasks", async () => {
    const db = getDb();
    const allTasks = await db.select().from(tasks).orderBy(desc(tasks.createdAt));

    return {
      contents: [
        {
          uri: "tiangong://tasks",
          mimeType: "application/json",
          text: JSON.stringify(allTasks, null, 2),
        },
      ],
    };
  });

  // Resource 3: Organization tree
  server.resource("organization", "tiangong://organization", async () => {
    const db = getDb();
    const orgs = await db.select().from(organizations);
    const depts = await db.select().from(departments);
    const allAgents = await db.select().from(agents);

    const tree = orgs.map(org => ({
      ...org,
      departments: depts
        .filter(d => d.orgId === org.id)
        .map(d => ({
          ...d,
          agents: allAgents.filter(a => a.departmentId === d.id).map(a => ({
            id: a.id,
            agentId: a.agentId,
            name: a.name,
            role: a.role,
            status: a.status,
          })),
        })),
    }));

    return {
      contents: [
        {
          uri: "tiangong://organization",
          mimeType: "application/json",
          text: JSON.stringify(tree, null, 2),
        },
      ],
    };
  });

  // Resource 4: Agent detail (dynamic template)
  server.resource(
    "agent-detail",
    new ResourceTemplate("tiangong://agents/{agentId}", { list: undefined }),
    async (uri, { agentId }) => {
      const db = getDb();
      const id = parseInt(agentId as string, 10);
      if (isNaN(id)) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "Invalid agent ID" }),
            },
          ],
        };
      }

      const agent = await db
        .select()
        .from(agents)
        .where(eq(agents.id, id))
        .then(r => r[0]);

      if (!agent) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "Agent not found" }),
            },
          ],
        };
      }

      // Get agent's tasks
      const agentTasks = await db
        .select()
        .from(tasks)
        .where(eq(tasks.agentId, id))
        .orderBy(desc(tasks.createdAt));

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ...agent, tasks: agentTasks }, null, 2),
          },
        ],
      };
    }
  );

  // Resource 5: Task DAG view
  server.resource("task-dag", "tiangong://tasks/dag", async () => {
    const db = getDb();
    const allTasks = await db.select().from(tasks);
    const allDeps = await db.select().from(taskDependencies);

    // Topological sort
    const nodes = new Set<number>();
    for (const d of allDeps) {
      nodes.add(d.taskId);
      nodes.add(d.dependsOnTaskId);
    }
    for (const t of allTasks) nodes.add(t.id);

    const adj = new Map<number, number[]>();
    const inDeg = new Map<number, number>();
    for (const n of nodes) {
      adj.set(n, []);
      inDeg.set(n, 0);
    }

    for (const d of allDeps) {
      adj.get(d.taskId)!.push(d.dependsOnTaskId);
      inDeg.set(d.dependsOnTaskId, (inDeg.get(d.dependsOnTaskId) || 0) + 1);
    }

    const queue: number[] = [];
    for (const [n, deg] of inDeg) {
      if (deg === 0) queue.push(n);
    }

    const sorted: number[] = [];
    while (queue.length > 0) {
      const u = queue.shift()!;
      sorted.push(u);
      for (const v of adj.get(u) || []) {
        inDeg.set(v, inDeg.get(v)! - 1);
        if (inDeg.get(v) === 0) queue.push(v);
      }
    }

    const taskMap = new Map(allTasks.map(t => [t.id, t]));

    return {
      contents: [
        {
          uri: "tiangong://tasks/dag",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              tasks: allTasks,
              dependencies: allDeps.map(d => ({
                taskId: d.taskId,
                taskName: taskMap.get(d.taskId)?.name ?? "unknown",
                dependsOnTaskId: d.dependsOnTaskId,
                dependsOnName: taskMap.get(d.dependsOnTaskId)?.name ?? "unknown",
              })),
              sortedIds: sorted,
              topologicalOrder: sorted.map(id => taskMap.get(id)?.name ?? "unknown"),
            },
            null,
            2
          ),
        },
      ],
    };
  });

  // Resource 6: Agent hierarchy
  server.resource("agent-hierarchy", "tiangong://agents/hierarchy", async () => {
    const db = getDb();
    const allAgents = await db.select().from(agents);

    const byId = new Map(allAgents.map(a => [a.id, a]));
    const children = new Map<number, typeof allAgents>();

    for (const a of allAgents) {
      if (a.reportsTo && byId.has(a.reportsTo)) {
        const list = children.get(a.reportsTo) || [];
        list.push(a);
        children.set(a.reportsTo, list);
      }
    }

    const roots = allAgents
      .filter(a => !a.reportsTo || !byId.has(a.reportsTo))
      .map(a => ({
        id: a.id,
        agentId: a.agentId,
        name: a.name,
        role: a.role,
        status: a.status,
      }));

    return {
      contents: [
        {
          uri: "tiangong://agents/hierarchy",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              roots,
              children: Object.fromEntries(
                Array.from(children.entries()).map(([parentId, subs]) => [
                  parentId,
                  subs.map(s => ({
                    id: s.id,
                    agentId: s.agentId,
                    name: s.name,
                    role: s.role,
                    status: s.status,
                  })),
                ])
              ),
            },
            null,
            2
          ),
        },
      ],
    };
  });

  _server = server;
  return server;
}
