#!/usr/bin/env node
/**
 * dsh ↔ 天宫 轮询认领器（dsh-poller）
 *
 * 让部署在外部的 DeepSeek Harness (dsh) 实例自动认领并执行天宫任务：
 *   心跳（顺带自动认领 queued 任务）→ dsh 执行 → 结果回写天宫 → 天宫侧自动
 *   记账/传 AList/写璇玑记忆（task-runner 完成路径已有钩子，见下「结果回写」说明）。
 *
 * 用法（在 dsh 所在机器/容器运行，Node ≥ 20，无第三方依赖）：
 *   TIANGONG_BASE_URL=https://tiangg.zeabur.app \
 *   TIANGONG_MCP_KEY=<dsh 助手的 MCP Key> \
 *   TIANGONG_AGENT_ID=17 \
 *   DSH_CMD='dsh -p "$(cat {file})"' \
 *   node dsh-poller.mjs
 *
 * 环境变量：
 *   TIANGONG_BASE_URL   天宫地址（必填）
 *   TIANGONG_MCP_KEY    天宫里 dsh 助手的 MCP Key（必填；认领/心跳/回写都靠它鉴权）
 *   TIANGONG_AGENT_ID   dsh 助手在天宫的数字 id（必填，如 17）
 *   DSH_CMD             执行命令模板，{file} 会被替换为任务提示词文件路径（必填，否则只心跳不认领）。
 *                       按你部署的 dsh 版本调整，例如：
 *                         dsh -p "$(cat {file})"
 *                         npx -y @deepseek-ai/dsh -p "$(cat {file})"
 *                       模型端点建议在 dsh 侧配置为天枢的 OpenAI 兼容地址，用量继续走天枢记账。
 *   POLL_INTERVAL_MS    轮询间隔，默认 5000
 *   DSH_TIMEOUT_MS      单次执行超时，默认 600000
 *
 * 结果回写：任务标记 done 后，天宫 task-runner 的完成路径（定价计费、AList 产物上传、
 * 璇玑记忆同步）由 task-runner 侧的钩子负责；本脚本只负责把 output 写回任务。
 * 注意：由本脚本认领的任务 originSystem 为外部，完成时需通过天宫的完成闸门（高风险任务除外）。
 */

const BASE = (process.env.TIANGONG_BASE_URL || "").replace(/\/+$/, "");
const MCP_KEY = process.env.TIANGONG_MCP_KEY || "";
const AGENT_ID = Number(process.env.TIANGONG_AGENT_ID || "0");
const DSH_CMD = process.env.DSH_CMD || "";
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || "5000"));
const DSH_TIMEOUT_MS = Math.max(10_000, Number(process.env.DSH_TIMEOUT_MS || "600000"));

import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!BASE || !MCP_KEY || !AGENT_ID) {
  console.error("[dsh-poller] 缺少必填环境变量：TIANGONG_BASE_URL / TIANGONG_MCP_KEY / TIANGONG_AGENT_ID");
  process.exit(1);
}
if (!DSH_CMD) {
  console.warn("[dsh-poller] 未设置 DSH_CMD：只发送心跳，不认领任务。设置后才会执行认领到的任务。");
}

async function trpc(proc, body) {
  const res = await fetch(`${BASE}/api/trpc/${proc}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MCP_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(`${proc} 失败: HTTP ${res.status} ${data?.error?.message ?? ""}`.trim());
  }
  return data?.result?.data;
}

/** 从任务 input（可能是 JSON envelope）提取纯文本提示词 */
function extractPrompt(task) {
  const parts = [`# 任务：${task.name}`];
  const raw = task.input ?? task.description ?? "";
  let payload = raw;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      payload = parsed.payload ?? parsed.input ?? parsed.prompt ?? raw;
    } catch {
      /* 非 JSON，按原文处理 */
    }
  }
  if (payload) parts.push(String(payload));
  if (task.description) parts.push(`\n# 描述\n${task.description}`);
  return parts.join("\n\n");
}

function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

async function runDsh(prompt) {
  const file = join(tmpdir(), `dsh-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  await writeFile(file, prompt, "utf8");
  const cmd = DSH_CMD.replaceAll("{file}", shellQuote(file));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`dsh 执行超时（${DSH_TIMEOUT_MS}ms）`));
      }, DSH_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim() || "(dsh 无标准输出)");
        else reject(new Error(`dsh 退出码 ${code}: ${err.slice(-500)}`));
      });
    });
  } finally {
    await unlink(file).catch(() => {});
  }
}

let warnedNoCmd = false;

async function loop() {
  try {
    // 心跳：天宫会在心跳时自动认领最优先的可执行任务返回
    const hb = await trpc("agent.updateHeartbeat", { id: AGENT_ID });
    const claimed = hb?.claimedTask;
    if (!claimed) return;
    if (!DSH_CMD) {
      if (!warnedNoCmd) {
        console.warn(`[dsh-poller] 有任务可认领（${claimed.taskId}），但 DSH_CMD 未设置，跳过执行`);
        warnedNoCmd = true;
      }
      return;
    }
    console.log(`[dsh-poller] 认领任务 ${claimed.taskId} (id=${claimed.id})：${claimed.name}`);
    try {
      await trpc("task.updateProgress", { id: claimed.id, progress: 30, status: "running" });
      const output = await runDsh(extractPrompt(claimed));
      await trpc("task.updateProgress", {
        id: claimed.id,
        progress: 100,
        status: "done",
        lifecycleStatus: "completed",
        output: output.slice(0, 12000),
      });
      console.log(`[dsh-poller] 任务 ${claimed.taskId} 完成`);
    } catch (e) {
      await trpc("task.updateProgress", {
        id: claimed.id,
        progress: 100,
        status: "failed",
        lifecycleStatus: "failed",
        error: e instanceof Error ? e.message : String(e),
      }).catch(() => {});
      console.error(`[dsh-poller] 任务 ${claimed.taskId} 失败:`, e instanceof Error ? e.message : e);
    }
  } catch (e) {
    console.error("[dsh-poller] 轮询异常:", e instanceof Error ? e.message : e);
  }
}

console.log(`[dsh-poller] 启动：agent=${AGENT_ID} base=${BASE} interval=${POLL_INTERVAL_MS}ms`);
setInterval(loop, POLL_INTERVAL_MS);
loop();
