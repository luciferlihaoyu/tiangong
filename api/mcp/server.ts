/**
 * 天宫 MCP Server 核心 — Tools + Resources
 * Task 2: MCP Server core with tools and resources
 *
 * 暴露给外部 Agent 系统（OpenClaw、Dify、Claude、GPT 等）
 * 通过标准 MCP 协议接入天宫平台
 *
 * Phase 1 扩展（管理工具面）：
 * - 只读 ops/usage/events/guard 查询：任何有效 MCP Key 可用
 * - 受控写操作（cancel_task）：任何有效 MCP Key 可用（不扩大既有权限）
 * - 管理写操作（预算/guard 白名单/授权）：需要 Key 的 permissions 含 "admin"；
 *   白名单与授权禁止 MCP Key 为其绑定的 Agent 自我授权
 *
 * Phase 2 扩展（执行面 + 知识面，任务 2.1/2.2 —— dsh 执行循环内可回调天宫）：
 * - 执行面：claim_task / report_progress / submit_artifact —— 业务核心走共享 lib
 *   （api/lib/task-claim.ts、api/lib/task-writeback.ts），与 tRPC 面同一事实源，
 *   防止 MCP 工具面与 tRPC 面漂移
 * - 知识面：read_alist（路径约束在配置 basePath 内防穿越）/ search_xuanji ——
 *   与只读 ops 工具同权限级别（任何有效 Key 可用）
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import {
  agents,
  tasks,
  messages,
  organizations,
  departments,
  taskDependencies,
  tokenUsage,
  modelAllowlist,
  highCostModelAuth,
  auditEvents,
  taskMessages,
  taskArtifacts,
  type InsertHighCostModelAuth,
  type InsertModelAllowlist,
} from "@db/schema";
import { eq, and, desc, inArray, gte, sql } from "drizzle-orm";
import { HIGH_COST_THRESHOLD_CENTS, KNOWN_HIGH_COST_MODELS } from "../guard-router";
import { claimNextTask } from "../lib/task-claim";
import { reportTaskProgress, UpdateProgressInputSchema } from "../lib/task-writeback";
import { assertTaskWriteAuthorized, isTaskArtifactInsertable } from "../lib/task-authz";
import { createTraceId } from "../lib/task-metadata";
import { resolveAlistConfig, alistList, alistDownloadUrl } from "../connectors/alist";
import { createXuanjiClient } from "../connectors/xuanji/service";
import { SearchContextRequestSchema } from "../connectors/xuanji/types";
import { XuanjiConnectorError } from "../connectors/xuanji/client";
import { TraceIdSchema } from "../contracts/platform";

// ─── Caller context (Key 身份 + 权限，由 transport 注入) ───

export interface McpToolContext {
  /** mcp_api_keys.id；env-only Key 为 0 */
  apiKeyId: number;
  /** Key 绑定的 Agent ID；env-only Key 为 null */
  agentId: number | null;
  /** 解析后的权限 token 列表 */
  permissions: readonly string[];
}

const EMPTY_CONTEXT: McpToolContext = { apiKeyId: 0, agentId: null, permissions: [] };

/**
 * 解析 mcp_api_keys.permissions 字段。
 * 约定：JSON 数组（createKey 文档约定），兼容逗号/空白分隔的字符串。
 * 特殊 token："admin" 或 "*" 授予管理写工具。
 */
export function parsePermissions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((p): p is string => typeof p === "string")
          .map((p) => p.trim())
          .filter(Boolean);
      }
    } catch {
      // 非法 JSON：回落到分隔符解析
    }
  }
  return trimmed
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function hasAdminPermission(ctx: McpToolContext): boolean {
  return ctx.permissions.includes("admin") || ctx.permissions.includes("*");
}

// ─── Response helpers ───

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function failResult(error: string) {
  return textResult({ success: false, error });
}

/**
 * Phase 2 执行面/知识面的失败结果：显式置 isError=true，
 * 让调用方（dsh 执行循环）能机器判别失败并走重试/上报分支，
 * 而不是把 { success:false } 当成正常载荷继续执行。
 */
function errorResult(error: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error }, null, 2) }],
    isError: true as const,
  };
}

function adminDeniedResult() {
  return failResult(
    "此 MCP Key 缺少 admin 权限。请管理员在 MCP 面板为该 Key 的 permissions 字段添加 \"admin\"（mcp.updateKey）。"
  );
}

// ─── AList 路径安全（read_alist，任务 2.2） ───

/** 视为"文本文件"的扩展名（仅为这类文件附带下载链接，避免对大目录逐文件探测） */
const ALIST_TEXTUAL_EXTENSIONS = new Set([
  "md", "mdx", "txt", "json", "csv", "log", "html", "htm", "xml",
  "yaml", "yml", "toml", "ini", "conf", "env", "ts", "tsx", "js",
  "jsx", "py", "go", "rs", "java", "sh", "sql",
]);

/** 单次调用最多为多少个文本文件解析下载链接（防止大目录打爆 AList /api/fs/get） */
const ALIST_MAX_DOWNLOAD_LOOKUPS = 20;

function isTextualFileName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return ALIST_TEXTUAL_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * 把调用方的相对路径重定基到配置的 basePath 下，并确保结果仍在 basePath 内。
 *
 * 规则（任务 2.2 路径安全）：
 *   - 任何 ".." 段直接拒绝（"../x"、"a/../../b"、"../../etc" 均被拦下）；
 *   - 入参不以 AList 绝对路径解释，而是统一拼接到 basePath 之后
 *     （requestPath = basePath === "/" ? path : basePath + path）；
 *   - 最终防线：拼接结果必须等于 basePath 或以 basePath + "/" 开头，否则拒绝
 *     （防任何形式的越出 basePath 的绝对/相对逃逸）。
 *
 * 返回 null 表示路径非法。
 */
function resolveAlistRequestPath(basePath: string, rawPath: string): string | null {
  const segments = rawPath.split("/").filter((s) => s.length > 0);
  if (segments.some((s) => s === "..")) return null;
  const base = basePath === "/" ? "" : basePath.replace(/\/+$/, "");
  const suffix = segments.length === 0 ? "" : `/${segments.join("/")}`;
  const requestPath = `${base}${suffix}` || "/";
  if (base === "") {
    return requestPath.startsWith("/") ? requestPath : null;
  }
  if (requestPath !== base && !requestPath.startsWith(`${base}/`)) return null;
  return requestPath;
}

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

// ─── Server factory (new instance per session for stateless MCP HTTP) ───

export function getMcpServer(ctx: McpToolContext = EMPTY_CONTEXT): McpServer {
  const requireAdmin = (): ReturnType<typeof adminDeniedResult> | null =>
    hasAdminPermission(ctx) ? null : adminDeniedResult();
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
      const query = db.select().from(agents).orderBy(agents.updatedAt);
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

      const query = db
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
  // TOOLS — Phase 1 扩展：Ops / Usage / Events / Guard 只读查询
  // ═══════════════════════════════════════════

  // Tool 9: Ops — Agent 在线状态总览
  server.tool(
    "ops_agent_status",
    "[天宫] Ops 查询：所有 Agent 在线状态总览（含心跳检测、预算使用率）",
    {},
    async () => {
      const db = getDb();
      const rows = await db
        .select({
          id: agents.id,
          agentId: agents.agentId,
          name: agents.name,
          status: agents.status,
          model: agents.model,
          currentTask: agents.currentTask,
          lastHeartbeat: agents.lastHeartbeat,
          spentCents: agents.spentCents,
          budgetCents: agents.budgetCents,
        })
        .from(agents);

      const now = Date.now();
      const heartbeatTimeoutMs = 300_000;
      const result = rows.map((a) => ({
        ...a,
        heartbeatOk: a.lastHeartbeat
          ? now - new Date(a.lastHeartbeat).getTime() < heartbeatTimeoutMs
          : false,
        budgetUsed:
          a.budgetCents && a.budgetCents > 0
            ? ((a.spentCents ?? 0) / a.budgetCents) * 100
            : 0,
      }));

      return textResult({ success: true, agents: result });
    }
  );

  // Tool 10: Ops — 任务流统计
  server.tool(
    "ops_task_stats",
    "[天宫] Ops 查询：任务流状态统计（各状态数量）",
    {},
    async () => {
      const db = getDb();
      const rows = await db.select({ status: tasks.status }).from(tasks);
      const stats: Record<string, number> = { queued: 0, pending: 0, running: 0, done: 0, failed: 0 };
      for (const r of rows) {
        if (r.status in stats) stats[r.status] += 1;
      }
      return textResult({ success: true, stats, total: rows.length });
    }
  );

  // Tool 11: Ops — 最近任务
  server.tool(
    "ops_recent_tasks",
    "[天宫] Ops 查询：最近任务列表",
    {
      limit: z.number().int().min(1).max(50).optional().default(10).describe("返回数量"),
    },
    async (params) => {
      const db = getDb();
      const rows = await db
        .select({
          id: tasks.id,
          taskId: tasks.taskId,
          name: tasks.name,
          status: tasks.status,
          priority: tasks.priority,
          agentId: tasks.agentId,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
        })
        .from(tasks);
      const sorted = rows
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, params.limit ?? 10);
      return textResult({ success: true, tasks: sorted });
    }
  );

  // Tool 12: Ops — 今日概览
  server.tool(
    "ops_today_overview",
    "[天宫] Ops 查询：今日概览（Agent 状态 / 今日任务 / 今日用量）",
    {},
    async () => {
      const db = getDb();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const agentRows = await db.select({ status: agents.status }).from(agents);
      const agentStats: Record<string, number> = { online: 0, busy: 0, idle: 0 };
      for (const r of agentRows) {
        if (r.status in agentStats) agentStats[r.status] += 1;
      }

      const taskRows = await db
        .select({ status: tasks.status, createdAt: tasks.createdAt })
        .from(tasks);
      const todaysTasks = taskRows.filter((t) => new Date(t.createdAt) >= today);
      const taskStats: Record<string, number> = { queued: 0, pending: 0, running: 0, done: 0, failed: 0 };
      for (const t of todaysTasks) {
        if (t.status in taskStats) taskStats[t.status] += 1;
      }

      const usageRows = await db
        .select({
          totalTokens: tokenUsage.totalTokens,
          costCents: tokenUsage.costCents,
          callCount: tokenUsage.callCount,
          highCostModel: tokenUsage.highCostModel,
          createdAt: tokenUsage.createdAt,
        })
        .from(tokenUsage)
        .where(gte(tokenUsage.createdAt, today));
      const usage = { totalTokens: 0, costCents: 0, callCount: 0, highCostCount: 0 };
      for (const u of usageRows) {
        usage.totalTokens += u.totalTokens ?? 0;
        usage.costCents += u.costCents ?? 0;
        usage.callCount += u.callCount ?? 0;
        if (u.highCostModel === "true") usage.highCostCount += u.callCount ?? 0;
      }

      return textResult({ success: true, agents: agentStats, tasks: taskStats, usage });
    }
  );

  // Tool 13: Usage — 最近模型调用
  server.tool(
    "usage_recent",
    "[天宫] 用量查询：最近模型调用记录（支持 Agent/模型/高价过滤）",
    {
      agentId: z.number().optional().describe("按 Agent ID 过滤"),
      model: z.string().max(100).optional().describe("按模型名过滤"),
      highCostOnly: z.boolean().optional().describe("只返回高价模型调用"),
      limit: z.number().int().min(1).max(100).optional().default(20).describe("返回数量"),
    },
    async (params) => {
      const db = getDb();
      const rows = await db
        .select({
          id: tokenUsage.id,
          model: tokenUsage.model,
          provider: tokenUsage.provider,
          totalTokens: tokenUsage.totalTokens,
          costCents: tokenUsage.costCents,
          highCostModel: tokenUsage.highCostModel,
          source: tokenUsage.source,
          sessionKey: tokenUsage.sessionKey,
          traceId: tokenUsage.traceId,
          agentId: tokenUsage.agentId,
          createdAt: tokenUsage.createdAt,
        })
        .from(tokenUsage);

      let filtered = rows;
      if (params.agentId !== undefined) filtered = filtered.filter((r) => r.agentId === params.agentId);
      if (params.model) filtered = filtered.filter((r) => r.model === params.model);
      if (params.highCostOnly) filtered = filtered.filter((r) => r.highCostModel === "true");
      filtered = filtered
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, params.limit ?? 20);

      return textResult({ success: true, calls: filtered });
    }
  );

  // Tool 14: Usage — 成本摘要
  server.tool(
    "usage_cost_summary",
    "[天宫] 用量查询：最近 N 天成本摘要（按模型聚合）",
    {
      days: z.number().int().min(1).max(90).optional().default(7).describe("回溯天数 1-90"),
    },
    async (params) => {
      const db = getDb();
      const days = params.days ?? 7;
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await db
        .select({
          model: tokenUsage.model,
          totalTokens: tokenUsage.totalTokens,
          callCount: tokenUsage.callCount,
          costCents: tokenUsage.costCents,
        })
        .from(tokenUsage)
        .where(gte(tokenUsage.createdAt, since));

      const byModel: Record<string, { totalTokens: number; callCount: number; costCents: number }> = {};
      for (const r of rows) {
        const entry = byModel[r.model] ?? { totalTokens: 0, callCount: 0, costCents: 0 };
        entry.totalTokens += r.totalTokens ?? 0;
        entry.callCount += r.callCount ?? 0;
        entry.costCents += r.costCents ?? 0;
        byModel[r.model] = entry;
      }

      return textResult({
        success: true,
        days,
        models: byModel,
        totals: {
          totalTokens: rows.reduce((s, r) => s + (r.totalTokens ?? 0), 0),
          callCount: rows.reduce((s, r) => s + (r.callCount ?? 0), 0),
          costCents: rows.reduce((s, r) => s + (r.costCents ?? 0), 0),
        },
      });
    }
  );

  // Tool 15: Events — 统一事件流
  server.tool(
    "list_recent_events",
    "[天宫] 事件流查询：最近审计 / 任务线程 / 模型用量事件（合并按时间倒序）",
    {
      kind: z.enum(["audit", "task", "usage"]).optional().describe("按事件来源过滤"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("返回数量（合并后）"),
    },
    async (params) => {
      const db = getDb();
      const limit = params.limit ?? 20;
      const items: Array<Record<string, unknown>> = [];

      if (!params.kind || params.kind === "audit") {
        const rows = await db
          .select({
            id: auditEvents.id,
            entityType: auditEvents.entityType,
            entityId: auditEvents.entityId,
            event: auditEvents.event,
            actorUserId: auditEvents.actorUserId,
            createdAt: auditEvents.createdAt,
          })
          .from(auditEvents)
          .orderBy(desc(auditEvents.createdAt))
          .limit(limit);
        for (const r of rows) {
          items.push({
            kind: "audit",
            id: `audit:${r.id}`,
            ts: new Date(r.createdAt).toISOString(),
            summary: r.event,
            entityType: r.entityType,
            entityId: r.entityId,
            actorUserId: r.actorUserId,
          });
        }
      }

      if (!params.kind || params.kind === "task") {
        const rows = await db
          .select({
            id: taskMessages.id,
            taskId: taskMessages.taskId,
            eventType: taskMessages.eventType,
            content: taskMessages.content,
            fromAgentId: taskMessages.fromAgentId,
            toAgentId: taskMessages.toAgentId,
            createdAt: taskMessages.createdAt,
          })
          .from(taskMessages)
          .orderBy(desc(taskMessages.createdAt))
          .limit(limit);
        for (const r of rows) {
          items.push({
            kind: "task",
            id: `task:${r.id}`,
            ts: new Date(r.createdAt).toISOString(),
            summary: r.eventType,
            taskId: r.taskId,
            contentPreview: r.content ? r.content.slice(0, 120) : null,
            fromAgentId: r.fromAgentId,
            toAgentId: r.toAgentId,
          });
        }
      }

      if (!params.kind || params.kind === "usage") {
        const rows = await db
          .select({
            id: tokenUsage.id,
            model: tokenUsage.model,
            provider: tokenUsage.provider,
            totalTokens: tokenUsage.totalTokens,
            costCents: tokenUsage.costCents,
            agentId: tokenUsage.agentId,
            taskId: tokenUsage.taskId,
            createdAt: tokenUsage.createdAt,
          })
          .from(tokenUsage)
          .orderBy(desc(tokenUsage.createdAt))
          .limit(limit);
        for (const r of rows) {
          items.push({
            kind: "usage",
            id: `usage:${r.id}`,
            ts: new Date(r.createdAt).toISOString(),
            summary: `${r.model} ${r.totalTokens}t`,
            model: r.model,
            provider: r.provider,
            totalTokens: r.totalTokens,
            costCents: r.costCents,
            agentId: r.agentId,
            taskId: r.taskId,
          });
        }
      }

      items.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
      return textResult({ success: true, events: items.slice(0, limit) });
    }
  );

  // Tool 16: Guard — 状态
  server.tool(
    "guard_status",
    "[天宫] Guard 查询：高价模型白名单、生效中的授权、已知高价模型列表",
    {},
    async () => {
      const db = getDb();
      const allowlist = await db.select().from(modelAllowlist).orderBy(desc(modelAllowlist.createdAt));
      const allAuths = await db.select().from(highCostModelAuth);
      const now = Date.now();
      const activeAuths = allAuths.filter(
        (a) => a.active === "true" && (!a.expiresAt || new Date(a.expiresAt).getTime() >= now)
      );
      return textResult({
        success: true,
        highCostThresholdCents: HIGH_COST_THRESHOLD_CENTS,
        knownHighCostModels: KNOWN_HIGH_COST_MODELS,
        allowlist,
        activeAuths,
      });
    }
  );

  // Tool 17: Guard — 调用前检查
  server.tool(
    "guard_check",
    "[天宫] Guard 查询：检查一次模型调用是否被允许（高价熔断 + 预算前置检查）",
    {
      model: z.string().min(1).max(100).describe("模型名（如 4sapi/gpt-5.5-high）"),
      agentId: z.number().optional().describe("调用方 Agent ID"),
      costCents: z.number().int().min(0).optional().default(0).describe("本次调用费用（美分）"),
    },
    async (params) => {
      const db = getDb();
      const isHighCost =
        (params.costCents ?? 0) >= HIGH_COST_THRESHOLD_CENTS ||
        KNOWN_HIGH_COST_MODELS.includes(params.model);

      if (!isHighCost) {
        return textResult({ success: true, allowed: true, reason: "low_cost_model", highCost: false });
      }

      if (params.agentId !== undefined) {
        const allowlistRows = await db
          .select()
          .from(modelAllowlist)
          .where(and(eq(modelAllowlist.agentId, params.agentId), eq(modelAllowlist.model, params.model)));
        if (allowlistRows.length > 0) {
          return textResult({
            success: true,
            allowed: true,
            reason: "allowlisted",
            highCost: true,
            allowlistReason: allowlistRows[0].reason,
          });
        }

        const authRows = await db
          .select()
          .from(highCostModelAuth)
          .where(
            and(
              eq(highCostModelAuth.agentId, params.agentId),
              eq(highCostModelAuth.model, params.model),
              eq(highCostModelAuth.active, "true")
            )
          );
        const now = Date.now();
        const valid = authRows.find((a) => !a.expiresAt || new Date(a.expiresAt).getTime() >= now);
        if (valid) {
          return textResult({
            success: true,
            allowed: true,
            reason: "authorized",
            highCost: true,
            auth: {
              authorizedBy: valid.authorizedBy,
              reason: valid.reason,
              expiresAt: valid.expiresAt,
            },
          });
        }
      }

      return textResult({
        success: true,
        allowed: false,
        reason: "high_cost_not_authorized",
        highCost: true,
        message: `模型 ${params.model} 是高价模型，未授权使用。请在管理面板添加白名单或授权，或使用具备 admin 权限的 MCP guard 工具。`,
      });
    }
  );

  // ═══════════════════════════════════════════
  // TOOLS — Phase 1 扩展：受控写操作
  // ═══════════════════════════════════════════

  // Tool 18: 取消任务（只终止工作，不产生新能力：等价于既有 update_task_status 置 failed）
  server.tool(
    "cancel_task",
    "[天宫] 取消任务：把未完成任务标记为 failed 并记录取消原因",
    {
      taskId: z.number().describe("任务 ID（数字）"),
      reason: z.string().max(500).optional().describe("取消原因"),
    },
    async (params) => {
      const db = getDb();
      const task = await db
        .select({ id: tasks.id, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, params.taskId))
        .then((r) => r[0]);

      if (!task) return failResult("任务不存在");
      if (task.status === "done" || task.status === "failed") {
        return failResult(`任务已处于终态 ${task.status}，无法取消`);
      }

      const reason = params.reason?.trim() || "通过 MCP 取消";
      await db
        .update(tasks)
        .set({ status: "failed", error: `[cancelled] ${reason}` })
        .where(eq(tasks.id, params.taskId));

      return textResult({ success: true, taskId: params.taskId, status: "failed", reason });
    }
  );

  // Tool 19: 设置 Agent 预算（admin）
  server.tool(
    "set_agent_budget",
    "[天宫] 设置 Agent 预算上限（需要 admin 权限）",
    {
      agentId: z.number().describe("Agent ID"),
      budgetCents: z.number().int().min(0).max(10_000_000).describe("预算上限（美分，0 = 不限制）"),
    },
    async (params) => {
      const denied = requireAdmin();
      if (denied) return denied;

      const db = getDb();
      const agent = await db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(eq(agents.id, params.agentId))
        .then((r) => r[0]);
      if (!agent) return failResult("Agent 不存在");

      await db
        .update(agents)
        .set({ budgetCents: params.budgetCents })
        .where(eq(agents.id, params.agentId));

      return textResult({
        success: true,
        agentId: params.agentId,
        name: agent.name,
        budgetCents: params.budgetCents,
      });
    }
  );

  // Tool 20: Guard — 添加白名单（admin，禁止自我授权）
  server.tool(
    "guard_add_allowlist",
    "[天宫] 为 Agent 添加模型白名单（需要 admin 权限；禁止为 Key 绑定的 Agent 自身添加）",
    {
      agentId: z.number().describe("目标 Agent ID"),
      model: z.string().min(1).max(100).describe("模型名"),
      reason: z.string().max(500).optional().describe("白名单原因"),
    },
    async (params) => {
      const denied = requireAdmin();
      if (denied) return denied;
      if (ctx.agentId !== null && ctx.agentId === params.agentId) {
        return failResult("禁止自我授权：此 MCP Key 不能为其绑定的 Agent 添加白名单");
      }

      const db = getDb();
      const values = {
        agentId: params.agentId,
        model: params.model,
        reason: params.reason ?? null,
        createdBy: `mcp-key:${ctx.apiKeyId}`,
      } satisfies InsertModelAllowlist;
      await db.insert(modelAllowlist).values(values);

      const created = await db
        .select()
        .from(modelAllowlist)
        .where(and(eq(modelAllowlist.agentId, params.agentId), eq(modelAllowlist.model, params.model)))
        .then((r) => r[0]);

      return textResult({
        success: true,
        id: created?.id,
        agentId: params.agentId,
        model: params.model,
      });
    }
  );

  // Tool 21: Guard — 创建高价模型授权（admin，禁止自我授权）
  server.tool(
    "guard_create_auth",
    "[天宫] 创建高价模型授权（需要 admin 权限；禁止为 Key 绑定的 Agent 自身授权）",
    {
      agentId: z.number().describe("目标 Agent ID"),
      model: z.string().min(1).max(100).describe("模型名"),
      reason: z.string().min(1).max(500).describe("授权原因（必填）"),
      expiresAt: z
        .string()
        .refine((v) => !isNaN(new Date(v).getTime()), "无效的时间格式")
        .optional()
        .describe("过期时间（ISO 8601，如 2026-09-01T00:00:00Z；不填 = 永不过期）"),
    },
    async (params) => {
      const denied = requireAdmin();
      if (denied) return denied;
      if (ctx.agentId !== null && ctx.agentId === params.agentId) {
        return failResult("禁止自我授权：此 MCP Key 不能为其绑定的 Agent 创建高价模型授权");
      }

      const db = getDb();
      const values: InsertHighCostModelAuth = {
        agentId: params.agentId,
        model: params.model,
        reason: params.reason,
        authorizedBy: `mcp-key:${ctx.apiKeyId}`,
        active: "true",
      };
      if (params.expiresAt) values.expiresAt = new Date(params.expiresAt);
      await db.insert(highCostModelAuth).values(values);

      const created = await db
        .select()
        .from(highCostModelAuth)
        .where(and(eq(highCostModelAuth.agentId, params.agentId), eq(highCostModelAuth.model, params.model)))
        .then((r) => r[0]);

      return textResult({
        success: true,
        id: created?.id,
        agentId: params.agentId,
        model: params.model,
        expiresAt: created?.expiresAt ?? null,
      });
    }
  );

  // Tool 22: Guard — 撤销授权（admin）
  server.tool(
    "guard_revoke_auth",
    "[天宫] 撤销高价模型授权（需要 admin 权限）",
    {
      id: z.number().describe("授权记录 ID（可通过 guard_status 查询）"),
    },
    async (params) => {
      const denied = requireAdmin();
      if (denied) return denied;

      const db = getDb();
      await db
        .update(highCostModelAuth)
        .set({ active: "false" })
        .where(eq(highCostModelAuth.id, params.id));

      return textResult({ success: true, revoked: true, id: params.id });
    }
  );

  // ═══════════════════════════════════════════
  // TOOLS — Phase 2 扩展：执行面（任务 2.1，dsh 执行循环内可回调天宫）
  // 业务核心走共享 lib（task-claim / task-writeback），与 tRPC 面同一事实源
  // ═══════════════════════════════════════════

  // Tool 23: 主动认领任务（替代纯轮询顺带认领）
  server.tool(
    "claim_task",
    "[天宫] 主动认领下一个可执行任务（执行审批闸门拦截高风险任务；预算耗尽返回 reason）。绑定的 MCP Key 只能认领自己的 Agent",
    {
      agentId: z.number().describe("Agent ID"),
    },
    async (params) => {
      // 权限收窄（与 agent.claimTask 同一原则）：绑定 Agent 的 Key 只能认领自己；
      // env/admin Key（ctx.agentId === null）放行任意
      if (ctx.agentId !== null && ctx.agentId !== params.agentId) {
        return errorResult("FORBIDDEN：此 MCP Key 绑定的 Agent 与目标 Agent 不匹配");
      }

      const result = await claimNextTask(getDb(), params.agentId);
      return textResult({ success: true, ...result });
    }
  );

  // Tool 24: 回写任务进度/结果（与 task.updateProgress 同一事实源）
  server.tool(
    "report_progress",
    "[天宫] 回写任务进度/结果：支持 usage 用量记账、artifacts 长产物通道；完成时自动触发统一归档（璇玑记忆 + AList）。绑定 Key 只能回写自己认领的任务",
    { ...UpdateProgressInputSchema.shape },
    async (params) => {
      // actor 映射对齐 tRPC 语义：env/admin Key = -1（管理位，越权规则放行），
      // 绑定 Key = agentId（> 0，与任务认领人不符即 FORBIDDEN）
      const apiKeyAgentId = ctx.agentId === null ? -1 : ctx.agentId;
      try {
        const result = await reportTaskProgress(getDb(), params, { apiKeyAgentId });
        return textResult(result);
      } catch (error) {
        // TRPCError（越权 FORBIDDEN 等）转机器可判别的 errorResult（isError=true）；
        // 携带 TRPCError code 前缀，方便调用方按 FORBIDDEN/... 分支处理
        if (error instanceof TRPCError) return errorResult(`${error.code}: ${error.message}`);
        throw error;
      }
    }
  );

  // Tool 25: 执行中途提交单个产物（dsh 长任务未完成时先交中间产物）
  server.tool(
    "submit_artifact",
    "[天宫] 执行中途提交单个任务产物（type=external_output，完成时随 AList 归档一并带走）。绑定 Key 只能给自己认领的任务提交产物",
    {
      taskId: z.number().describe("任务 ID（数字）"),
      name: z.string().min(1).max(100).describe("产物名（如 full-output.md）"),
      content: z.string().min(1).max(50_000).describe("产物内容"),
      mimeType: z.string().max(50).optional().describe("MIME 类型（如 text/markdown）"),
    },
    async (params) => {
      const db = getDb();
      const task = await db
        .select()
        .from(tasks)
        .where(eq(tasks.id, params.taskId))
        .then((r) => r[0]);

      // 任务可插入性 / 越权 / beidou 拒绝：单一事实源（2.1+2.2 评审 minor 抽 helper）
      const insertableError = isTaskArtifactInsertable(task);
      if (insertableError) return errorResult(insertableError);
      const authz = assertTaskWriteAuthorized(ctx.agentId, task);
      if (!authz.ok) return errorResult(authz.error);

      await db.insert(taskArtifacts).values({
        taskId: task.id,
        agentId: task.agentId ?? null,
        type: "external_output",
        name: params.name,
        content: params.content,
        mimeType: params.mimeType ?? null,
      });

      return textResult({ success: true, taskId: task.id, name: params.name, type: "external_output" });
    }
  );

  // ═══════════════════════════════════════════
  // TOOLS — Phase 2 扩展：知识面（任务 2.2，任何有效 Key 可用，与只读 ops 工具同权限级别）
  // ═══════════════════════════════════════════

  // Tool 26: 读 AList（仅限配置 basePath 内，防路径穿越）
  server.tool(
    "read_alist",
    "[天宫] 列出 AList 网盘目录（仅限配置的 basePath 内；拒绝 \"..\" 等路径穿越），文本文件附下载链接",
    {
      path: z.string().max(1000).optional().default("/").describe("相对 basePath 的目录路径（默认根目录 \"/\"）"),
    },
    async (params) => {
      const cfg = await resolveAlistConfig();
      if (!cfg) return errorResult("AList 未配置");

      const requestPath = resolveAlistRequestPath(cfg.basePath, params.path ?? "/");
      if (requestPath === null) {
        return errorResult(`非法路径：${params.path}（禁止 ".." 段或越出 basePath 的路径）`);
      }

      let files;
      try {
        files = await alistList(cfg, requestPath);
      } catch (e) {
        return errorResult(e instanceof Error ? e.message : "AList 列目录失败");
      }

      // 文本文件附下载链接（尽力而为，单次最多探测 ALIST_MAX_DOWNLOAD_LOOKUPS 个）
      let lookups = 0;
      const enriched = await Promise.all(
        files.map(async (f) => {
          if (f.isDir || !isTextualFileName(f.name) || lookups >= ALIST_MAX_DOWNLOAD_LOOKUPS) {
            return { ...f, downloadUrl: null };
          }
          lookups += 1;
          try {
            return { ...f, downloadUrl: await alistDownloadUrl(cfg, f.path) };
          } catch {
            return { ...f, downloadUrl: null };
          }
        })
      );

      return textResult({ success: true, basePath: cfg.basePath, path: requestPath, files: enriched });
    }
  );

  // Tool 27: 检索璇玑长期记忆（执行前反查同类任务经验/失败教训）
  server.tool(
    "search_xuanji",
    "[天宫] 检索璇玑长期记忆（keyword/vector/hybrid 三模式），执行任务前反查同类任务经验与失败教训",
    {
      query: z.string().min(1).max(1000).describe("检索词"),
      mode: z.enum(["keyword", "vector", "hybrid"]).optional().default("hybrid").describe("检索模式（默认 hybrid）"),
      limit: z.number().int().min(1).max(50).optional().default(5).describe("返回条数（默认 5）"),
      taskId: z.string().min(1).max(64).optional().describe("关联任务 ID（用于链路追踪，可选）"),
      traceId: TraceIdSchema.optional().describe("复用已有 traceId（可选，缺省自动生成）"),
      filters: z
        .object({
          project: z.string().min(1).max(200).optional().describe("按项目过滤"),
          tags: z.array(z.string().min(1).max(100)).optional().describe("按标签过滤"),
          types: z.array(z.string().min(1).max(100)).optional().describe("按文档类型过滤"),
        })
        .optional()
        .describe("检索过滤条件（可选）"),
    },
    async (params) => {
      const client = createXuanjiClient();
      if (!client) return errorResult("璇玑未配置");

      // 入参对齐 SearchContextRequestSchema；trace 由工具侧自动补齐
      //（调用方只需给 query/mode/limit，不必手工编造 traceId）
      const input = SearchContextRequestSchema.parse({
        query: params.query,
        mode: params.mode,
        limit: params.limit,
        ...(params.filters ? { filters: params.filters } : {}),
        trace: {
          traceId: params.traceId ?? createTraceId(),
          taskId: params.taskId ?? "mcp-search",
          agentId: ctx.agentId !== null ? String(ctx.agentId) : `mcp-key:${ctx.apiKeyId}`,
          originSystem: "tiangong",
        },
      });

      try {
        const data = await client.searchContext(input);
        return textResult({ success: true, ...data });
      } catch (error) {
        if (error instanceof XuanjiConnectorError) return errorResult(error.message);
        throw error;
      }
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

  return server;
}
