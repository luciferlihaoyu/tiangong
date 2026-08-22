import { beforeEach, describe, expect, it, vi } from "vitest";

type DbRow = Readonly<Record<string, unknown>>;

// ─── Mock database（照搬 xuanji-sync.test.ts 的 chained select 模式）───
// syncTaskArtifactsToAlist 只用到两次 select（幂等检查 + artifacts 遍历）与一次 insert。
const dbMocks = vi.hoisted(() => {
  let selectResults: ReadonlyArray<ReadonlyArray<DbRow>> = [];
  const insertValues: ReadonlyArray<Readonly<Record<string, unknown>>> = [];

  const consumeSelectResult = (): ReadonlyArray<DbRow> => {
    const result = selectResults[0] ?? [];
    selectResults = selectResults.slice(1);
    return result;
  };

  const chained = (value: ReadonlyArray<DbRow>) => ({
    where: vi.fn(() => chained(value)),
    then: (onFulfilled: (rows: ReadonlyArray<DbRow>) => unknown) =>
      Promise.resolve(value).then(onFulfilled),
  });

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => chained(consumeSelectResult())),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((values: Readonly<Record<string, unknown>>) => {
        insertValues.push(values);
        return Promise.resolve({ insertId: 1 });
      }),
    })),
  };

  return {
    db,
    insertValues,
    queueSelectResults: (results: ReadonlyArray<ReadonlyArray<DbRow>>) => {
      selectResults = results;
    },
    clearAll: () => {
      insertValues.length = 0;
    },
  };
});

vi.mock("../../api/queries/connection", () => ({ getDb: () => dbMocks.db }));

// ─── Mock AList 连接器（resolveAlistConfig + alistUpload）───
const alistMocks = vi.hoisted(() => ({
  resolveAlistConfig: vi.fn(),
  alistUpload: vi.fn(),
}));

vi.mock("../../api/connectors/alist", () => ({
  resolveAlistConfig: alistMocks.resolveAlistConfig,
  alistUpload: alistMocks.alistUpload,
}));

import { syncTaskArtifactsToAlist, ALIST_SYNC_ARTIFACT_TYPE } from "../../api/lib/alist-sync";

const mockDb = dbMocks.db as unknown as Parameters<typeof syncTaskArtifactsToAlist>[0];

/** 生效的 AList 配置（basePath 默认根目录，autoUpload 开启） */
const CFG = {
  baseUrl: "https://alist.example.com",
  username: "tiangong",
  password: "secret",
  basePath: "/",
  autoUpload: true,
} as const;

/** input envelope（{ payload, metadata } 结构），importance 由调用方指定 */
function envelopeInput(importance: "normal" | "important"): string {
  return JSON.stringify({
    payload: "任务指令原文",
    metadata: {
      traceId: "trc_hl_00000001",
      taskType: "triage_task",
      origin: { system: "mcp" },
      routing: { candidateAgentIds: [], approvalRequired: false, riskTypes: [] },
      policies: {},
      knowledgeRefs: [],
      artifactRefs: [],
      importance,
    },
  });
}

/** 基准完成任务：名称/描述不含任何重要成果关键词 */
const baseTask = {
  id: 19,
  taskId: "T-HL-1",
  name: "Q3 数据整理",
  description: "整理数据表格",
  output: "# 整理结果\n\n数据齐了",
  agentId: 16,
} as const;

/** 收集 alistUpload 收到的 relPath 参数（按调用顺序） */
function uploadedPaths(): string[] {
  return alistMocks.alistUpload.mock.calls.map((call) => call[1] as string);
}

describe("syncTaskArtifactsToAlist importance highlights", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.clearAll();
    alistMocks.resolveAlistConfig.mockResolvedValue({ ...CFG });
    alistMocks.alistUpload.mockImplementation(async (_cfg: unknown, relPath: string) => relPath);
  });

  it("Given metadata explicitly marks importance=important, When sync runs, Then output.md plus a dated highlights copy are both uploaded", async () => {
    // Given: 显式 important 标记，名称不含关键词
    dbMocks.queueSelectResults([[], []]);

    // When
    const result = await syncTaskArtifactsToAlist(mockDb, {
      ...baseTask,
      input: envelopeInput("important"),
    });

    // Then: 两次上传——完整档案 + highlights 精华
    expect(result.synced).toBe(true);
    expect(result.reason).toBe("uploaded");
    const paths = uploadedPaths();
    expect(paths).toEqual(["/tasks/T-HL-1/output.md", expect.stringMatching(/^\/highlights\/\d{4}-\d{2}-\d{2}-T-HL-1-Q3 数据整理\.md$/)]);
    // alist_sync 幂等标记记录了全部上传路径（含 highlights）
    const marker = dbMocks.insertValues.find((v) => v.type === ALIST_SYNC_ARTIFACT_TYPE);
    expect(marker).toBeDefined();
    expect(String(marker?.jsonPayload ?? "")).toContain("/highlights/");
  });

  it("Given metadata marks importance=normal, When sync runs, Then only the tasks/ archive is uploaded without highlights", async () => {
    // Given
    dbMocks.queueSelectResults([[], []]);

    // When
    const result = await syncTaskArtifactsToAlist(mockDb, {
      ...baseTask,
      input: envelopeInput("normal"),
    });

    // Then: 只有主归档，无 highlights 调用
    expect(result.synced).toBe(true);
    expect(uploadedPaths()).toEqual(["/tasks/T-HL-1/output.md"]);
  });

  it("Given no metadata envelope but the task name contains 周报, When sync runs, Then keyword inference uploads a highlight under the configured basePath", async () => {
    // Given: input 是纯文本（无 envelope），名称命中关键词；basePath 为子目录
    alistMocks.resolveAlistConfig.mockResolvedValue({ ...CFG, basePath: "/115/天宫" });
    dbMocks.queueSelectResults([[], []]);

    // When
    const result = await syncTaskArtifactsToAlist(mockDb, {
      ...baseTask,
      id: 20,
      taskId: "T-HL-3",
      name: "本周工作周报",
      input: "写一份本周工作周报",
    });

    // Then: highlights 路径带 basePath 前缀
    expect(result.synced).toBe(true);
    const paths = uploadedPaths();
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe("/115/天宫/tasks/T-HL-3/output.md");
    expect(paths[1]).toMatch(/^\/115\/天宫\/highlights\/\d{4}-\d{2}-\d{2}-T-HL-3-本周工作周报\.md$/);
  });

  it("Given no metadata envelope but the task description contains 复盘, When sync runs, Then keyword inference still marks it important", async () => {
    // Given: 名称不含关键词，描述命中「复盘」
    dbMocks.queueSelectResults([[], []]);

    // When
    const result = await syncTaskArtifactsToAlist(mockDb, {
      ...baseTask,
      id: 21,
      taskId: "T-HL-4",
      name: "数据整理",
      description: "请对本次活动做一次复盘",
      input: null,
    });

    // Then
    expect(result.synced).toBe(true);
    expect(uploadedPaths().some((p) => p.includes("/highlights/"))).toBe(true);
  });

  it("Given AList is not configured, When sync runs, Then it returns not_configured without throwing", async () => {
    // Given
    alistMocks.resolveAlistConfig.mockResolvedValue(null);
    dbMocks.queueSelectResults([[], []]);

    // When
    const result = await syncTaskArtifactsToAlist(mockDb, {
      ...baseTask,
      input: envelopeInput("important"),
    });

    // Then
    expect(result).toEqual({ synced: false, reason: "not_configured" });
    expect(alistMocks.alistUpload).not.toHaveBeenCalled();
  });

  it("Given the highlights upload rejects, When sync runs, Then the main archive still succeeds and the highlight failure is non-fatal", async () => {
    // Given: output.md 成功，highlights 抛错
    alistMocks.alistUpload.mockImplementation(async (_cfg: unknown, relPath: string) => {
      if (relPath.includes("/highlights/")) throw new Error("highlights quota exceeded");
      return relPath;
    });
    dbMocks.queueSelectResults([[], []]);

    // When
    const result = await syncTaskArtifactsToAlist(mockDb, {
      ...baseTask,
      input: envelopeInput("important"),
    });

    // Then: 主归档照常成功，uploaded 只含 output.md
    expect(result.synced).toBe(true);
    expect(result.reason).toBe("uploaded");
    expect(result.uploaded).toEqual(["/tasks/T-HL-1/output.md"]);
    expect(dbMocks.insertValues.some((v) => v.type === ALIST_SYNC_ARTIFACT_TYPE)).toBe(true);
  });

  it("Given importance=important but output is empty, When sync runs, Then nothing is uploaded at all", async () => {
    // Given: 重要任务但无输出、无 artifacts
    dbMocks.queueSelectResults([[], []]);

    // When
    const result = await syncTaskArtifactsToAlist(mockDb, {
      ...baseTask,
      output: null,
      input: envelopeInput("important"),
    });

    // Then
    expect(result).toEqual({ synced: false, reason: "nothing_to_upload" });
    expect(alistMocks.alistUpload).not.toHaveBeenCalled();
  });

  it("Given a normal task with a stored artifact row, When sync runs, Then output.md and the artifact file are both uploaded (regression)", async () => {
    // Given: 一条文本产物行
    dbMocks.queueSelectResults([
      [], // 幂等检查：无 alist_sync 标记
      [
        {
          id: 77,
          taskId: 19,
          type: "text_result",
          name: "分析笔记",
          content: "笔记内容",
          jsonPayload: null,
          mimeType: null,
        },
      ],
    ]);

    // When
    const result = await syncTaskArtifactsToAlist(mockDb, { ...baseTask, input: envelopeInput("normal") });

    // Then: 主归档两件套，无 highlights
    expect(result.synced).toBe(true);
    expect(uploadedPaths()).toEqual(["/tasks/T-HL-1/output.md", "/tasks/T-HL-1/artifacts/分析笔记.txt"]);
  });
});
