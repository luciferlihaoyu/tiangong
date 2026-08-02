import { describe, expect, it, vi } from "vitest";

import { XuanjiConnectorClient, XuanjiConnectorError } from "../../api/connectors/xuanji/client";
import { createXuanjiClient } from "../../api/connectors/xuanji/service";
import { GetMemoryDigestRequestSchema, LinkArtifactRequestSchema, SearchContextRequestSchema, StartIngestionRequestSchema, WriteTaskMemoryRequestSchema, type GetMemoryDigestRequest, type GetMemoryDigestResponse, type LinkArtifactRequest, type SearchContextRequest, type SearchContextResponse, type StartIngestionRequest, type WriteTaskMemoryRequest } from "../../api/connectors/xuanji/types";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

type RecordedRequest = Readonly<{ url: string; init?: FetchInit }>;

const trace = { traceId: "trc_test_1234abcd", taskId: "TG-20260730-001", agentId: "tiangong-manager", originSystem: "tiangong" } satisfies SearchContextRequest["trace"];

const searchInput = {
  query: "分析 New API MCP 插件如何接入天宫",
  mode: "hybrid",
  limit: 8,
  filters: {
    project: "private-agent-terminal",
    tags: ["tiangong", "newapi", "xuanji"],
    types: ["document", "concept", "entity"],
  },
  trace,
} satisfies SearchContextRequest;

const searchResponse = {
  results: [{ kind: "document_chunk", documentId: 123, chunkId: 456, title: "New API MCP 接入与天宫平台瘦身设计报告", snippet: "New API 负责模型渠道、token、额度和日志...", score: 0.87, source: "kb" }],
  graphHints: [{ nodeId: 12, title: "New API", type: "entity" }],
  memoryDigest: "此前已决定 New API 替代 LiteLLM，天宫只做任务中转。",
} satisfies SearchContextResponse;

const writeInput = {
  task: { taskId: trace.taskId, traceId: trace.traceId, name: "New API MCP 接入设计", type: "architecture_design", status: "done", agentId: "opencode:main" },
  memory: {
    project: "private-agent-terminal",
    title: "New API MCP 接入设计完成记录",
    summary: "本任务确定 New API 作为模型网关。",
    contentMarkdown: "# 任务总结\n...",
    tags: ["newapi", "mcp", "tiangong", "architecture"],
    decisions: [{ title: "New API 替代 LiteLLM", reason: "已有可部署实例，且支持渠道、token、额度和日志。" }],
    artifacts: [{ type: "markdown_report", name: "newapi-mcp-tiangong-refactor-report.md", artifactRef: "tos://outputs/newapi-mcp-tiangong-refactor-report.md" }],
  },
  trace,
} satisfies WriteTaskMemoryRequest;

const linkInput = {
  documentId: 123,
  artifact: { artifactRef: "tos://outputs/report.md", downloadUrl: "https://example.com/tos/outputs/report.md", mimeType: "text/markdown", sha256: "a".repeat(64), size: 12345 },
  trace,
} satisfies LinkArtifactRequest;

const digestInput = {
  project: "private-agent-terminal",
  scope: "architecture",
  maxTokens: 2000,
  trace,
} satisfies GetMemoryDigestRequest;

const digestResponse = {
  digest: "当前架构决策：New API 管模型，天宫管任务，璇玑管知识...",
  keyDecisions: ["天宫是唯一任务控制面", "璇玑是唯一知识真实来源"],
  openRisks: ["New API 实例公开注册仍需关闭"],
  sourceDocumentIds: [123, 124],
} satisfies GetMemoryDigestResponse;

const ingestionInput = {
  sourceType: "datasource",
  source: { kind: "alist", path: "/tos/inbox/project-docs", dataSourceId: "alist-main" },
  options: { project: "private-agent-terminal", tags: ["imported", "alist"], vectorize: true, discoverRelations: true },
  trace,
} satisfies StartIngestionRequest;

function trpcResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ result: { data } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function bodyText(init: FetchInit): string {
  if (typeof init?.body === "string") {
    return init.body;
  }
  return "";
}

describe("Xuanji connector", () => {
  it("Given contract inputs, When parsed, Then all five request schemas require trace context", () => {
    // Given
    const expectedTrace = trace;

    // When
    const parsedSearch = SearchContextRequestSchema.parse(searchInput);
    const parsedWrite = WriteTaskMemoryRequestSchema.parse(writeInput);
    const parsedLink = LinkArtifactRequestSchema.parse(linkInput);
    const parsedDigest = GetMemoryDigestRequestSchema.parse(digestInput);
    const parsedIngestion = StartIngestionRequestSchema.parse(ingestionInput);

    // Then
    expect(parsedSearch.trace).toEqual(expectedTrace);
    expect(parsedWrite.trace).toEqual(expectedTrace);
    expect(parsedLink.trace).toEqual(expectedTrace);
    expect(parsedDigest.trace).toEqual(expectedTrace);
    expect(parsedIngestion.trace).toEqual(expectedTrace);
  });

  it("Given a mock fetch, When searchContext runs, Then it issues a tRPC GET with input query parameter", async () => {
    // Given
    let recordedRequest: RecordedRequest | null = null;
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      recordedRequest = { url: requestUrl(input), init };
      return trpcResponse(searchResponse);
    });
    const client = new XuanjiConnectorClient({
      baseUrl: "https://xuanji.example.com/",
      apiKey: "test-secret-ref",
      fetchImpl: fetchMock,
    });

    // When
    const result = await client.searchContext(searchInput);

    // Then
    expect(result).toEqual(searchResponse);
    const expectedUrl = new URL("https://xuanji.example.com/api/trpc/connector.searchContext");
    expectedUrl.searchParams.set("input", JSON.stringify({ json: searchInput }));
    expect(recordedRequest?.url).toBe(expectedUrl.href);
    expect(recordedRequest?.init?.method).toBe("GET");
    expect(recordedRequest?.init?.body).toBeUndefined();
    const headers = new Headers(recordedRequest?.init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(headers.get("Authorization")).toBe("Bearer test-secret-ref");
  });

  it("Given a mock fetch, When writeTaskMemory runs, Then it issues a tRPC POST with json body", async () => {
    // Given
    let recordedRequest: RecordedRequest | null = null;
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      recordedRequest = { url: requestUrl(input), init };
      return trpcResponse({
        documentId: 123,
        nodeIds: [12, 13, 14],
        edgeIds: [31, 32],
        chunkCount: 9,
        vectorized: true,
      });
    });
    const client = new XuanjiConnectorClient({
      baseUrl: "https://xuanji.example.com/",
      apiKey: "test-secret-ref",
      fetchImpl: fetchMock,
    });

    // When
    const result = await client.writeTaskMemory(writeInput);

    // Then
    expect(result.documentId).toBe(123);
    expect(recordedRequest?.url).toBe("https://xuanji.example.com/api/trpc/connector.writeTaskMemory");
    expect(recordedRequest?.init?.method).toBe("POST");
    const headers = new Headers(recordedRequest?.init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Requested-With")).toBe("XMLHttpRequest");
    expect(headers.get("Authorization")).toBe("Bearer test-secret-ref");
    const rawBody: unknown = JSON.parse(bodyText(recordedRequest?.init));
    expect(rawBody).toEqual({ json: writeInput });
  });

  it("Given a tRPC envelope, When getMemoryDigest runs, Then the client unwraps result data", async () => {
    // Given
    const fetchMock = vi.fn(async () => trpcResponse(digestResponse));
    const client = new XuanjiConnectorClient({
      baseUrl: "https://xuanji.example.com",
      apiKey: "test-secret-ref",
      fetchImpl: fetchMock,
    });

    // When
    const result = await client.getMemoryDigest(digestInput);

    // Then
    expect(result).toEqual(digestResponse);
  });

  it("Given an HTTP 500 response, When the client calls Xuanji, Then it throws a typed connector error", async () => {
    // Given
    const fetchMock = vi.fn(async () => new Response("server failed", { status: 500 }));
    const client = new XuanjiConnectorClient({
      baseUrl: "https://xuanji.example.com",
      apiKey: "test-secret-ref",
      fetchImpl: fetchMock,
    });

    // When
    let threwTypedError = false;
    try {
      await client.searchContext(searchInput);
    } catch (error) {
      if (error instanceof XuanjiConnectorError) {
        threwTypedError = true;
        expect(error.code).toBe("http_error");
        expect(error.status).toBe(500);
      } else {
        throw error;
      }
    }

    // Then
    expect(threwTypedError).toBe(true);
  });

  it("Given a network rejection, When the client calls Xuanji, Then it maps the failure to a typed error", async () => {
    // Given
    const fetchMock = vi.fn(async () => {
      throw new TypeError("connection reset");
    });
    const client = new XuanjiConnectorClient({
      baseUrl: "https://xuanji.example.com",
      apiKey: "test-secret-ref",
      fetchImpl: fetchMock,
    });

    // When
    let threwTypedError = false;
    try {
      await client.getMemoryDigest(digestInput);
    } catch (error) {
      if (error instanceof XuanjiConnectorError) {
        threwTypedError = true;
        expect(error.code).toBe("network_error");
      } else {
        throw error;
      }
    }

    // Then
    expect(threwTypedError).toBe(true);
  });

  it("Given a short timeout, When fetch observes abort, Then the client returns a network typed error", async () => {
    // Given
    const fetchMock = vi.fn((_input: FetchInput, init?: FetchInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new TypeError("missing abort signal"));
        return;
      }
      const rejectAbort = () => reject(new TypeError("aborted"));
      if (signal.aborted) {
        rejectAbort();
        return;
      }
      signal.addEventListener("abort", rejectAbort, { once: true });
    }));
    const client = new XuanjiConnectorClient({
      baseUrl: "https://xuanji.example.com",
      apiKey: "test-secret-ref",
      timeoutMs: 1,
      fetchImpl: fetchMock,
    });

    // When
    let threwTypedError = false;
    try {
      await client.startIngestion(ingestionInput);
    } catch (error) {
      if (error instanceof XuanjiConnectorError) {
        threwTypedError = true;
        expect(error.code).toBe("network_error");
      } else {
        throw error;
      }
    }

    // Then
    expect(threwTypedError).toBe(true);
  });

  it("Given no Xuanji base URL, When the service factory runs, Then it returns null", () => {
    // Given
    const config = { baseUrl: "" };

    // When
    const client = createXuanjiClient(config);

    // Then
    expect(client).toBeNull();
  });
});
