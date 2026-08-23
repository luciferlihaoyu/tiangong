import { beforeEach, describe, expect, it, vi } from "vitest";

type DbRow = Readonly<Record<string, unknown>>;

// ─── Mock database with a queued select result pattern (mirrors execution-gate.test.ts) ───
const dbMocks = vi.hoisted(() => {
  let selectResults: ReadonlyArray<ReadonlyArray<DbRow>> = [];
  const updateSets: ReadonlyArray<Readonly<Record<string, unknown>>> = [];

  const consumeSelectResult = (): ReadonlyArray<DbRow> => {
    const result = selectResults[0] ?? [];
    selectResults = selectResults.slice(1);
    return result;
  };

  const chained = (value: ReadonlyArray<DbRow>) => ({
    where: vi.fn(() => chained(value)),
    orderBy: vi.fn(() => chained(value)),
    limit: vi.fn(() => Promise.resolve(value)),
    then: (onFulfilled: (rows: ReadonlyArray<DbRow>) => unknown) => Promise.resolve(value).then(onFulfilled),
  });

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => chained(consumeSelectResult())),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Readonly<Record<string, unknown>>) => {
        updateSets.push(values);
        return { where: vi.fn(() => Promise.resolve([])) };
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => Promise.resolve({ insertId: 1 })),
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
  };

  return {
    db,
    updateSets,
    queueSelectResults: (results: ReadonlyArray<ReadonlyArray<DbRow>>) => {
      selectResults = results;
    },
    clearUpdateSets: () => {
      updateSets.length = 0;
    },
  };
});

vi.mock("../../api/queries/connection", () => ({ getDb: () => dbMocks.db }));

// ─── Mock audit/notify/xuanji/newapi seams so sweepers run fully mocked ───
const auditMocks = vi.hoisted(() => ({
  events: [] as ReadonlyArray<Readonly<Record<string, unknown>>>,
}));

vi.mock("../../api/lib/audit-log", () => ({
  writeAuditEvent: (params: Readonly<Record<string, unknown>>) => {
    auditMocks.events = [...auditMocks.events, params];
  },
  AUDIT_EVENT_NAMES: [],
  auditChangedFields: () => [] as string[],
}));

const notifyMocks = vi.hoisted(() => ({
  sendMailboxNotification: vi.fn(async () => {}),
}));

vi.mock("../../api/lib/taskboard-notify", () => ({
  sendMailboxNotification: notifyMocks.sendMailboxNotification,
}));

const xuanjiMocks = vi.hoisted(() => ({
  syncTaskMemoryToXuanji: vi.fn(async () => ({ synced: true, reason: "written" as const })),
  syncTaskLessonToXuanji: vi.fn(async () => ({ synced: true, reason: "written" as const })),
}));

vi.mock("../../api/lib/xuanji-sync", () => ({
  XUANJI_MEMORY_ARTIFACT_TYPE: "xuanji_memory",
  XUANJI_LESSON_ARTIFACT_TYPE: "xuanji_lesson",
  syncTaskMemoryToXuanji: xuanjiMocks.syncTaskMemoryToXuanji,
  syncTaskLessonToXuanji: xuanjiMocks.syncTaskLessonToXuanji,
}));

const newApiMocks = vi.hoisted(() => ({
  createNewApiClient: vi.fn(),
}));

vi.mock("../../api/connectors/newapi/service", () => ({
  createNewApiClient: newApiMocks.createNewApiClient,
}));

import type { Db } from "../../api/lib/sweepers/db";
import { sweepAgentWatchdog } from "../../api/lib/sweepers/agent-watchdog";
import { sweepApprovalNag } from "../../api/lib/sweepers/approval-nag";
import { sweepMemoryCompensation } from "../../api/lib/sweepers/memory-compensation";
import { sweepNewApiPatrol } from "../../api/lib/sweepers/newapi-patrol";
import { sweepTaskTimeouts } from "../../api/lib/sweepers/task-lifecycle";

const mockDb = dbMocks.db as unknown as Db;
const NOW = new Date("2026-08-08T12:00:00.000Z");

function auditEvents(): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return auditMocks.events;
}

// ─── sweepTaskTimeouts ───
describe("sweepTaskTimeouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.clearUpdateSets();
    auditMocks.events = [];
  });

  it("requeues a stale running task when retries remain", async () => {
    // Given: running 1h, timeout 5min, retry 1/3
    const staleTask: DbRow = {
      id: 1,
      taskId: "T-STALE-1",
      status: "running",
      retryCount: 1,
      maxRetries: 3,
      timeoutMs: 300_000,
      claimedAt: new Date(NOW.getTime() - 3_600_000),
      updatedAt: new Date(NOW.getTime() - 3_600_000),
    };
    dbMocks.queueSelectResults([[staleTask], []]); // running rows + storm-check rows

    // When
    await sweepTaskTimeouts(mockDb, NOW);

    // Then: requeued with the MCP retry fields, no audits
    expect(dbMocks.updateSets).toHaveLength(1);
    expect(dbMocks.updateSets[0]).toMatchObject({ status: "queued", retryCount: 2, error: null });
    expect(auditEvents()).toHaveLength(0);
  });

  it("marks a stale task failed at terminal retries and audits task:timeout", async () => {
    // Given: retries exhausted (3/3)
    const exhaustedTask: DbRow = {
      id: 2,
      taskId: "T-EXH-1",
      status: "running",
      retryCount: 3,
      maxRetries: 3,
      timeoutMs: 300_000,
      claimedAt: new Date(NOW.getTime() - 7_200_000),
      updatedAt: new Date(NOW.getTime() - 7_200_000),
    };
    dbMocks.queueSelectResults([[exhaustedTask], []]);

    // When
    await sweepTaskTimeouts(mockDb, NOW);

    // Then: terminal fail + task:timeout audit, no storm (recent failed list empty)
    expect(dbMocks.updateSets[0]?.status).toBe("failed");
    const timeouts = auditEvents().filter((e) => e.event === "task:timeout");
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]?.entityId).toBe(2);
    expect(timeouts[0]?.metadata).toMatchObject({ taskId: "T-EXH-1" });
    expect(auditEvents().filter((e) => e.event === "task:retry_storm")).toHaveLength(0);
  });

  it("超时重试耗尽落 failed 终态时，写入含超时上下文的失败教训（幂等标记兜底去重）", async () => {
    // Given：running 超时且重试耗尽（orchestration 路径的终态失败）
    const exhaustedTask: DbRow = {
      id: 2,
      taskId: "T-EXH-1",
      name: "超时未响应的任务",
      description: "上游迟迟无响应",
      input: null,
      output: null,
      agentId: 16,
      status: "running",
      retryCount: 3,
      maxRetries: 3,
      timeoutMs: 300_000,
      claimedAt: new Date(NOW.getTime() - 7_200_000),
      updatedAt: new Date(NOW.getTime() - 7_200_000),
    };
    dbMocks.queueSelectResults([[exhaustedTask], []]);

    // When
    await sweepTaskTimeouts(mockDb, NOW);

    // Then：落 failed 终态 + 教训恰好一次，error 带超时上下文，agentId 归任务行
    expect(dbMocks.updateSets[0]?.status).toBe("failed");
    expect(xuanjiMocks.syncTaskLessonToXuanji).toHaveBeenCalledTimes(1);
    const lessonTask = xuanjiMocks.syncTaskLessonToXuanji.mock.calls[0]?.[1] as DbRow | undefined;
    expect(lessonTask).toMatchObject({
      id: 2,
      taskId: "T-EXH-1",
      status: "failed",
      lifecycleStatus: "failed",
      agentId: 16,
    });
    expect(String(lessonTask?.error ?? "")).toContain("任务超时未响应");
  });

  it("skips running tasks still within their timeout", async () => {
    // Given: running for only 1 minute
    const freshTask: DbRow = {
      id: 3,
      taskId: "T-FRESH-1",
      status: "running",
      retryCount: 0,
      maxRetries: 3,
      timeoutMs: 300_000,
      claimedAt: new Date(NOW.getTime() - 60_000),
      updatedAt: new Date(NOW.getTime() - 60_000),
    };
    dbMocks.queueSelectResults([[freshTask], []]);

    // When
    await sweepTaskTimeouts(mockDb, NOW);

    // Then: untouched
    expect(dbMocks.updateSets).toHaveLength(0);
    expect(auditEvents()).toHaveLength(0);
  });

  it("emits a task:retry_storm audit when >= 5 tasks failed in the last hour", async () => {
    // Given: one stale running task (fails) + 5 recently failed tasks
    const staleTask: DbRow = {
      id: 4,
      taskId: "T-4",
      status: "running",
      retryCount: 3,
      maxRetries: 3,
      timeoutMs: 300_000,
      claimedAt: new Date(NOW.getTime() - 3_600_000),
      updatedAt: new Date(NOW.getTime() - 3_600_000),
    };
    const failedRows: DbRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: 100 + i,
      taskId: `T-F-${i}`,
      status: "failed",
      updatedAt: new Date(NOW.getTime() - 600_000),
    }));
    dbMocks.queueSelectResults([[staleTask], failedRows]);

    // When
    await sweepTaskTimeouts(mockDb, NOW);

    // Then: storm audit carries the count; the stale task also timed out
    const storm = auditEvents().find((e) => e.event === "task:retry_storm");
    expect(storm).toBeDefined();
    expect(storm?.metadata).toMatchObject({ count: 5 });
    expect(auditEvents().filter((e) => e.event === "task:timeout")).toHaveLength(1);
  });

  it("does not emit a storm audit below the threshold", async () => {
    // Given: only 2 recent failed tasks
    const failedRows: DbRow[] = Array.from({ length: 2 }, (_, i) => ({
      id: 200 + i,
      taskId: `T-X-${i}`,
      status: "failed",
      updatedAt: new Date(NOW.getTime() - 600_000),
    }));
    dbMocks.queueSelectResults([[], failedRows]);

    // When
    await sweepTaskTimeouts(mockDb, NOW);

    // Then
    expect(auditEvents().filter((e) => e.event === "task:retry_storm")).toHaveLength(0);
  });
});

// ─── sweepAgentWatchdog ───
describe("sweepAgentWatchdog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.clearUpdateSets();
    auditMocks.events = [];
  });

  it("idles agents with null or stale heartbeats and skips fresh ones", async () => {
    // Given: one null heartbeat, one stale, one fresh
    const agents: DbRow[] = [
      { id: 1, agentId: "alpha", status: "online", lastHeartbeat: null },
      { id: 2, agentId: "beta", status: "busy", lastHeartbeat: new Date(NOW.getTime() - 24 * 3_600_000) },
      { id: 3, agentId: "gamma", status: "online", lastHeartbeat: new Date(NOW.getTime() - 60_000) },
    ];
    dbMocks.queueSelectResults([agents]);

    // When
    await sweepAgentWatchdog(mockDb, NOW);

    // Then: only the null/stale agents demoted, offline semantics in the audit
    expect(dbMocks.updateSets).toHaveLength(2);
    expect(dbMocks.updateSets.every((s) => s.status === "idle")).toBe(true);
    const audits = auditEvents().filter((e) => e.event === "agent:heartbeat_timeout");
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.entityId).sort()).toEqual([1, 2]);
    expect(audits.every((a) => (a.metadata as Readonly<Record<string, unknown>>).status === "offline")).toBe(true);
  });

  it("does nothing when the online/busy query returns no rows", async () => {
    // Given: no online or busy agents matched by the SQL filter
    dbMocks.queueSelectResults([[]]);

    // When
    await sweepAgentWatchdog(mockDb, NOW);

    // Then
    expect(dbMocks.updateSets).toHaveLength(0);
    expect(auditEvents()).toHaveLength(0);
  });
});

// ─── sweepApprovalNag ───
function approvalBlockedTask(
  options: { approval?: Readonly<Record<string, unknown>>; overrides?: Readonly<Record<string, unknown>> } = {}
): DbRow {
  const approval = {
    riskType: "zeabur_deploy",
    requestedByTaskId: "T-APPR-1",
    requestedByAgentId: "7",
    target: "Deploy production",
    preview: "deploy production",
    decision: "pending",
    ...(options.approval ?? {}),
  };
  const metadata = {
    traceId: "trc_appr_abcdefgh",
    taskType: "coding_task",
    origin: { system: "mcp" },
    routing: { candidateAgentIds: [], approvalRequired: true, riskTypes: ["zeabur_deploy"] },
    policies: {},
    knowledgeRefs: [],
    artifactRefs: [],
    approval,
  };
  return {
    id: 10,
    taskId: "T-APPR-1",
    name: "Deploy production",
    status: "pending",
    boardStatus: "blocked",
    blockedAt: new Date(NOW.getTime() - 2 * 24 * 3_600_000),
    agentId: 7,
    input: JSON.stringify({ metadata }),
    ...(options.overrides ?? {}),
  };
}

describe("sweepApprovalNag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.clearUpdateSets();
    auditMocks.events = [];
  });

  it("nags a stale approval task, notifies the agent, and writes lastNagAt", async () => {
    // Given: blocked 2 days, pending approval, no previous nag
    dbMocks.queueSelectResults([[approvalBlockedTask()]]);

    // When
    await sweepApprovalNag(mockDb, NOW);

    // Then: audit + mailbox + lastNagAt written back through metadata
    const audit = auditEvents().find((e) => e.event === "task:approval_stale");
    expect(audit).toBeDefined();
    expect(audit?.entityId).toBe(10);
    expect(notifyMocks.sendMailboxNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(notifyMocks.sendMailboxNotification).mock.calls[0][0];
    expect(call).toMatchObject({ fromAgentId: null, toAgentId: 7, taskId: 10, type: "review_request" });
    expect(dbMocks.updateSets).toHaveLength(1);
    const merged = String(dbMocks.updateSets[0]?.input ?? "");
    expect(merged).toContain("lastNagAt");
    expect(merged).toContain('"decision":"pending"');
  });

  it("skips a task nagged within the stale window (throttle)", async () => {
    // Given: last nag 1 hour ago (inside the 1-day window)
    const task = approvalBlockedTask({
      approval: { lastNagAt: new Date(NOW.getTime() - 3_600_000).toISOString() },
    });
    dbMocks.queueSelectResults([[task]]);

    // When
    await sweepApprovalNag(mockDb, NOW);

    // Then: no nag
    expect(auditEvents()).toHaveLength(0);
    expect(notifyMocks.sendMailboxNotification).not.toHaveBeenCalled();
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it("nags again when the previous nag is older than the stale window", async () => {
    // Given: last nag 2 days ago (older than the 1-day window)
    const task = approvalBlockedTask({
      approval: { lastNagAt: new Date(NOW.getTime() - 2 * 24 * 3_600_000).toISOString() },
    });
    dbMocks.queueSelectResults([[task]]);

    // When
    await sweepApprovalNag(mockDb, NOW);

    // Then: nagged again and lastNagAt refreshed
    expect(auditEvents()).toHaveLength(1);
    expect(notifyMocks.sendMailboxNotification).toHaveBeenCalledTimes(1);
    expect(dbMocks.updateSets).toHaveLength(1);
    expect(String(dbMocks.updateSets[0]?.input ?? "")).toContain("lastNagAt");
  });

  it("skips blocked tasks that are not approval-pending", async () => {
    // Given: approval already decided
    const task = approvalBlockedTask({ approval: { decision: "approved" } });
    dbMocks.queueSelectResults([[task]]);

    // When
    await sweepApprovalNag(mockDb, NOW);

    // Then
    expect(auditEvents()).toHaveLength(0);
    expect(notifyMocks.sendMailboxNotification).not.toHaveBeenCalled();
    expect(dbMocks.updateSets).toHaveLength(0);
  });

  it("still audits and writes lastNagAt when the task has no assigned agent", async () => {
    // Given: no agentId
    dbMocks.queueSelectResults([[approvalBlockedTask({ overrides: { agentId: null } })]]);

    // When
    await sweepApprovalNag(mockDb, NOW);

    // Then: audit + marker, but no mailbox notification
    expect(auditEvents()).toHaveLength(1);
    expect(notifyMocks.sendMailboxNotification).not.toHaveBeenCalled();
    expect(dbMocks.updateSets).toHaveLength(1);
  });
});

// ─── sweepMemoryCompensation ───
function completedTask(id: number, taskId: string): DbRow {
  return {
    id,
    taskId,
    name: `Task ${id}`,
    description: null,
    input: null,
    output: "ok",
    agentId: null,
    status: "done",
    lifecycleStatus: "completed",
    updatedAt: new Date(NOW.getTime() - 3_600_000),
  };
}

describe("sweepMemoryCompensation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    xuanjiMocks.syncTaskMemoryToXuanji.mockResolvedValue({ synced: true, reason: "written" as const });
  });

  it("syncs at most 5 completed tasks lacking a memory artifact, in order", async () => {
    // Given: 6 completed candidates, none with an artifact (6 dedup queries)
    const candidates = [1, 2, 3, 4, 5, 6].map((id) => completedTask(id, `T-M-${id}`));
    dbMocks.queueSelectResults([candidates, [], [], [], [], [], []]);

    // When
    await sweepMemoryCompensation(mockDb, NOW);

    // Then: exactly the first 5 synced, sequentially and deterministically
    expect(xuanjiMocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(5);
    const syncedIds = xuanjiMocks.syncTaskMemoryToXuanji.mock.calls.map((call) => (call[1] as Readonly<{ id: number }>).id);
    expect(syncedIds).toEqual([1, 2, 3, 4, 5]);
  });

  it("skips tasks that already have a xuanji_memory artifact", async () => {
    // Given: first candidate has an artifact, second does not
    const candidates = [completedTask(10, "T-HAS"), completedTask(11, "T-MISS")];
    dbMocks.queueSelectResults([candidates, [{ id: 999 }], []]);

    // When
    await sweepMemoryCompensation(mockDb, NOW);

    // Then: only the missing one is synced
    expect(xuanjiMocks.syncTaskMemoryToXuanji).toHaveBeenCalledTimes(1);
    const firstCall = xuanjiMocks.syncTaskMemoryToXuanji.mock.calls[0][1] as Readonly<{ id: number }>;
    expect(firstCall.id).toBe(11);
  });

  it("does not sync when there are no candidates", async () => {
    // Given
    dbMocks.queueSelectResults([[]]);

    // When
    await sweepMemoryCompensation(mockDb, NOW);

    // Then
    expect(xuanjiMocks.syncTaskMemoryToXuanji).not.toHaveBeenCalled();
  });
});

// ─── sweepNewApiPatrol ───
function fakeNewApiClient() {
  return {
    listModelChannels: vi.fn(async () => []),
    getChannelHealth: vi.fn(async () => ({ channels: [] })),
  };
}

describe("sweepNewApiPatrol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditMocks.events = [];
    newApiMocks.createNewApiClient.mockReset();
  });

  it("returns early when the tick is not a multiple of the patrol interval", async () => {
    // Given: tick 3, every 10 → skip
    // When
    await sweepNewApiPatrol(mockDb, NOW, 3);
    // Then: connector never touched
    expect(newApiMocks.createNewApiClient).not.toHaveBeenCalled();
    expect(auditEvents()).toHaveLength(0);
  });

  it("silently skips when the New API connector is unconfigured", async () => {
    // Given
    newApiMocks.createNewApiClient.mockReturnValue(null);
    // When
    await sweepNewApiPatrol(mockDb, NOW, 10);
    // Then: no audit
    expect(newApiMocks.createNewApiClient).toHaveBeenCalledTimes(1);
    expect(auditEvents()).toHaveLength(0);
  });

  it("calls the read-only channels/health listing without auditing on success", async () => {
    // Given
    const client = fakeNewApiClient();
    newApiMocks.createNewApiClient.mockReturnValue(client);
    // When
    await sweepNewApiPatrol(mockDb, NOW, 10);
    // Then
    expect(client.listModelChannels).toHaveBeenCalledTimes(1);
    expect(client.getChannelHealth).toHaveBeenCalledTimes(1);
    expect(auditEvents()).toHaveLength(0);
  });

  it("audits connector:patrol_failed when the health listing throws", async () => {
    // Given: connector reachable but the read fails
    const client = fakeNewApiClient();
    vi.mocked(client.getChannelHealth).mockRejectedValue(new Error("connection reset"));
    newApiMocks.createNewApiClient.mockReturnValue(client);
    // When
    await sweepNewApiPatrol(mockDb, NOW, 10);
    // Then: audit emitted, no error escaped
    const audit = auditEvents().find((e) => e.event === "connector:patrol_failed");
    expect(audit).toBeDefined();
    expect(audit?.entityType).toBe("connector");
    expect(audit?.metadata).toMatchObject({ connectorType: "newapi" });
  });
});
