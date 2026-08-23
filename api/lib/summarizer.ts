/**
 * 任务 3.2：协作汇总报告 LLM 总结增强（可选，默认关）
 *
 * 在 autoSummarizeCollab 生成机械汇总前，先用一次天枢 LLM 调用对全部子任务
 * 输出生成一段两到三句话总结（中文），插在汇总文本头部。
 *
 * 关键设计约束：
 *   - 默认关闭（TIANGONG_SUMMARY_LLM_ENABLED=true 才走 LLM 路径）——开关注解见
 *     task-validator.ts 的 autoSummarizeCollab，本模块不感知开关
 *   - 永不抛错：未配置 / 超时 / 解析失败 / 网络异常 一律 console.warn 后返回 null，
 *     调用方据此降级到原机械模板，零失败风险
 *   - 单次调用：所有子任务合一次 prompt，不是每子任务一次（控制成本）
 *   - 不记账：本模块只返回 {text, usage, model}；调用方按需 recordExternalUsage，
 *     便于 mock 测试与未来升级记账口径时改动面最小
 *
 * 复用 task-runner.executeTianshu 的同款 OpenAI 兼容调用约定（POST
 * {base}/v1/chat/completions, Bearer token, stream:false）；区别在于本路径：
 *   - 超时上限更短：30s（主 Runner 默认 120s，summary 任务短 prompt 30s 充裕）
 *   - 提示词为系统/用户两条结构化消息（主 Runner 单 user 消息）
 *   - 不做 recordTianshuUsage（调用方按需决定）
 */

// ─── 公开类型 ───

/** 子任务摘要（call site 准备的最小视图） */
export type ChildSummary = Readonly<{
  taskId: string;
  name: string;
  status: "done" | "failed";
  output: string | null;
  error: string | null;
}>;

/** LLM 用量（兼容 OpenAI 兼容接口常见字段） */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
}

/** 单次 LLM 调用结果（含模型与用量，供记账） */
export interface SummarizerResult {
  text: string;
  usage: LlmUsage;
  model: string;
}

// ─── 常量 ───

/** 子任务 output 截断长度（字符数），避免长输出撑爆 prompt 上下文 */
const CHILD_OUTPUT_MAX_CHARS = 1000;
/** 3.2 路径超时上限（ms），比主 Runner 默认 120s 短——summary 任务 prompt 小、响应应快 */
const SUMMARY_TIMEOUT_CAP_MS = 30_000;
/** 主 Runner 默认超时，回退值 */
const DEFAULT_TIANSHU_TIMEOUT_MS = 120_000;
/**
 * 响应 token 上限（3.2 评审 minor 防御）：
 * 500 token 对两到三句话中文总结绰绰有余（约 750~1000 个中文字符），
 * 既能挡住模型"自动续写长篇报告"的不可控行为，也能在 prompt 异常时
 * 把单次调用成本压在天枢计费可控范围。汇总场景对长度零容忍，截断就截断。
 */
const SUMMARY_MAX_TOKENS = 500;

// ─── 提示词模板（中文，针对协作汇总场景）───

const SYSTEM_PROMPT = [
  "你是协作任务汇总助手。",
  "用户会给出一组子任务的结果（每条含 taskKey / name / status / output / error）。",
  "请基于这些信息生成两到三句话的中文总结，重点：核心结果、异常（如有）、子任务之间的相互关系。",
  "不要列点、不要使用 Markdown 标题或列表、不要复述每条输出的细节。",
  "只输出一段连贯的纯文本总结。",
].join("");

function buildUserPrompt(childSummaries: readonly ChildSummary[]): string {
  const items = childSummaries.map((c) => ({
    taskKey: c.taskId,
    name: c.name,
    status: c.status,
    output: c.output ? c.output.slice(0, CHILD_OUTPUT_MAX_CHARS) : null,
    error: c.error,
  }));
  return [
    `下面是 ${childSummaries.length} 个子任务的结果（JSON）：`,
    JSON.stringify(items, null, 2),
    "",
    "请输出一段两到三句话的中文总结，纯文本，不要 Markdown 标题或列表。",
  ].join("\n");
}

// ─── 入口 ───

/**
 * 调一次天枢 LLM 为子任务列表生成两到三句中文总结。
 * 任何异常/未配置/解析失败一律返回 null（永不抛错），由调用方决定如何降级。
 */
export async function summarizeCollabWithTianshu(
  childSummaries: readonly ChildSummary[]
): Promise<SummarizerResult | null> {
  // 0) 空列表视为配置错误直接返回 null（调用方亦会因 0 子任务 no-op 早退，仅作保险）
  if (childSummaries.length === 0) return null;

  // 1) 配置检查
  const apiKey = (process.env.TIANSHU_API_KEY ?? "").trim();
  if (!apiKey) {
    console.warn("[summarizer] TIANSHU_API_KEY 未配置，跳过 LLM 总结");
    return null;
  }
  const model = (process.env.TIANGONG_SUMMARY_MODEL ?? "").trim() || (process.env.TIANSHU_MODEL ?? "").trim();
  if (!model) {
    console.warn("[summarizer] 未配置模型（TIANGONG_SUMMARY_MODEL / TIANSHU_MODEL），跳过 LLM 总结");
    return null;
  }

  // 2) endpoint 构造（剥尾斜杠，与 task-runner 一致）
  const base = (process.env.TIANSHU_BASE_URL ?? "https://woppis1.zeabur.app").replace(/\/+$/, "");
  let endpoint: URL;
  try {
    endpoint = new URL(`${base}/v1/chat/completions`);
  } catch {
    console.warn("[summarizer] TIANSHU_BASE_URL 非法，跳过 LLM 总结");
    return null;
  }

  // 3) 超时：取 30s 上限与配置 TIANSHU_TIMEOUT_MS 较小者（默认 120s 下取 30s）
  const configuredTimeout = parseInt(process.env.TIANSHU_TIMEOUT_MS ?? "", 10);
  const effectiveTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(SUMMARY_TIMEOUT_CAP_MS, configuredTimeout)
    : Math.min(SUMMARY_TIMEOUT_CAP_MS, DEFAULT_TIANSHU_TIMEOUT_MS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveTimeout);

  try {
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(childSummaries) },
        ],
        stream: false,
        // 防御性 token 上限（见 SUMMARY_MAX_TOKENS 注释）
        max_tokens: SUMMARY_MAX_TOKENS,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      console.warn(`[summarizer] 天枢 HTTP ${resp.status}，跳过 LLM 总结`);
      return null;
    }

    const raw = await resp.text();
    return parseSummarizerResponse(raw, model);
  } catch (e) {
    const isAbort = typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
    console.warn(
      `[summarizer] 天枢调用${isAbort ? `超时（${effectiveTimeout}ms）` : "失败"}: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 内部：响应解析（拆出便于单测）───

/**
 * 从天枢 OpenAI 兼容响应 raw JSON 中提取文本与 usage。
 * 文本空 → null；usage 缺失按 0 处理（不阻断文本返回）。
 */
function parseSummarizerResponse(raw: string, model: string): SummarizerResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[summarizer] 响应非 JSON，跳过 LLM 总结");
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    console.warn("[summarizer] 响应不是对象，跳过 LLM 总结");
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  // 1) 文本
  let text = "";
  const choices = obj.choices;
  if (Array.isArray(choices)) {
    const texts = choices
      .map((c) => {
        if (!c || typeof c !== "object") return "";
        const cc = c as Record<string, unknown>;
        const message = cc.message as Record<string, unknown> | undefined;
        const fromMessage = typeof message?.content === "string" ? message.content : "";
        const fromDelta = typeof (cc.delta as Record<string, unknown> | undefined)?.content === "string"
          ? ((cc.delta as Record<string, unknown>).content as string)
          : "";
        return fromMessage || fromDelta;
      })
      .filter((t) => typeof t === "string" && t.trim().length > 0);
    if (texts.length > 0) text = texts.join("\n");
  }
  // 兜底字段（与 task-runner.extractChatCompletionText 同款）
  if (!text && typeof obj.text === "string") text = obj.text;
  if (!text && typeof obj.reply === "string") text = obj.reply;

  text = text.trim();
  if (!text) {
    console.warn("[summarizer] 响应文本为空，跳过 LLM 总结");
    return null;
  }

  // 2) usage（尽力解析，缺失不阻断）
  const usage = extractUsage(obj.usage);

  return { text, usage, model };
}

/** 解析 OpenAI 兼容 usage：兼容 prompt_cache_hit_tokens / cached_tokens / prompt_tokens_details.cached_tokens */
function extractUsage(rawUsage: unknown): LlmUsage {
  if (!rawUsage || typeof rawUsage !== "object") {
    return { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
  }
  const u = rawUsage as Record<string, unknown>;
  const promptTokens = Number(u.prompt_tokens ?? 0) || 0;
  const completionTokens = Number(u.completion_tokens ?? 0) || 0;
  // 缓存命中：兼容三种常见字段名（DeepSeek / New API / OpenAI 风格）
  const details = u.prompt_tokens_details;
  const cachedFromDetails = details && typeof details === "object" ? (details as Record<string, unknown>).cached_tokens : undefined;
  const cachedPromptTokens = Number(
    u.prompt_cache_hit_tokens ?? u.cached_tokens ?? cachedFromDetails ?? 0
  ) || 0;
  return { promptTokens, completionTokens, cachedPromptTokens };
}
