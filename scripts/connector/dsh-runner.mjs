#!/usr/bin/env node
/**
 * DSH → 天宫 任务执行器（dsh-runner）
 *
 * 职责：把派给 dsh agent (id=17) 的天宫任务真正执行掉。
 * 取代 dsh-keepalive.mjs（后者只心跳不执行——T-MTMG7SVO 失败根因：
 * 服务端心跳即认领，keepalive 领到任务只打日志即丢）。
 *
 * 工作流（每轮）：
 *   1. 跳一次心跳（updateHeartbeat）——服务端在心跳里自动认领 queued 任务
 *      （claimNextTask 内嵌于 updateHeartbeat，见 api/agent-router.ts 注释
 *      "dsh-poller 只看 claimedTask"），claimedTask 非空即认领成功。
 *   2. 认领成功 → 拉任务 prompt → `dsh --profile headless "<prompt>"`
 *      真实执行（官方单任务应答退出模式），拿 stdout 作为结果。
 *   3. 回写：成功 → a2a.submitResult；失败/超时 → a2a.fail（错误截断）。
 *   4. 无任务 → 睡一个轮询周期。
 *
 * 环境变量：
 *   DSH_TIANGONG_KEY       tg-17 key（必须；agent 17 专属，服务端校验身份）
 *   TIANGONG_HTTP_BASE     天宫地址（默认 https://tiangong.xianrealme.com，
 *                          旧域名 tiangg.zeabur.app 已 404 勿用）
 *   DSH_RUNNER_POLL_MS     轮询间隔（默认 30_000）
 *   DSH_RUNNER_TIMEOUT_MS  单任务执行超时（默认 1_800_000 = 30 分钟）
 *   DSH_RUNNER_WORKDIR     headless 执行的工作目录（默认 /data/dsh/天宫）
 *
 * 安全约束（AGENTS.md）：单并发（一次一个任务）、超时熔断、输出截断 60KB、
 * 子进程内存与 web 主进程隔离。
 *
 * 用法：
 *   DSH_TIANGONG_KEY=tg-17-xxx nohup node scripts/connector/dsh-runner.mjs \
 *     > /data/dsh/dsh-runner-$(date +%m%d).log 2>&1 &
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const KEY = process.env.DSH_TIANGONG_KEY || process.env.TIANGONG_MCP_KEY || "";
const BASE = (process.env.TIANGONG_HTTP_BASE || "https://tiangong.xianrealme.com").replace(/\/+$/, "");
const AGENT_ID = Number(process.env.TIANGONG_AGENT_ID || 17);
const POLL_MS = Number(process.env.DSH_RUNNER_POLL_MS || 30_000);
const TIMEOUT_MS = Number(process.env.DSH_RUNNER_TIMEOUT_MS || 1_800_000);
const WORKDIR = process.env.DSH_RUNNER_WORKDIR || "/data/dsh/天宫";
const MAX_OUTPUT_CHARS = 60_000;

// 生图插件 overlay（2026-09-10 生图能力建设）：存在即挂载，给每个 headless 任务
// 注入 generate_image 工具（走天枢网关，密钥在插件进程内自取，不进任务文本）。
// 文件缺失/被移除时自动跳过，不影响任务主链路。
const IMAGE_GEN_PATCH = process.env.DSH_IMAGE_GEN_PATCH || "/data/dsh/天宫/dsh-plugins/image-gen.patch.yml";

if (!KEY) {
  console.error("[dsh-runner] ❌ 缺少 DSH_TIANGONG_KEY 环境变量");
  process.exit(1);
}

/** 从 dsh web 进程环境继承 LLM 凭证（headless profile 无 settings 存储，
 *  需要从 dsh web 进程 /proc/<pid>/environ 抓 TIANSHU_API_KEY 等） */
function inheritLlmEnvFromDshWeb() {
  try {
    const procs = readdirSync("/proc").filter((n) => /^\d+$/.test(n));
    for (const pid of procs) {
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (!cmdline.includes("--profile") || !cmdline.includes("web")) continue;
        const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
        for (const kv of environ.split("\0")) {
          const eq = kv.indexOf("=");
          if (eq < 0) continue;
          const k = kv.slice(0, eq);
          // 只继承 LLM 凭证类环境变量，避免泄露整个 dsh web 进程环境
          if (/^TIANSHU_API_KEY$|^DEEPSEEK_API_KEY$|^MINIMAX_API_KEY$|^ZEABUR_API_KEY$|^ANTHROPIC_API_KEY$|^OPENAI_API_KEY$/.test(k) && !process.env[k]) {
            process.env[k] = kv.slice(eq + 1);
          }
        }
        log(`已从 dsh web (pid ${pid}) 继承 LLM 凭证（仅匹配 LLM_API_KEY 命名）`);
        return;
      } catch { /* skip */ }
    }
  } catch (e) {
    log(`⚠️ 继承 LLM 凭证失败: ${e.message}`);
  }
}
inheritLlmEnvFromDshWeb();

let running = false; // 单并发闸：同一时刻最多一个任务

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...parts) {
  console.log(`[dsh-runner] ${new Date().toISOString()}`, ...parts);
}

async function trpc(path, body) {
  const res = await fetch(`${BASE}/api/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/** 心跳 + 顺带认领（服务端语义：心跳即认领）。返回 claimedTask 或 null。 */
async function heartbeatAndClaim() {
  const data = await trpc("agent.updateHeartbeat", { id: AGENT_ID });
  const result = data?.result?.data;
  if (result?.claimReason === "budget_exhausted") {
    log("⚠️ 预算熔断：本轮不接任务");
    return null;
  }
  return result?.claimedTask ?? null;
}

/** 心跳响应里只有 id/taskId/name/approvalRequired —— 用数字 id 拉全量任务拿 prompt。
 *  注意：taskboard.get 入参是 {id: number}（数据库主键），GET 格式 `?input=<urlencoded JSON>`。 */
async function fetchTaskPrompt(dbId) {
  const input = encodeURIComponent(JSON.stringify({ id: dbId }));
  const res = await fetch(`${BASE}/api/trpc/taskboard.get?input=${input}`, {
    headers: { "x-api-key": KEY },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`taskboard.get HTTP ${res.status}`);
  const data = await res.json();
  const raw = data?.result?.data;
  const task = raw?.json ?? raw;
  let prompt = task?.description ?? null;
  if (!prompt && typeof task?.input === "string") {
    try {
      const parsed = JSON.parse(task.input);
      prompt = parsed?.payload ?? task.input;
    } catch {
      prompt = task.input;
    }
  }
  return { name: task?.name ?? `#${taskId}`, prompt };
}

/** headless 执行：一个任务一个 dsh 子进程，答案即 stdout。 */
function runHeadless(prompt) {
  return new Promise((resolve) => {
    const args = ["--profile", "headless"];
    if (existsSync(IMAGE_GEN_PATCH)) args.push("--patch", IMAGE_GEN_PATCH);
    args.push(prompt);
    const child = spawn("dsh", args, {
      cwd: WORKDIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { if (out.length < MAX_OUTPUT_CHARS) out += d; });
    child.stderr.on("data", (d) => { if (err.length < MAX_OUTPUT_CHARS) err += d; });
    const timer = setTimeout(() => {
      log("⏰ 超时，杀子进程");
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: `spawn 失败: ${e.message}` }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) {
        const truncated = out.length >= MAX_OUTPUT_CHARS ? "\n…(输出超长已截断)" : "";
        resolve({ ok: true, output: out.slice(0, MAX_OUTPUT_CHARS) + truncated });
      } else {
        resolve({ ok: false, error: `Command exited with code ${code}\nStderr: ${(err || "(empty)").slice(0, 1500)}` });
      }
    });
  });
}

async function submitResult(taskId, output) {
  await trpc("a2a.submitResult", { taskId, agentId: AGENT_ID, output, artifactType: "result" });
  log(`✅ #${taskId} 结果已回写（${output.length} 字符）`);
}

async function reportFail(taskId, error) {
  try {
    await trpc("a2a.fail", { taskId, agentId: AGENT_ID, error: String(error).slice(0, 2000) });
    log(`❌ #${taskId} 失败已回写`);
  } catch (e) {
    log(`❌ #${taskId} 失败回写也失败: ${e.message}`);
  }
}

async function processClaimed(claimed) {
  const { id, taskId, name } = claimed;
  log(`🎯 认领任务 #${id} ${taskId} ${name}`);
  running = true;
  try {
    const { prompt } = await fetchTaskPrompt(id);
    if (!prompt || !String(prompt).trim()) {
      await reportFail(id, "任务描述为空，无法执行");
      return;
    }
    log(`⚙️ headless 执行中（超时 ${TIMEOUT_MS / 60000} 分钟）…`);
    const result = await runHeadless(String(prompt));
    if (result.ok) await submitResult(id, result.output);
    else await reportFail(id, result.error);
  } catch (e) {
    await reportFail(id, `runner 执行异常: ${e.message}`);
  } finally {
    running = false;
  }
}

async function loop() {
  log(`启动：agent #${AGENT_ID} → ${BASE}，轮询 ${POLL_MS / 1000}s，超时 ${TIMEOUT_MS / 60000}min，workdir=${WORKDIR}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (!running) {
        const claimed = await heartbeatAndClaim();
        if (claimed) await processClaimed(claimed);
      }
    } catch (e) {
      log(`⚠️ 轮询异常: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

loop().catch((e) => { console.error("[dsh-runner] fatal:", e); process.exit(1); });
