/**
 * 任务 3.2：summarizeCollabWithTianshu 单元测试
 *
 * 不 mock summarizer 模块本身，直接覆盖真实实现以验证：
 *   - 未配置（TIANSHU_API_KEY 缺）→ null，不抛错
 *   - 模型缺失（TIANGONG_SUMMARY_MODEL / TIANSHU_MODEL 都缺）→ null
 *   - fetch 抛错（超时 / 网络异常）→ null，不抛错
 *   - fetch 返回 200 + 标准 OpenAI usage → 文本与 usage 正确提取
 *   - fetch 返回空文本 → null
 *   - 子任务 output 超长 → 截断到 1000 字符
 *
 * 与 collab-summary-llm.test.ts 分离的原因：后者顶层 vi.mock 整个 summarizer
 * 模块覆盖集成测试，单元测试必须拿到真实实现，故独立文件。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeCollabWithTianshu, type ChildSummary } from "../../api/lib/summarizer";

const SAMPLE_CHILD: ChildSummary = {
  taskId: "C1",
  name: "子任务一",
  status: "done",
  output: "ok",
  error: null,
};

describe("summarizeCollabWithTianshu 单元", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("Given TIANSHU_API_KEY 未配置, When summarizeCollabWithTianshu, Then 返回 null 不抛错", async () => {
    // Given: 全部相关 env 缺
    vi.stubEnv("TIANSHU_API_KEY", "");
    vi.stubEnv("TIANSHU_BASE_URL", "https://example.com");
    vi.stubEnv("TIANGONG_SUMMARY_MODEL", "deepseek-v3");

    // When
    const result = await summarizeCollabWithTianshu([SAMPLE_CHILD]);

    // Then
    expect(result).toBeNull();
  });

  it("Given 已配置 + 模型缺失, When summarizeCollabWithTianshu, Then 返回 null", async () => {
    // Given
    vi.stubEnv("TIANSHU_API_KEY", "test-key");
    vi.stubEnv("TIANSHU_BASE_URL", "https://example.com");
    vi.stubEnv("TIANGONG_SUMMARY_MODEL", "");
    vi.stubEnv("TIANSHU_MODEL", "");

    // When
    const result = await summarizeCollabWithTianshu([SAMPLE_CHILD]);

    // Then: 模型未配置时静默返回 null
    expect(result).toBeNull();
  });

  it("Given 已配置 + fetch 抛错（超时 / 网络异常）, When summarizeCollabWithTianshu, Then 不抛错返回 null", async () => {
    // Given
    vi.stubEnv("TIANSHU_API_KEY", "test-key");
    vi.stubEnv("TIANSHU_BASE_URL", "https://example.com");
    vi.stubEnv("TIANGONG_SUMMARY_MODEL", "deepseek-v3");
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    // When
    const result = await summarizeCollabWithTianshu([SAMPLE_CHILD]);

    // Then: 永不抛错、返回 null
    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Given 已配置 + fetch 返回 200 + 标准 OpenAI usage, When summarizeCollabWithTianshu, Then 文本与 usage 正确提取", async () => {
    // Given
    vi.stubEnv("TIANSHU_API_KEY", "test-key");
    vi.stubEnv("TIANSHU_BASE_URL", "https://example.com/"); // 尾斜杠
    vi.stubEnv("TIANGONG_SUMMARY_MODEL", "deepseek-v3");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "整体结论良好" } }],
          usage: {
            prompt_tokens: 250,
            completion_tokens: 60,
            prompt_cache_hit_tokens: 100,
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // When
    const result = await summarizeCollabWithTianshu([
      SAMPLE_CHILD,
      { taskId: "C2", name: "子任务二", status: "failed", output: null, error: "boom" },
    ]);

    // Then
    expect(result).not.toBeNull();
    expect(result?.text).toBe("整体结论良好");
    expect(result?.model).toBe("deepseek-v3");
    expect(result?.usage).toEqual({
      promptTokens: 250,
      completionTokens: 60,
      cachedPromptTokens: 100,
    });
    // Then: endpoint 构造：剥尾斜杠
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toBe("https://example.com/v1/chat/completions");
    // Then: body 包含 stream:false + system/user 两条消息 + 两条子任务
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.model).toBe("deepseek-v3");
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    const userContent = body.messages[1].content as string;
    expect(userContent).toContain("C1");
    expect(userContent).toContain("C2");
    // Then: Bearer token
    expect(call?.[1]?.headers?.authorization).toBe("Bearer test-key");
  });

  it("Given 已配置 + fetch 返回空文本（仅空白）, When summarizeCollabWithTianshu, Then 返回 null", async () => {
    // Given
    vi.stubEnv("TIANSHU_API_KEY", "test-key");
    vi.stubEnv("TIANSHU_BASE_URL", "https://example.com");
    vi.stubEnv("TIANGONG_SUMMARY_MODEL", "deepseek-v3");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "   " } }], // 全空白
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
    }));

    // When
    const result = await summarizeCollabWithTianshu([SAMPLE_CHILD]);

    // Then: 空白文本视为空 → null
    expect(result).toBeNull();
  });

  it("Given 已配置 + 子任务 output 超长, When summarizeCollabWithTianshu, Then 截断到 1000 字符", async () => {
    // Given
    vi.stubEnv("TIANSHU_API_KEY", "test-key");
    vi.stubEnv("TIANSHU_BASE_URL", "https://example.com");
    vi.stubEnv("TIANGONG_SUMMARY_MODEL", "deepseek-v3");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // When: output 远超 1000 字
    const longOutput = "x".repeat(5000);
    await summarizeCollabWithTianshu([
      { taskId: "C1", name: "子一", status: "done", output: longOutput, error: null },
    ]);

    // Then: user prompt 中 output 字段被截断到 1000
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const userContent = body.messages[1].content as string;
    // 提取中间那段 JSON 数组（prefix + JSON + suffix 的三段结构）
    const jsonMatch = userContent.match(/\[[\s\S]*\]/);
    expect(jsonMatch).not.toBeNull();
    const parsed = JSON.parse(jsonMatch![0]) as Array<{ output: string }>;
    expect(parsed[0].output.length).toBe(1000);
  });

  it("Given TIANSHU_BASE_URL 非法, When summarizeCollabWithTianshu, Then 返回 null", async () => {
    // Given
    vi.stubEnv("TIANSHU_API_KEY", "test-key");
    vi.stubEnv("TIANSHU_BASE_URL", "not a url with spaces ::: :::");
    vi.stubEnv("TIANGONG_SUMMARY_MODEL", "deepseek-v3");

    // When
    const result = await summarizeCollabWithTianshu([SAMPLE_CHILD]);

    // Then: URL 非法静默返回 null
    expect(result).toBeNull();
  });

  it("Given 已配置 + fetch HTTP 4xx, When summarizeCollabWithTianshu, Then 返回 null 不抛错", async () => {
    // Given
    vi.stubEnv("TIANSHU_API_KEY", "test-key");
    vi.stubEnv("TIANSHU_BASE_URL", "https://example.com");
    vi.stubEnv("TIANGONG_SUMMARY_MODEL", "deepseek-v3");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: "unauthorized" } }),
    }));

    // When
    const result = await summarizeCollabWithTianshu([SAMPLE_CHILD]);

    // Then: HTTP 非 2xx 静默返回 null
    expect(result).toBeNull();
  });

  it("Given 已配置 + 子任务列表为空, When summarizeCollabWithTianshu, Then 返回 null", async () => {
    // Given
    vi.stubEnv("TIANSHU_API_KEY", "test-key");
    vi.stubEnv("TIANSHU_BASE_URL", "https://example.com");
    vi.stubEnv("TIANGONG_SUMMARY_MODEL", "deepseek-v3");

    // When
    const result = await summarizeCollabWithTianshu([]);

    // Then: 保险性早退（autoSummarizeCollab 自身也会 no-op）
    expect(result).toBeNull();
  });
});
