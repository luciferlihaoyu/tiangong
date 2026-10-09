#!/usr/bin/env node
//
// 天宫 Connector Runner — 通过 OpenClaw Gateway 真实执行任务
//
// connector 从 stdin 传入天宫任务 prompt；本 runner 将 prompt 转发给对应
// OpenClaw agent 的 main session，等待 Agent 回复后把结果输出给天宫。
//
// v2（2026-10-09 碧霄补丁）：修复"投完即逃"缺陷。
//   旧版只调 sessions.send，gateway 永远秒回 {status:"started"}，runner 把
//   started 当中间态 exit(2) → connector 置 awaiting_result → 回复烂在
//   session 里没人收 → 任务超时重派（且 agentId 被 sweeper 清空）→
//   TaskRunner 抢走假完成（#101/#102/#103 三案同因）。
//
//   v2 流程（基于 2026-10-09 婉儿接口核验报告）：
//     1. sessions.send {key, message}        → {runId, status, messageSeq}
//     2. agent.wait {runId, timeoutMs} 分段轮询 → 终态 {runId, status, ...}
//        （成功终态字面值未知——宽松判定：非 started/running/queued/timeout 即终态）
//     3. chat.history {sessionKey, limit}    → messages[] + sessionInfo
//        提取 send 时刻之后、role=assistant、content 含 type=text 的最后一条。
//        心跳消息（heartbeat_respond）全是 toolCall，天然被 text 过滤排除。
//     4. 兜底：总期限耗尽仍无文本 → 返回 "started" → 外层 exit(2) 保持旧
//        awaiting_result 语义（今后几乎不会再走到）。
//   注意：agent.wait 的 runId 只在 gateway terminal cache 里短期有效，
//   必须 send 后立即 wait，不能事后补查（婉儿实测旧 runId 会 timeout 失效）。
//

import { execSync } from "node:child_process";

const GATEWAY_TOKEN = process.env.TIANGONG_OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "";

// 天宫 API URL（用于 Agent 结果回写指令）
const TIANGONG_HTTP_BASE = process.env.TIANGONG_HTTP_BASE || "https://tiangg.zeabur.app";
const MCP_KEY = process.env.TIANGONG_MCP_KEY || "";

// 等待总期限：默认 3420s（57 分钟），略小于 connector 侧 60 分钟执行超时与
// 任务默认 timeoutMs（30 分钟起，按任务类型见 create_task 说明），留出收尾余量。
// v2.1（2026-10-09）：默认从 280s 放宽到 57min——写作/图像生成类任务真实执行
// 远超 5 分钟，旧默认值会把正常长任务打成 awaiting_result。
const WAIT_TOTAL_MS = Math.max(60_000, Number(process.env.TIANGONG_WAIT_TOTAL_MS || "3420000"));
const WAIT_SLICE_MS = Math.min(25_000, WAIT_TOTAL_MS);

// v2.2（2026-10-09，#106 教训）：完成判定双闸门——完成哨兵 + 防抖。
//   v2/v2.1 的"双保险"（有新 assistant 文本 + hasActiveRun=false 即收账）会被
//   多轮执行流里的进度播报骗过：云霄写完 character-v2.md 播报"已落盘，现在生成
//   第 1 张…"，那一刻恰好空闲帧 → 被当最终结果收走，3 张图未生成就判完成。
//   v2.2：send 前给 prompt 包裹执行协议（完成时须以「任务完成」开头），收账只认
//   哨兵；无哨兵的候选文本必须连续两个轮询周期无更新（防抖）才收，且 stderr 警告。
const COMPLETION_SENTINEL = "任务完成";

function wrapPromptWithProtocol(prompt) {
  return `${prompt}\n\n---\n[天宫执行协议] 完成全部交付物后，最终回复必须以「${COMPLETION_SENTINEL}」四字开头，并附交付清单摘要（文件路径/大小/关键结果）。在此之前发出的任何文本（如"已落盘，现在继续…"）都会被视作进度播报而非完成信号，不会被收账。`;
}

async function main() {
  const tiangongAgentId = process.env.TIANGONG_AGENT_ID || "0";
  const displayName = process.env.TIANGONG_AGENT_NAME || "助手";
  const openclawAgent = process.env.TIANGONG_OPENCLAW_AGENT_NAME || displayName;
  const sessionKey = process.env.TIANGONG_OPENCLAW_SESSION_KEY || `agent:${openclawAgent}:main`;

  const prompt = await readStdin();
  if (!prompt || prompt.trim().length === 0) {
    console.log(`[${displayName}] 收到空任务,跳过`);
    process.exit(0);
  }
  if (!GATEWAY_TOKEN) {
    console.error(`[${displayName}] 缺少 TIANGONG_OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_TOKEN,拒绝执行`);
    process.exit(1);
  }

  try {
    // 1. 投递任务到 Agent session，等待有实际内容的回复
    const result = await callGatewayWithReply(sessionKey, prompt);
    if (isOnlyStarted(result)) {
      process.stderr.write(`[${displayName}/tg#${tiangongAgentId}/${openclawAgent}] awaiting final result\n`);
      process.exit(2);
    }

    // 2. 用量上报（内部有 MCP_KEY 空值守卫，与旧行为一致）
    await reportUsage(prompt, result, true);

    // 3. 输出实际结果给天宫
    console.log(result);
  } catch (err) {
    await reportUsage(prompt, err.message, false);
    process.stderr.write(`[${displayName}/tg#${tiangongAgentId}/${openclawAgent}] 执行失败: ${err.message}\n`);
    process.exit(1);
  }
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 5000);
  });
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'"'"'`)}'`;
}

/** 调一个 gateway 方法，返回 stdout 原文（失败返回空串，不抛错） */
function gatewayCall(method, params, timeoutMs) {
  const cmd = `openclaw gateway call --token ${shellQuote(GATEWAY_TOKEN)} --params ${shellQuote(JSON.stringify(params))} --timeout ${Math.floor(timeoutMs)} ${method} 2>/dev/null`;
  try {
    return execSync(cmd, { timeout: Math.floor(timeoutMs) + 5000, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/** 从命令输出尾部提取最后一个 JSON 对象（gateway call 输出前有 "Gateway call: ..." 行） */
function extractJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}\s*$/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/** 从 chat.history 结果里提取 sinceMs 之后的 assistant 纯文本消息（按时序，含时间戳） */
function extractAssistantTexts(historyPayload, sinceMs) {
  const msgs = Array.isArray(historyPayload?.messages) ? historyPayload.messages : [];
  const out = [];
  for (const m of msgs) {
    if (!m || m.role !== "assistant") continue;
    const ts = Number(m.timestamp ?? 0);
    if (sinceMs && ts && ts <= sinceMs) continue; // 只要 send 之后的新消息
    const blocks = Array.isArray(m.content) ? m.content : [];
    const textParts = blocks
      .filter((b) => b && b.type === "text" && typeof (b.text ?? b.content) === "string" && (b.text ?? b.content).trim().length > 0)
      .map((b) => (b.text ?? b.content).trim());
    if (textParts.length > 0) out.push({ text: textParts.join("\n"), ts });
  }
  return out;
}

/**
 * 通过 OpenClaw gateway 投递任务并等待 Agent 完整回复。
 *
 * v2.2：send（包裹执行协议）→ agent.wait 分段轮询 → chat.history 收最终文本。
 * 完成判定双闸门：
 *   ① 哨兵：assistant 文本含「任务完成」→ 立即收账；
 *   ② 防抖：无哨兵文本须连续两个轮询周期保持"最新一条无变化 + session 空闲"
 *      才收账（stderr 打警告），挡住"播报后被误收"的窗口期。
 */
async function callGatewayWithReply(sessionKey, prompt) {
  const sendAt = Date.now();

  // 1) 投递（包裹执行协议），拿 runId
  const sendOut = gatewayCall("sessions.send", { key: sessionKey, message: wrapPromptWithProtocol(prompt) }, 30_000);
  const sendPayload = extractJson(sendOut);
  const runId = sendPayload?.runId;

  if (!runId) {
    // 拿不到 runId（旧版 gateway 或异常）：维持旧解析行为
    const legacyText = sendPayload && (sendPayload.message || sendPayload.text || sendPayload.content);
    if (legacyText && String(legacyText).trim() && !isOnlyStarted(sendPayload)) {
      return String(legacyText).trim();
    }
    return sendOut || "[无输出]";
  }

  // 2) agent.wait 分段轮询至终态或总期限；history 双闸门判定
  const deadline = sendAt + WAIT_TOTAL_MS;
  let finalState = null;
  let candidate = null; // 防抖候选 {text, ts}：上轮见过的最新文本
  let noSentinelWarn = false;
  while (Date.now() < deadline) {
    const slice = Math.min(WAIT_SLICE_MS, deadline - Date.now());
    const waitPayload = extractJson(gatewayCall("agent.wait", { runId, timeoutMs: Math.floor(slice) }, slice + 5_000));
    const st = waitPayload?.status;
    if (st && !["started", "running", "queued", "timeout"].includes(st)) {
      finalState = waitPayload; // 成功终态（字面值宽松判定）
      break;
    }
    // history 判定：哨兵优先，其次防抖
    const histMid = extractJson(gatewayCall("chat.history", { sessionKey, limit: 50 }, 30_000));
    const texts = extractAssistantTexts(histMid, sendAt);
    const latest = texts.length > 0 ? texts[texts.length - 1] : null;
    if (latest && latest.text.includes(COMPLETION_SENTINEL)) {
      finalState = { status: "done-by-sentinel" };
      break;
    }
    if (latest && histMid?.sessionInfo && histMid.sessionInfo.hasActiveRun === false) {
      if (candidate && candidate.ts === latest.ts) {
        // 同一候选连续两个周期无更新且 session 空闲 → 防抖通过（无哨兵兜底收账）
        finalState = { status: "done-by-debounce" };
        noSentinelWarn = true;
        break;
      }
      candidate = { text: latest.text, ts: latest.ts }; // 记下候选，下轮再验
    } else {
      candidate = null; // 有新活动，重置防抖
    }
  }

  // 3) 收账：chat.history 提取最终 assistant 文本（优先哨兵消息）
  const hist = extractJson(gatewayCall("chat.history", { sessionKey, limit: 50 }, 30_000));
  const texts = extractAssistantTexts(hist, sendAt);
  const sentinelHit = [...texts].reverse().find((t) => t.text.includes(COMPLETION_SENTINEL));
  const finalText = sentinelHit ? sentinelHit.text : (texts.length > 0 ? texts[texts.length - 1].text : "");
  if (!sentinelHit && finalText) noSentinelWarn = true;

  if (finalText) {
    if (noSentinelWarn) {
      process.stderr.write(`[runner] ⚠️ 未检测到「${COMPLETION_SENTINEL}」哨兵，按防抖规则收账（可能是中间态）\n`);
    }
    process.stderr.write(`[runner] ✅ 已收到最终回复 (${finalText.length} chars, state=${finalState?.status ?? "history-only"})\n`);
    return finalText;
  }
  if (finalState) {
    process.stderr.write(`[runner] ⚠️ run 已终态(${finalState.status})但会话内无文本回复\n`);
    return `[任务已到终态(${finalState.status})，但会话内无文本回复。runId=${runId}]`;
  }

  // 总期限耗尽：返回 started → 外层 isOnlyStarted → exit(2) → awaiting_result（旧行为兜底）
  process.stderr.write(`[runner] wait 期限(${WAIT_TOTAL_MS}ms)耗尽，runId=${runId} 未见终态\n`);
  return "started";
}

function isOnlyStarted(value) {
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "started";
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const keys = ["status", "result", "message", "text", "content"];
  const values = keys
    .map((key) => value[key])
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim().toLowerCase());

  return values.length > 0 && values.every((item) => item === "started");
}

async function reportUsage(prompt, result, success) {
  if (!MCP_KEY) return;
  const agentId = parseInt(process.env.TIANGONG_AGENT_ID || "0", 10);
  if (!agentId) return;

  const model = process.env.TIANGONG_CHEAP_MODEL || "deepseek-official/deepseek-v4-flash";
  const inputLen = prompt?.length || 0;
  const outputLen = result?.length || 0;
  const promptTokens = Math.max(10, Math.floor(inputLen / 3));
  const completionTokens = Math.max(5, Math.floor(outputLen / 2));
  const totalTokens = promptTokens + completionTokens;
  const cachedPromptTokens = Math.floor(promptTokens * 0.2);
  const uncachedPromptTokens = promptTokens - cachedPromptTokens;

  try {
    const url = `${TIANGONG_HTTP_BASE}/api/trpc/usage.record`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcp-key": MCP_KEY,
      },
      body: JSON.stringify({
        model,
        provider: "openclaw",
        promptTokens,
        completionTokens,
        totalTokens,
        cachedPromptTokens,
        uncachedPromptTokens,
        callCount: 1,
        agentId,
        source: "runner",
        sessionKey: process.env.TIANGONG_OPENCLAW_SESSION_KEY || "",
      }),
    });
    if (res.ok) {
      process.stderr.write(`[runner] 📊 用量上报: ${totalTokens} tokens, model=${model}, source=runner\n`);
    } else {
      const text = await res.text();
      process.stderr.write(`[runner] ⚠️ 用量上报失败: HTTP ${res.status}: ${text.slice(0, 200)}\n`);
    }
  } catch (e) {
    process.stderr.write(`[runner] ⚠️ 用量上报异常: ${e.message}\n`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
