#!/usr/bin/env node
/**
 * 天宫 Connector Runner — 通过 OpenClaw Gateway 真实执行任务
 *
 * connector 从 stdin 传入天宫任务 prompt；本 runner 将 prompt 转发给对应
 * OpenClaw agent 的 main session，并把 gateway 调用结果输出给天宫。
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
    console.log(`[${displayName}] 收到空任务，跳过`);
    process.exit(0);
  }
  if (!GATEWAY_TOKEN) {
    console.error(`[${displayName}] 缺少 TIANGONG_OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_TOKEN，拒绝执行`);
    process.exit(1);
  }

  try {
    const result = await callGateway(sessionKey, prompt);
    if (isOnlyStarted(result)) {
      // A2A-lite v0.1: gateway 只返回 started 不代表最终完成。
      // runner 必须报告“awaiting final result”，不能输出看似成功的结果。
      console.error(`[A2A-lite] Gateway returned only 'started' for ${sessionKey}. Awaiting final result, not completing.`);
      process.exit(2); // exit code 2 = awaiting_result
    }
    console.log(result);
  } catch (err) {
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
  const cmd = `openclaw gateway call --token ${shellQuote(GATEWAY_TOKEN)} --params ${shellQuote(params)} --expect-final --timeout 300000 sessions.send 2>/dev/null`;
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

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
