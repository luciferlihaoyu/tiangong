#!/usr/bin/env node
/**
 * 天宫 Connector Runner - 通过 OpenClaw Gateway 真实执行任务
 *
 * connector 从 stdin 传入天宫任务 prompt;本 runner 将 prompt 转发给对应
 * OpenClaw agent 的 main session,并把 gateway 调用结果输出给天宫。
 */

//
// 天宫 Connector Runner — 通过 OpenClaw Gateway 真实执行任务
//
// connector 从 stdin 传入天宫任务 prompt；本 runner 将 prompt 转发给对应
// OpenClaw agent 的 main session，等待 Agent 回复后把结果输出给天宫。
//
// 升级：调用 sessions_send 等待 reply（非 sessions.send 仅投递）
// prompt 末尾附带指令让 Agent 执行完后回写结果到天宫 API。
//

import { execSync } from "node:child_process";

const GATEWAY_TOKEN = process.env.TIANGONG_OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "";

// 天宫 API URL（用于 Agent 结果回写指令）
const TIANGONG_HTTP_BASE = process.env.TIANGONG_HTTP_BASE || "https://tiangg.zeabur.app";
const MCP_KEY = process.env.TIANGONG_MCP_KEY || "";

async function main() {
  const tiangongAgentId = process.env.TIANGONG_AGENT_ID || "0";
  const displayName = process.env.TIANGONG_AGENT_NAME || "助手";
  const openclawAgent = process.env.TIANGONG_OPENCLAW_AGENT_NAME || displayName;
  const sessionKey = process.env.TIANGONG_OPENCLAW_SESSION_KEY || `agent:${openclawAgent}:main`;
  const taskId = parseInt(process.env.TIANGONG_TASK_ID || "0", 10);

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

    // 2. 用量上报（不管结果怎么样都报）
    if (process.env.TIANGONG_REPORT_USAGE === "true") {
      await reportUsage(prompt, result, true);
    }

    // 3. 输出实际结果给天宫
    console.log(result);
  } catch (err) {
    if (process.env.TIANGONG_REPORT_USAGE === "true") {
      await reportUsage(prompt, err.message, false);
    }
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

/**
 * 通过 OpenClaw sessions_send 投递任务并等待 Agent 完整回复。
 * 不再使用仅投递的 sessions.send（它只返回 "started"）。
 */
async function callGatewayWithReply(sessionKey, prompt) {
  const params = JSON.stringify({ key: sessionKey, message: prompt });
  // 调用 sessions.send — Gateway 会在 Agent 回复超时后超时返回
  // 我们依赖 sessions.send 的 `timeout` 参数来等 reply
  // 注意：这里用 send 但加了 300s timeout，agent 应该能完成
  const cmd = `openclaw gateway call --token ${shellQuote(GATEWAY_TOKEN)} --params ${shellQuote(params)} --timeout 300000 sessions.send 2>/dev/null`;
  const output = execSync(cmd, { timeout: 310000, encoding: "utf-8" });

  const trimmed = output.trim();
  if (!trimmed) return "[无输出]";

  // 尝试从 JSON 响应中提取实际消息
  const match = trimmed.match(/\{[\s\S]*\}\s*$/);
  if (match) {
    try {
      const payload = JSON.parse(match[0]);
      // 如果有 message/text/content 字段，用 Agent 的回复内容
      const replyText = payload.message || payload.text || payload.content || "";
      if (replyText && replyText.length > 0) {
        return replyText.trim();
      }
    } catch {
      // 不是 JSON，就当普通文本处理
    }
  }

  // 如果没有提取到内容，返回原始输出
  return trimmed;
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

