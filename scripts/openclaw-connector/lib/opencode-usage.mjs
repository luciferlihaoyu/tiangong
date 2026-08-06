/**
 * Shared parsing / aggregation helpers for the OpenCode task runner.
 *
 * `opencode run --format json` emits one JSON object per line on stdout:
 *
 *   {"type":"step_start", ...}
 *   {"type":"text", ..., "part":{ "id","messageID","sessionID","type":"text","text","time" }}
 *   {"type":"step_finish", ..., "part":{
 *       "id","messageID","sessionID","type":"step-finish","reason",
 *       "tokens":{ "total","input","output","reasoning","cache":{ "read","write" } },
 *       "cost"
 *   }}
 *   {"type":"error", ..., "error":{...}}
 *
 * Token usage is carried on `step_finish` parts. We keep the LAST occurrence
 * per step-finish part id (opencode may re-publish a part update) and then sum
 * across every assistant step of the run. That sum is the real token usage.
 */

export const PROVIDER_ID = "newapi";

/** Build the OPENCODE_CONFIG_CONTENT provider definition for a New API gateway. */
export function buildProviderConfig({ baseURL, apiKey, modelId, providerId = PROVIDER_ID }) {
  const base = String(baseURL || "").replace(/\/+$/, "");
  return {
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "New API",
        options: {
          baseURL: `${base}/v1`,
          apiKey: apiKey || "",
        },
        models: {
          [modelId]: { name: modelId },
        },
      },
    },
    model: `${providerId}/${modelId}`,
  };
}

/** Parse a single stdout line as a JSON event. Returns null for non-JSON lines. */
export function parseEventLine(line) {
  if (!line || !line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse an opencode `--format json` stdout stream into its event buckets.
 * Non-JSON lines (e.g. stray log output) are skipped defensively.
 */
export function parseEventStream(stdout) {
  const textParts = [];
  const stepFinishes = [];
  const errors = [];
  for (const line of String(stdout || "").split("\n")) {
    const event = parseEventLine(line);
    if (!event) continue;
    switch (event.type) {
      case "text": {
        const part = event.part;
        if (part && typeof part.text === "string" && part.text) textParts.push(part.text);
        break;
      }
      case "step_finish": {
        if (event.part && typeof event.part.id === "string") stepFinishes.push(event.part);
        break;
      }
      case "error": {
        if (event.error) errors.push(event.error);
        break;
      }
      default:
        break;
    }
  }
  return { textParts, stepFinishes, errors };
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Aggregate REAL token usage from step_finish parts.
 * Dedupes by part id (last update wins), then sums across all steps.
 */
export function aggregateUsage(stepFinishes) {
  const byId = new Map();
  for (const part of stepFinishes) byId.set(part.id, part);

  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let stepCount = 0;

  for (const part of byId.values()) {
    const tokens = part.tokens;
    if (tokens && typeof tokens === "object") {
      stepCount += 1;
      const cache = tokens.cache && typeof tokens.cache === "object" ? tokens.cache : {};
      input += num(tokens.input);
      output += num(tokens.output);
      reasoning += num(tokens.reasoning);
      cacheRead += num(cache.read);
      cacheWrite += num(cache.write);
    }
    if (typeof part.cost === "number") cost += num(part.cost);
  }

  const promptTokens = input;
  const completionTokens = output;
  const cachedPromptTokens = cacheRead;
  const uncachedPromptTokens = Math.max(0, promptTokens - cacheRead);
  const totalTokens = input + output + reasoning + cacheRead + cacheWrite;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cachedPromptTokens,
    uncachedPromptTokens,
    reasoningTokens: reasoning,
    cacheWriteTokens: cacheWrite,
    cost,
    stepCount,
    hasRealUsage: stepCount > 0 && totalTokens > 0,
  };
}

/** Length-based estimate used only when the event stream carried no real usage. */
export function estimateUsage(prompt, result) {
  const promptTokens = Math.max(10, Math.floor(String(prompt || "").length / 3));
  const completionTokens = Math.max(5, Math.floor(String(result || "").length / 2));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedPromptTokens: 0,
    uncachedPromptTokens: promptTokens,
    reasoningTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    stepCount: 0,
    hasRealUsage: false,
  };
}

/** Build the usage.record payload shape accepted by Tiangong. */
export function buildUsagePayload({ usage, model, provider = "opencode", agentId, source = "opencode-runner", taskId }) {
  return {
    model,
    provider,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    cachedPromptTokens: usage.cachedPromptTokens,
    uncachedPromptTokens: usage.uncachedPromptTokens,
    callCount: 1,
    agentId,
    source,
    ...(Number.isInteger(taskId) && taskId > 0 ? { taskId } : {}),
  };
}
