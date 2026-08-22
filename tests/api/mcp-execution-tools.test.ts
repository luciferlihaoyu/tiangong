/**
 * 任务 2.1 + 2.2：MCP 执行面 + 知识面工具测试
 *
 * 覆盖（dsh 执行循环内可回调天宫）：
 *   - claim_task：Key 绑定 Agent 越权 FORBIDDEN；正常认领（running/claimed/busy）；
 *     预算耗尽 → task:null + reason；env/admin Key（agentId null）放行任意 Agent
 *   - report_progress：usage+artifacts 完成 → token_usage / task_artifacts 落库 +
 *     finalize 两个归档 sync 被调；绑定 Key 越权（≠ 认领人）→ isError FORBIDDEN
 *   - submit_artifact：中途产物 type=external_output；越权 FORBIDDEN；终态拒绝
 *   - read_alist：路径穿越（../x、a/../../b、../../etc）拒绝；正常列目录透传 +
 *     文本文件附下载链接；未配置 failResult
 *   - search_xuanji：结果透传 + trace 自动补齐；未配置 failResult；连接器错误转 failResult
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFakeDb, type FakeDb } from "./helpers/fake-db";

const connMocks = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("../../api/queries/connection", () => ({ getDb: connMocks.getDb }));

vi.mock("../../api/ws-manager", () => ({
  wsManager: {
    broadcastToDashboard: vi.fn(),
    broadcast: vi.fn(),
    sendToAgent: vi.fn(),
    isOnline: vi.fn(() => false),
  },
}));

vi.mock("../../api/lib/collaboration-events", () => ({
  emitCollabSummaryForTask: vi.fn().mockResolvedValue(undefined),
}));

// finalize 的两个归档接收端（真实 task-finalize 会调用它们——断言统一归档入口被走到）
const syncMocks = vi.hoisted(() => ({
  syncTaskMemoryToXuanji: vi.fn(),
  syncTaskArtifactsToAlist: vi.fn(),
}));
vi.mock("../../api/lib/xuanji-sync", () => ({
  syncTaskMemoryToXuanji: syncMocks.syncTaskMemoryToXuanji,
  XUANJI_MEMORY_ARTIFACT_TYPE: "xuanji_memory",
}));
vi.mock("../../api/lib/alist-sync", () => ({
  syncTaskArtifactsToAlist: syncMocks.syncTaskArtifactsToAlist,
  ALIST_SYNC_ARTIFACT_TYPE: "alist_sync",
}));

// AList 连接器（read_alist）
const alistMocks = vi.hoisted(() => ({
  resolveAlistConfig: vi.fn(),
  alistList: vi.fn(),
  alistDownloadUrl: vi.fn(),
}));
vi.mock("../../api/connectors/alist", () => alistMocks);

// 璇玑连接器工厂（search_xuanji）
const xuanjiMocks = vi.hoisted(() => ({
  createXuanjiClient: vi.fn(),
}));
vi.mock("../../api/connectors/xuanji/service", () => ({
  createXuanjiClient: xuanjiMocks.createXuanjiClient,
}));

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpServer, type McpToolContext } from "../../api/mcp/server";
import { XuanjiConnectorError } from "../../api/connectors/xuanji/client";
import * as schema from "@db/schema";

const ADMIN_CTX: McpToolContext = { apiKeyId: 7, agentId: null, permissions: ["admin"] };
const PLAIN_CTX: McpToolContext = { apiKeyId: 3, agentId: null, permissions: [] };
/** Key 绑定 Agent 16（模拟 dsh-runner 的专属 Key） */
const AGENT_BOUND_CTX: McpToolContext = { apiKeyId: 9, agentId: 16, permissions: [] };

let db: FakeDb;

async function callTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext = PLAIN_CTX
): Promise<{ isError: boolean; payload: Record<string, any> }> {
  const server = getMcpServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-execution-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) };
  } finally {
    await client.close();
  }
}

/** 常用任务行：id=7, agentId=16, running（低风险，不触发完成闸门） */
function seedTask(overrides: Record<string, unknown> = {}) {
  db.insert(schema.tasks).values({
    id: 7,
    taskId: "TG-MCP1",
    name: "mcp writeback task",
    description: null,
    input: null,
    output: null,
    agentId: 16,
    status: "running",
    lifecycleStatus: "working",
    originSystem: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

/** Key 绑定的 Agent 16（dsh-runner） */
function seedAgent(overrides: Record<string, unknown> = {}) {
  db.insert(schema.agents).values({
    id: 16,
    agentId: "a16",
    name: "dsh-runner",
    status: "idle",
    budgetCents: 0,
    spentCents: 0,
    ...overrides,
  });
}

/** Agent 16 名下可认领的 queued 任务 */
function seedQueuedTask(overrides: Record<string, unknown> = {}) {
  db.insert(schema.tasks).values({
    id: 21,
    taskId: "TG-Q1",
    name: "low risk queued task",
    description: null,
    input: null,
    output: null,
    agentId: 16,
    status: "queued",
    boardStatus: null,
    priority: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db = createFakeDb();
  connMocks.getDb.mockReturnValue(db);
  syncMocks.syncTaskMemoryToXuanji.mockResolvedValue(undefined);
  syncMocks.syncTaskArtifactsToAlist.mockResolvedValue(undefined);
});

// ─── 任务 2.1：claim_task ───
describe("claim_task", () => {
  it("Key 绑定 Agent 与目标不符 → isError FORBIDDEN", async () => {
    const { isError, payload } = await callTool("claim_task", { agentId: 17 }, AGENT_BOUND_CTX);
    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("FORBIDDEN");
    expect(db.rowsOfTable(schema.tasks)).toHaveLength(0);
  });

  it("Key 绑定 Agent 匹配 → 认领成功（running/claimed + agent busy）", async () => {
    seedAgent();
    seedQueuedTask();

    const { isError, payload } = await callTool("claim_task", { agentId: 16 }, AGENT_BOUND_CTX);
    expect(isError).toBe(false);
    expect(payload.task.id).toBe(21);
    expect(payload.task.taskId).toBe("TG-Q1");
    expect(payload.task.name).toBe("low risk queued task");
    expect(payload.task.approvalRequired).toBe(false);
    expect(payload.reason).toBeUndefined();

    const taskRow = db.rowsOfTable(schema.tasks).find((t) => t.id === 21)!;
    expect(taskRow.status).toBe("running");
    expect(taskRow.lifecycleStatus).toBe("claimed");
    expect(taskRow.agentId).toBe(16);
    const agentRow = db.rowsOfTable(schema.agents).find((a) => a.id === 16)!;
    expect(agentRow.status).toBe("busy");
  });

  it("env/admin Key（agentId null）可代任意 Agent 认领", async () => {
    seedAgent();
    seedQueuedTask();

    const { isError, payload } = await callTool("claim_task", { agentId: 16 }, ADMIN_CTX);
    expect(isError).toBe(false);
    expect(payload.task.id).toBe(21);
  });

  it("预算耗尽 → task:null + reason=budget_exhausted，不停放任务", async () => {
    seedAgent({ budgetCents: 100, spentCents: 150 });
    seedQueuedTask();

    const { isError, payload } = await callTool("claim_task", { agentId: 16 }, AGENT_BOUND_CTX);
    expect(isError).toBe(false);
    expect(payload.task).toBeNull();
    expect(payload.reason).toBe("budget_exhausted");
    // 轻量停放：任务保持 queued，预算恢复后下一轮即可自动认领
    expect(db.rowsOfTable(schema.tasks).find((t) => t.id === 21)!.status).toBe("queued");
  });
});

// ─── 任务 2.1：report_progress ───
describe("report_progress", () => {
  it("带 usage+artifacts 完成 → token_usage / task_artifacts 落库 + finalize 两个 sync 被调", async () => {
    seedTask();

    const { isError, payload } = await callTool(
      "report_progress",
      {
        id: 7,
        progress: 100,
        status: "done",
        lifecycleStatus: "completed",
        output: "ok",
        usage: { model: "test-model", promptTokens: 1_000, completionTokens: 2_000 },
        artifacts: [{ name: "full-output.md", content: "全文内容", mimeType: "text/markdown" }],
      },
      AGENT_BOUND_CTX
    );
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);

    // 外部用量记账：写一行 token_usage（provider/source=external）
    const usageRows = db.rowsOfTable(schema.tokenUsage);
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      model: "test-model",
      provider: "external",
      source: "external",
      taskId: 7,
      agentId: 16,
      totalTokens: 3_000,
      callCount: 1,
    });

    // 长产物通道：task_artifacts type=external_output
    const artifactRows = db.rowsOfTable(schema.taskArtifacts);
    expect(artifactRows).toHaveLength(1);
    expect(artifactRows[0]).toMatchObject({
      taskId: 7,
      agentId: 16,
      type: "external_output",
      name: "full-output.md",
      content: "全文内容",
      mimeType: "text/markdown",
    });

    // 完成路径统一走 finalizeCompletedTask → 两个归档接收端都被调
    expect(syncMocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(1);
    expect(syncMocks.syncTaskArtifactsToAlist).toHaveBeenCalledTimes(1);

    expect(db.rowsOfTable(schema.tasks).find((t) => t.id === 7)!.status).toBe("done");
  });

  it("绑定 Key 与任务认领人不符 → isError FORBIDDEN，不落任何 usage/artifacts", async () => {
    seedTask({ agentId: 5 });

    const { isError, payload } = await callTool(
      "report_progress",
      {
        id: 7,
        progress: 100,
        status: "done",
        usage: { model: "test-model", promptTokens: 10, completionTokens: 10 },
      },
      AGENT_BOUND_CTX
    );
    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("FORBIDDEN");
    expect(db.rowsOfTable(schema.tokenUsage)).toHaveLength(0);
    expect(db.rowsOfTable(schema.taskArtifacts)).toHaveLength(0);
  });

  it("env Key（管理位）可回写他人任务（对齐 tRPC apiKeyAgentId=-1 语义）", async () => {
    seedTask({ agentId: 5 });

    const { isError, payload } = await callTool(
      "report_progress",
      { id: 7, progress: 50, status: "running", output: "half" },
      ADMIN_CTX
    );
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(db.rowsOfTable(schema.tasks).find((t) => t.id === 7)!.progress).toBe(50);
  });
});

// ─── 任务 2.1：submit_artifact ───
describe("submit_artifact", () => {
  it("执行中途提交产物 → task_artifacts type=external_output", async () => {
    seedTask();

    const { isError, payload } = await callTool(
      "submit_artifact",
      { taskId: 7, name: "partial-output.md", content: "中间产物", mimeType: "text/markdown" },
      AGENT_BOUND_CTX
    );
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);

    const rows = db.rowsOfTable(schema.taskArtifacts);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskId: 7,
      agentId: 16,
      type: "external_output",
      name: "partial-output.md",
      content: "中间产物",
      mimeType: "text/markdown",
    });
  });

  it("绑定 Key 与任务认领人不符 → isError FORBIDDEN", async () => {
    seedTask({ agentId: 5 });

    const { isError, payload } = await callTool(
      "submit_artifact",
      { taskId: 7, name: "evil.md", content: "spoofed" },
      AGENT_BOUND_CTX
    );
    expect(isError).toBe(true);
    expect(payload.error).toContain("FORBIDDEN");
    expect(db.rowsOfTable(schema.taskArtifacts)).toHaveLength(0);
  });

  it("终态任务拒绝提交（终态不可变）", async () => {
    seedTask({ status: "done" });

    const { isError, payload } = await callTool(
      "submit_artifact",
      { taskId: 7, name: "late.md", content: "too late" },
      AGENT_BOUND_CTX
    );
    expect(isError).toBe(true);
    expect(payload.error).toContain("终态");
    expect(db.rowsOfTable(schema.taskArtifacts)).toHaveLength(0);
  });

  it("任务不存在 → failResult", async () => {
    const { isError, payload } = await callTool(
      "submit_artifact",
      { taskId: 999, name: "x.md", content: "y" },
      AGENT_BOUND_CTX
    );
    expect(isError).toBe(true);
    expect(payload.error).toContain("任务不存在");
  });
});

// ─── 任务 2.2：read_alist ───
describe("read_alist", () => {
  const CFG = {
    baseUrl: "https://alist.example",
    username: "u",
    password: "p",
    basePath: "/data/tg",
    autoUpload: true,
  };

  it("路径穿越被拒（../x、a/../../b、../../etc），不触达 AList", async () => {
    alistMocks.resolveAlistConfig.mockResolvedValue(CFG);

    for (const bad of ["../x", "a/../../b", "../../etc"]) {
      const { isError, payload } = await callTool("read_alist", { path: bad });
      expect(isError).toBe(true);
      expect(payload.success).toBe(false);
      expect(payload.error).toContain("非法路径");
    }
    expect(alistMocks.alistList).not.toHaveBeenCalled();
  });

  it("正常列目录：路径重定基到 basePath，文件字段透传，文本文件附下载链接", async () => {
    alistMocks.resolveAlistConfig.mockResolvedValue(CFG);
    alistMocks.alistList.mockResolvedValue([
      { name: "tasks", path: "/data/tg/tasks", isDir: true, size: 0 },
      { name: "report.md", path: "/data/tg/report.md", isDir: false, size: 12, modified: "2025-01-01T00:00:00Z" },
      { name: "app.bin", path: "/data/tg/app.bin", isDir: false, size: 4096 },
    ]);
    alistMocks.alistDownloadUrl.mockResolvedValue("https://alist.example/dl/report.md");

    const { isError, payload } = await callTool("read_alist", { path: "tasks" });
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    // 实际请求路径 = basePath + 入参相对路径
    expect(alistMocks.alistList).toHaveBeenCalledWith(CFG, "/data/tg/tasks");

    expect(payload.files).toHaveLength(3);
    const dir = payload.files.find((f: any) => f.name === "tasks");
    expect(dir.isDir).toBe(true);
    expect(dir.downloadUrl).toBeNull();
    const text = payload.files.find((f: any) => f.name === "report.md");
    expect(text.size).toBe(12);
    expect(text.modified).toBe("2025-01-01T00:00:00Z");
    expect(text.downloadUrl).toBe("https://alist.example/dl/report.md");
    const binary = payload.files.find((f: any) => f.name === "app.bin");
    expect(binary.downloadUrl).toBeNull();
    // 只有文本文件请求了下载链接
    expect(alistMocks.alistDownloadUrl).toHaveBeenCalledTimes(1);
    expect(alistMocks.alistDownloadUrl).toHaveBeenCalledWith(CFG, "/data/tg/report.md");
  });

  it("默认 path=/ 列 basePath 根目录", async () => {
    alistMocks.resolveAlistConfig.mockResolvedValue(CFG);
    alistMocks.alistList.mockResolvedValue([]);

    const { isError, payload } = await callTool("read_alist", {});
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(alistMocks.alistList).toHaveBeenCalledWith(CFG, "/data/tg");
  });

  it("未配置 → failResult", async () => {
    alistMocks.resolveAlistConfig.mockResolvedValue(null);

    const { isError, payload } = await callTool("read_alist", { path: "/" });
    expect(isError).toBe(true);
    expect(payload.error).toContain("AList 未配置");
    expect(alistMocks.alistList).not.toHaveBeenCalled();
  });
});

// ─── 任务 2.2：search_xuanji ───
describe("search_xuanji", () => {
  const FIXTURE = {
    results: [
      {
        kind: "lesson",
        documentId: 1,
        chunkId: null,
        title: "部署经验",
        snippet: "zeabur 部署需要注意……",
        score: 0.9,
        source: "xuanji",
      },
    ],
    graphHints: [],
    memoryDigest: "",
  };

  it("正常检索：结果透传 + trace 自动补齐（originSystem=tiangong）", async () => {
    const searchContext = vi.fn().mockResolvedValue(FIXTURE);
    xuanjiMocks.createXuanjiClient.mockReturnValue({ searchContext });

    const { isError, payload } = await callTool(
      "search_xuanji",
      { query: "部署经验", mode: "keyword", limit: 3 },
      AGENT_BOUND_CTX
    );
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(payload.results).toEqual(FIXTURE.results);
    expect(payload.memoryDigest).toBe("");

    expect(searchContext).toHaveBeenCalledTimes(1);
    expect(searchContext).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "部署经验",
        mode: "keyword",
        limit: 3,
        trace: expect.objectContaining({ originSystem: "tiangong", agentId: "16" }),
      })
    );
  });

  it("未配置 → failResult", async () => {
    xuanjiMocks.createXuanjiClient.mockReturnValue(null);

    const { isError, payload } = await callTool("search_xuanji", { query: "x" });
    expect(isError).toBe(true);
    expect(payload.error).toContain("璇玑未配置");
  });

  it("连接器错误 → failResult（isError）", async () => {
    xuanjiMocks.createXuanjiClient.mockReturnValue({
      searchContext: vi.fn().mockRejectedValue(
        new XuanjiConnectorError({ code: "http_error", message: "璇玑服务 502" })
      ),
    });

    const { isError, payload } = await callTool("search_xuanji", { query: "x" });
    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("璇玑服务 502");
  });
});
