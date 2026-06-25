#!/usr/bin/env node
/**
 * 天宫 Connector Runner - 通过 OpenClaw Gateway 真实执行任务
 *
 * connector 从 stdin 传入天宫任务 prompt;本 runner 将 prompt 转发给对应
 * OpenClaw agent 的 main session,并把 gateway 调用结果输出给天宫。
 */

import { execSync } from "node:child_process";

const GATEWAY_TOKEN = process.env.TIANGONG_OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "";

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
    const result = await callGateway(sessionKey, prompt);
    // Accept 'started' as success — the message was delivered to the agent session.
    // The agent will process it asynchronously and reply via mailbox.reply if needed.
    if (process.env.TIANGONG_REPORT_USAGE === "true") {
      await reportUsage(prompt, result, true);
    }
    if (isOnlyStarted(result)) {
      console.log(`[${displayName}] 消息已投递到 ${sessionKey}，助手将异步处理`);
      process.exit(0);
    }
    console.log(result);
  } catch (err) {
    if (process.env.TIANGONG_REPORT_USAGE === "true") {
      await reportUsage(prompt, err.message, false);
    }
    console.error(`[${displayName}/tg#${tiangongAgentId}/${openclawAgent}] 执行失败: ${err.message}`);
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

async function callGateway(sessionKey, prompt) {
  const params = JSON.stringify({ key: sessionKey, message: prompt });
  // Use sessions.send without --expect-final - we accept 'started' as success
  // for async message delivery. The agent will process the message asynchronously.
  const cmd = `openclaw gateway call --token ${shellQuote(GATEWAY_TOKEN)} --params ${shellQuote(params)} --timeout 300000 sessions.send 2>/dev/null`;
  const output = execSync(cmd, { timeout: 310000, encoding: "utf-8" });
  return output.trim();
}

function isOnlyStarted(output) {
  const match = output.match(/\{[\s\S]*\}\s*$/);
  if (!match) return false;
  try {
    const payload = JSON.parse(match[0]);
    return payload && payload.status === "started" && !payload.final && !payload.message && !payload.text && !payload.content;
  } catch {
    return false;
  }
}

async function reportUsage(prompt, result, success) {
  const mcpKey = process.env.TIANGONG_MCP_KEY;
  const httpBase = process.env.TIANGONG_HTTP_BASE || "https://tiangg.zeabur.app";
  const agentId = parseInt(process.env.TIANGONG_AGENT_ID || "0", 10);
  const agentName = process.env.TIANGONG_OPENCLAW_AGENT_NAME || "助手";

  if (!mcpKey || !agentId) return;

  // 获取模型名（从环境变量或默认）
  const model = process.env.TIANGONG_CHEAP_MODEL || "deepseek-official/deepseek-v4-flash";

  // 估算 token
  const inputLen = prompt?.length || 0;
  const outputLen = result?.length || 0;
  const promptTokens = Math.max(10, Math.floor(inputLen / 3));
  const completionTokens = Math.max(5, Math.floor(outputLen / 2));
  const totalTokens = promptTokens + completionTokens;
  const cachedPromptTokens = Math.floor(promptTokens * 0.2);
  const uncachedPromptTokens = promptTokens - cachedPromptTokens;

  try {
    const url = `${httpBase}/api/trpc/usage.record`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcp-key": mcpKey,
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
