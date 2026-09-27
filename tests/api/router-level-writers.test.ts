/**
 * Phase B §3-3 切片 7：**路由层**最后 9 处零散写入统一走转移服务。
 *
 * 覆盖：mcp update_task_status（主更新 + done 触发下游解锁）、orchestration.updateStatus
 * （主更新 + done 触发下游解锁）、dag.runDag（dispatchSingleTask）、mailbox.handoff、
 * auto-approve（LLM 自动批准放行）。
 *
 * 实现前应当是断言级 RED（修订号停在 1 / 走向字段缺失）。
 *
 * 已知事实（如实记录）：mcp:350 与 orchestration:257 的"failed→queued 自动重试"分支
 * 在现网不可达——两处的 statusTransitions/validTransitions 映射表都把 failed→queued
 * 列为合法走向，请求永远走主更新路径。这两处仍随本切片一并转换（保持"全部写入走服务"
 * 的结构不变量），但不设独立用例。
 */
import { eq } from "drizzle-orm";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDb, markSystemReady, type TestDb } from "./helpers/test-db";
import * as schema from "@db/schema";

const conn = vi.hoisted(() => ({ getDb: vi.fn() }));
const wsMocks = vi.hoisted(() => ({
  broadcastToDashboard: vi.fn(),
  broadcastToTask: vi.fn(),
  sendToAgent: vi.fn(),
}));
const collabMocks = vi.hoisted(() => ({ emitCollabSummaryForTask: vi.fn() }));

vi.mock("../../api/queries/connection", () => ({ getDb: conn.getDb }));
vi.mock("../../api/ws-manager", () => ({ wsManager: wsMocks }));
vi.mock("../../api/lib/collaboration-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/lib/collaboration-events")>()),
  emitCollabSummaryForTask: collabMocks.emitCollabSummaryForTask,
}));

import { getMcpServer, type McpToolContext } from "../../api/mcp/server";
import { orchestrationRouter } from "../../api/orchestration-router";
import { dagRouter } from "../../api/dag-router";
import { mailboxRouter } from "../../api/mailbox-router";
import { triggerAutoReview } from "../../api/lib/auto-approve";
import { setSetting } from "../../api/lib/settings";
import { createCallerFactory } from "../../api/middleware";

let testDb: TestDb;

const MCP_CTX: McpToolContext = { apiKeyId: 7, agentId: 17, permissions: ["admin"] };

async function callTool(name: string, args: Record<string, unknown>) {
  const server = getMcpServer(MCP_CTX);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "router-writers-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    return { isError: result.isError === true, payload: JSON.parse(text) };
  } finally {
    await client.close();
  }
}

const orchCaller = createCallerFactory(orchestrationRouter);
const dagCaller = createCallerFactory(dagRouter);
const mailboxCaller = createCallerFactory(mailboxRouter);
const adminCtx = { req: undefined, user: { id: 1, role: "admin" }, apiKeyAgentId: -1 } as never;

async function seedTask(overrides: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<number> {
  const rows = await testDb.db
    .insert(schema.tasks)
    .values({
      taskId: `T-R7-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "路由层写入测试任务",
      description: "desc",
      priority: 0,
      ...overrides,
    })
    .returning({ id: schema.tasks.id });
  return rows[0].id;
}

async function seedAgent(agentId: string): Promise<number> {
  const rows = await testDb.db
    .insert(schema.agents)
    .values({ agentId, name: `agent-${agentId}`, system: "openclaw", status: "online" })
    .returning({ id: schema.agents.id });
  return rows[0].id;
}

async function seedDep(taskId: number, dependsOnTaskId: number): Promise<void> {
  await testDb.db.insert(schema.taskDependencies).values({ taskId, dependsOnTaskId });
}

async function taskRow(id: number) {
  const rows = await testDb.db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return rows[0];
}

beforeEach(() => {
  testDb = createTestDb();
  markSystemReady();
  conn.getDb.mockReturnValue(testDb.db);
  collabMocks.emitCollabSummaryForTask.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(wsMocks)) fn.mockReset();
});

afterEach(() => {
  testDb.dispose();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("§3-3 切片 7：路由层零散写入递增修订号", () => {
  it("mcp update_task_status 主更新：running→done 带 progress/output，修订号 1→2", async () => {
    const id = await seedTask({ status: "running", lifecycleStatus: "working" });

    const result = await callTool("update_task_status", { taskId: id, status: "done", progress: 100, output: "ok" });
    expect(result.payload.success).toBe(true);

    const row = await taskRow(id);
    expect(row.status).toBe("done");
    expect(row.progress).toBe(100);
    expect(row.output).toBe("ok");
    expect(row.stateRevision).toBe(2);
  });

  it("mcp update_task_status done 触发下游：pending 子任务转 queued，修订号 1→2", async () => {
    const parent = await seedTask({ status: "running", lifecycleStatus: "working" });
    const child = await seedTask({ status: "pending", lifecycleStatus: "created" });
    await seedDep(child, parent);

    const result = await callTool("update_task_status", { taskId: parent, status: "done" });
    expect(result.payload.success).toBe(true);

    const row = await taskRow(child);
    expect(row.status).toBe("queued");
    expect(row.stateRevision).toBe(2);
  });

  it("orchestration updateStatus 主更新：running→done 带进度产出，父 rev2 且下游子任务 rev2", async () => {
    const parent = await seedTask({ status: "running", lifecycleStatus: "working" });
    const child = await seedTask({ status: "pending", lifecycleStatus: "created" });
    await seedDep(child, parent);

    const result = await orchCaller(adminCtx).updateStatus({ id: parent, status: "done", progress: 100, output: "完成" });
    expect(result.success).toBe(true);

    const prow = await taskRow(parent);
    expect(prow.status).toBe("done");
    expect(prow.progress).toBe(100);
    expect(prow.stateRevision).toBe(2);
    const crow = await taskRow(child);
    expect(crow.status).toBe("queued");
    expect(crow.stateRevision).toBe(2);
  });

  it("dag runDag：依赖完成的 pending 任务被派发（queued+dispatched），修订号 1→2", async () => {
    const root = await seedTask({ status: "done", lifecycleStatus: "completed" });
    const child = await seedTask({ status: "pending", lifecycleStatus: "created" });
    await seedDep(child, root);

    const result = await dagCaller(adminCtx).runDag({ taskId: root });
    expect(result.dispatched).toContain(child);

    const row = await taskRow(child);
    expect(row.status).toBe("queued");
    expect(row.lifecycleStatus).toBe("dispatched");
    expect(row.dispatchedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("mailbox handoff：任务从 A 移交 B，走向字段一次写齐，修订号 1→2", async () => {
    const agentA = await seedAgent("mb-a");
    const agentB = await seedAgent("mb-b");
    const id = await seedTask({ status: "running", lifecycleStatus: "working", agentId: agentA });

    await mailboxCaller(adminCtx).handoff({
      fromMailboxId: "mb-a",
      toMailboxId: "mb-b",
      taskId: id,
      subject: "移交",
    } as never);

    const row = await taskRow(id);
    expect(row.agentId).toBe(agentB);
    expect(row.dispatcherAgentId).toBe(agentA);
    expect(row.status).toBe("running");
    expect(row.lifecycleStatus).toBe("dispatched");
    expect(row.dispatchedAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });

  it("auto-approve：LLM 批准后停放任务放行（ready+queued），修订号 1→2", async () => {
    const input = JSON.stringify({
      metadata: {
        traceId: "trc_r7aa_abcdefgh",
        taskType: "coding_task",
        origin: { system: "mcp" },
        routing: { candidateAgentIds: [], approvalRequired: true, riskTypes: ["github_push"] },
        policies: {},
        knowledgeRefs: [],
        artifactRefs: [],
        approval: {
          riskType: "github_push",
          requestedByTaskId: "T-R7AA",
          requestedByAgentId: "17",
          target: "push code",
          preview: "git push",
          decision: "pending",
        },
      },
    });
    const id = await seedTask({
      status: "pending",
      boardStatus: "blocked",
      blockedAt: new Date(),
      input,
    });

    await setSetting("auto_approve_enabled", "1", "auto_approve");
    vi.stubEnv("TIANSHU_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"approve","reason":"低风险推送"}' } }] }), {
          status: 200,
        })
      )
    );

    triggerAutoReview(id);
    await vi.waitFor(
      async () => {
        const row = await taskRow(id);
        if (row.boardStatus !== "ready") throw new Error("not released yet");
      },
      { timeout: 5000, interval: 50 }
    );

    const row = await taskRow(id);
    expect(row.boardStatus).toBe("ready");
    expect(row.status).toBe("queued");
    expect(row.reviewResult).toBe("approved");
    expect(row.blockedAt).toBeNull();
    expect(row.readyAt).toEqual(expect.any(Date));
    expect(row.stateRevision).toBe(2);
  });
});
