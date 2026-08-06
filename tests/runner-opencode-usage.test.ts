import { describe, it, expect } from "vitest";
import {
  PROVIDER_ID,
  buildProviderConfig,
  parseEventLine,
  parseEventStream,
  aggregateUsage,
  estimateUsage,
  buildUsagePayload,
} from "../scripts/openclaw-connector/lib/opencode-usage.mjs";

function stepFinish(id, tokens) {
  return JSON.stringify({
    type: "step_finish",
    timestamp: Date.now(),
    sessionID: "ses_test",
    part: { id, messageID: `msg_${id}`, sessionID: "ses_test", type: "step-finish", reason: "stop", tokens },
  });
}

describe("buildProviderConfig", () => {
  it("builds an openai-compatible provider definition pointing at {base}/v1", () => {
    const cfg = buildProviderConfig({
      baseURL: "https://woppis1.zeabur.app",
      apiKey: "sk-test",
      modelId: "deepseek-v4-flash",
    });
    expect(cfg.model).toBe("newapi/deepseek-v4-flash");
    const provider = cfg.provider[PROVIDER_ID];
    expect(provider).toBeDefined();
    expect(provider.npm).toBe("@ai-sdk/openai-compatible");
    expect(provider.options.baseURL).toBe("https://woppis1.zeabur.app/v1");
    expect(provider.options.apiKey).toBe("sk-test");
    expect(provider.models["deepseek-v4-flash"]).toEqual({ name: "deepseek-v4-flash" });
  });

  it("strips trailing slashes from the base URL", () => {
    const cfg = buildProviderConfig({ baseURL: "https://example.com/", apiKey: "k", modelId: "m" });
    expect(cfg.provider.newapi.options.baseURL).toBe("https://example.com/v1");
  });
});

describe("parseEventStream", () => {
  it("extracts text parts, step_finish parts and error events", () => {
    const stdout = [
      JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "s", part: { id: "p0" } }),
      JSON.stringify({ type: "text", timestamp: 2, sessionID: "s", part: { id: "t1", messageID: "m", type: "text", text: "Hello" } }),
      stepFinish("sf1", { total: 170, input: 100, output: 50, reasoning: 20, cache: { read: 30, write: 10 } }),
      JSON.stringify({ type: "text", timestamp: 3, sessionID: "s", part: { id: "t2", messageID: "m2", type: "text", text: "World" } }),
      JSON.stringify({ type: "error", timestamp: 4, sessionID: "s", error: { message: "boom" } }),
      "not json at all",
      JSON.stringify({ type: "tool_use", timestamp: 5, sessionID: "s", part: { id: "tool1" } }),
    ].join("\n");

    const { textParts, stepFinishes, errors } = parseEventStream(stdout);
    expect(textParts).toEqual(["Hello", "World"]);
    expect(stepFinishes).toHaveLength(1);
    expect(stepFinishes[0].tokens.input).toBe(100);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("boom");
  });

  it("returns empty buckets for empty or malformed input", () => {
    const { textParts, stepFinishes, errors } = parseEventStream("");
    expect(textParts).toEqual([]);
    expect(stepFinishes).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("parseEventLine returns null for non-JSON lines", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("random text")).toBeNull();
    expect(parseEventLine('{"type":"text"}')).toMatchObject({ type: "text" });
  });
});

describe("aggregateUsage", () => {
  it("sums real tokens across steps, deduping by part id (last wins)", () => {
    const steps = [
      // first update for step A
      stepFinish("A", { total: 170, input: 100, output: 50, reasoning: 20, cache: { read: 30, write: 10 } }),
      // second update for step A — must win
      stepFinish("A", { total: 180, input: 110, output: 55, reasoning: 20, cache: { read: 30, write: 10 } }),
      // step B
      stepFinish("B", { total: 300, input: 200, output: 80, reasoning: 0, cache: { read: 50, write: 20 } }),
    ];
    const parsed = parseEventStream(steps.join("\n"));
    const usage = aggregateUsage(parsed.stepFinishes);

    expect(usage.stepCount).toBe(2);
    expect(usage.promptTokens).toBe(310); // 110 + 200
    expect(usage.completionTokens).toBe(135); // 55 + 80
    expect(usage.cachedPromptTokens).toBe(80); // 30 + 50
    expect(usage.uncachedPromptTokens).toBe(230); // 310 - 80
    expect(usage.reasoningTokens).toBe(20);
    expect(usage.cacheWriteTokens).toBe(30); // 10 + 20
    // opencode total = input + output + reasoning + cache.read + cache.write
    // step A (deduped, last update): 110 + 55 + 20 + 30 + 10 = 225
    // step B: 200 + 80 + 0 + 50 + 20 = 350
    expect(usage.totalTokens).toBe(225 + 350);
    expect(usage.hasRealUsage).toBe(true);
  });

  it("marks usage as unreal when no step_finish carries tokens", () => {
    const empty = aggregateUsage([]);
    expect(empty.hasRealUsage).toBe(false);
    expect(empty.totalTokens).toBe(0);

    const noTokens = parseEventStream(
      JSON.stringify({ type: "step_finish", timestamp: 1, sessionID: "s", part: { id: "x", type: "step-finish" } })
    );
    const usage = aggregateUsage(noTokens.stepFinishes);
    expect(usage.hasRealUsage).toBe(false);
    expect(usage.stepCount).toBe(0);
  });

  it("ignores missing cache objects and partial token fields", () => {
    const stdout = stepFinish("C", { input: 10, output: 5 });
    const usage = aggregateUsage(parseEventStream(stdout).stepFinishes);
    expect(usage.promptTokens).toBe(10);
    expect(usage.completionTokens).toBe(5);
    expect(usage.cachedPromptTokens).toBe(0);
    expect(usage.uncachedPromptTokens).toBe(10);
    expect(usage.totalTokens).toBe(15);
    expect(usage.hasRealUsage).toBe(true);
  });
});

describe("estimateUsage", () => {
  it("produces the legacy length-based fallback with hasRealUsage=false", () => {
    const usage = estimateUsage("abcdefghij", "hello world");
    expect(usage.hasRealUsage).toBe(false);
    expect(usage.promptTokens).toBeGreaterThanOrEqual(10);
    expect(usage.cachedPromptTokens).toBe(0);
    expect(usage.totalTokens).toBe(usage.promptTokens + usage.completionTokens);
  });
});

describe("buildUsagePayload", () => {
  it("shapes the payload exactly like usage.record expects", () => {
    const usage = {
      promptTokens: 310,
      completionTokens: 135,
      totalTokens: 480,
      cachedPromptTokens: 80,
      uncachedPromptTokens: 230,
    };
    const payload = buildUsagePayload({
      usage,
      model: "newapi/deepseek-v4-flash",
      provider: "opencode",
      agentId: 16,
      source: "opencode-runner",
      taskId: 42,
    });
    expect(payload).toEqual({
      model: "newapi/deepseek-v4-flash",
      provider: "opencode",
      promptTokens: 310,
      completionTokens: 135,
      totalTokens: 480,
      cachedPromptTokens: 80,
      uncachedPromptTokens: 230,
      callCount: 1,
      agentId: 16,
      source: "opencode-runner",
      taskId: 42,
    });
  });

  it("omits taskId when not a positive integer", () => {
    const payload = buildUsagePayload({
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cachedPromptTokens: 0, uncachedPromptTokens: 1 },
      model: "m",
      agentId: 1,
    });
    expect(payload.taskId).toBeUndefined();
  });
});
