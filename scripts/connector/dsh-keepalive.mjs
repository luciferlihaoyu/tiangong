#!/usr/bin/env node
/**
 * DSH → 天宫 保活心跳（方案 C 第 ② 步，最轻量）
 * 
 * 每 30s 调天宫 agent.updateHeartbeat，让 dsh agent (id=17) 保持 online。
 * Key 从环境变量 DSH_TIANGONG_KEY 读取（Zeabur 天宫服务 env 已配置），
 * 不硬编码明文。
 * 
 * 用法：
 *   DSH_TIANGONG_KEY=tg-17-xxx TIANGONG_HTTP_BASE=https://tiangg.zeabur.app \
 *     node scripts/connector/dsh-keepalive.mjs
 */
const KEY = process.env.DSH_TIANGONG_KEY || process.env.TIANGONG_MCP_KEY || "";
const BASE = (process.env.TIANGONG_HTTP_BASE || "https://tiangg.zeabur.app").replace(/\/+$/, "");
const AGENT_ID = Number(process.env.TIANGONG_AGENT_ID || 17);
const INTERVAL = Number(process.env.HEARTBEAT_INTERVAL_MS || 30_000);

if (!KEY) {
  console.error("❌ 缺少 DSH_TIANGONG_KEY 环境变量");
  process.exit(1);
}

let lastOk = true;

async function heartbeat() {
  try {
    const res = await fetch(`${BASE}/api/trpc/agent.updateHeartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ id: AGENT_ID }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    const claimed = data?.result?.data?.claimedTask;
    if (claimed) {
      console.log(`[keepalive] 🎯 心跳返回可认领任务: #${claimed.id} ${claimed.name}`);
      // 本脚本只保活不执行；如后续启用认领执行，在此调 dsh-runner
    }
    lastOk = true;
    process.stdout.write(`💓 ${new Date().toISOString()} online\n`);
  } catch (e) {
    lastOk = false;
    console.error(`❌ ${new Date().toISOString()} 心跳失败: ${e.message}`);
  }
}

console.log(`[keepalive] DSH agent #${AGENT_ID} → ${BASE} 每 ${INTERVAL / 1000}s 心跳`);
await heartbeat();
setInterval(heartbeat, INTERVAL);
