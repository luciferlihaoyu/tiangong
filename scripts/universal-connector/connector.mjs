#!/usr/bin/env node
/**
 * universal-connector — 天宫通用接入执行器
 *
 * 任何外部系统接入天宫任务闭环：跑一行命令即可认领任务、执行、回写结果。
 * 单文件、零 npm 依赖、Node >= 18。规格：docs/PLAN-universal-connector.md 任务 A。
 *
 * tRPC 调用约定（沿用 scripts/openclaw-connector/connector.mjs 的既有形态）：
 *   POST {base}/api/trpc/{procedure}   头 x-mcp-key: <key>，body = 裸 input JSON
 *   响应 tRPC v11 包裹：{ result: { data: ... } }
 * 实际过程名（与 api/agent-router.ts / api/taskboard-router.ts 源码对齐）：
 *   认领   agent.claimTask     input {agentId}   → {task:{id,taskId,name,description,input,...}|null, reason?}
 *   心跳   agent.updateHeartbeat input {id}      → {success, claimedTask, claimReason}
 *   回写   taskboard.progress  input {id, progress, status?, lifecycleStatus?, output?, error?}
 *   （计划文件中写的 task.reportProgress / agent.heartbeat 在 tRPC 面不存在，
 *    taskboard.progress 即其对应事实源，MCP 工具 report_progress 与之共用 schema。）
 *
 * 用法示例：
 *   node connector.mjs --mode http     --endpoint https://my.svc/run
 *   node connector.mjs --mode cli      --cmd './run.sh'
 *   node connector.mjs --mode callback
 *   TIANGONG_MCP_KEY=*** TIANGONG_AGENT_ID=42 node connector.mjs --mode http --endpoint ...
 *   node connector.mjs --selftest          # 干跑：打印解析后的配置，不联网
 */

import { spawn } from "node:child_process";

// ═══════════════════════════════════════════════════════════════
//  常量与默认值
// ═══════════════════════════════════════════════════════════════

const VERSION = "1.0.0";
const DEFAULT_BASE_URL = "https://tiangong.xianrealme.com";
const DEFAULT_POLL_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 3_600_000; // 60min
/** 采集 stdout/stderr 的截断上限（字符），防止大输出撑爆内存 */
const MAX_CAPTURE = 200_000;
/** 终态回写失败后的重试次数与基础退避 */
const WRITEBACK_ATTEMPTS = 3;
const WRITEBACK_BASE_DELAY_MS = 2_000;

const VALID_MODES = ["http", "cli", "callback"];

// ═══════════════════════════════════════════════════════════════
//  日志（全走 stderr，单行 JSON-ish，含 ISO 时间戳）
// ═══════════════════════════════════════════════════════════════

function logLine(level, msg, extra) {
  const rec = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
  process.stderr.write(JSON.stringify(rec) + "\n");
}
const L = {
  info: (m, e) => logLine("info", m, e),
  warn: (m, e) => logLine("warn", m, e),
  error: (m, e) => logLine("error", m, e),
  debug: (m, e) => {
    if (LOG_DEBUG) logLine("debug", m, e);
  },
};
let LOG_DEBUG = false;

// ═══════════════════════════════════════════════════════════════
//  配置：flag > env > 默认
// ═══════════════════════════════════════════════════════════════

function printUsage() {
  process.stderr.write(`universal-connector v${VERSION} — 天宫通用接入执行器

用法: node connector.mjs --mode <http|cli|callback> [选项]

通用选项:
  --base-url <url>        天宫基址          (env TIANGONG_BASE_URL, 默认 ${DEFAULT_BASE_URL})
  --key <token>           MCP Key           (env TIANGONG_MCP_KEY, 必填)
  --agent-id <n>          Agent 数字 ID     (env TIANGONG_AGENT_ID, 必填)
  --mode <m>              http|cli|callback (env TIANGONG_MODE, 默认 http)
  --poll-ms <n>           认领轮询间隔      (env TIANGONG_POLL_MS, 默认 ${DEFAULT_POLL_MS})
  --heartbeat-ms <n>      心跳间隔          (env TIANGONG_HEARTBEAT_MS, 默认 ${DEFAULT_HEARTBEAT_MS})
  --exec-timeout <ms>     单任务执行超时    (env TIANGONG_EXEC_TIMEOUT, 默认 ${DEFAULT_EXEC_TIMEOUT_MS})
  --selftest              干跑：打印解析后的配置与模式后退出（不联网）
  --debug                 stderr 输出 debug 级日志
  --help, -h              本帮助

adapter 选项:
  --mode http   --endpoint <url>   POST {taskId,name,description,prompt} 到 endpoint；
                                   响应 JSON {output} 视为成功，{error} 视为失败
  --mode cli    --cmd '<shell>'    /bin/sh -c 执行；prompt 走 stdin；
                                   exit 0=done  exit 2=awaiting(25%)  其他=failed
  --mode callback                  认领后回写占位（progress 25，awaiting_result），
                                   由对端系统自行调 taskboard.progress 完成任务
`);
}

function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--selftest": flags.selftest = true; break;
      case "--debug": flags.debug = true; break;
      case "--help": case "-h": flags.help = true; break;
      case "--base-url": flags.baseUrl = argv[++i]; break;
      case "--key": flags.key = argv[++i]; break;
      case "--agent-id": flags.agentId = argv[++i]; break;
      case "--mode": flags.mode = argv[++i]; break;
      case "--endpoint": flags.endpoint = argv[++i]; break;
      case "--cmd": flags.cmd = argv[++i]; break;
      case "--poll-ms": flags.pollMs = argv[++i]; break;
      case "--heartbeat-ms": flags.heartbeatMs = argv[++i]; break;
      case "--exec-timeout": flags.execTimeout = argv[++i]; break;
      default: rest.push(a);
    }
  }
  if (rest.length) {
    throw new Error(`未知参数: ${rest.join(" ")}（--help 查看用法）`);
  }
  return flags;
}

function pick(flagVal, envVal, defaultVal) {
  if (flagVal !== undefined && flagVal !== "") return flagVal;
  if (envVal !== undefined && envVal !== "") return envVal;
  return defaultVal;
}

function toInt(name, raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`配置项 ${name} 必须是正整数，收到: "${raw}"`);
  }
  return n;
}

/**
 * 解析并校验配置。errors 数组收集全部致命问题（一次性报全，方便接入方排错）。
 * selftest 干跑时，adapter 专属必填项（http 的 endpoint / cli 的 cmd）降级为
 * warnings——干跑的意义是"打印解析后的配置+模式"，而真启动必须把它们补齐。
 * @returns {{cfg?: object, errors: string[], warnings: string[]}}
 */
function resolveConfig(flags) {
  const errors = [];
  const warnings = [];
  const dryRun = Boolean(flags.selftest);

  const baseUrl = String(pick(flags.baseUrl, process.env.TIANGONG_BASE_URL, DEFAULT_BASE_URL)).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) errors.push(`TIANGONG_BASE_URL 必须是 http(s) URL，收到: "${baseUrl}"`);

  const key = pick(flags.key, process.env.TIANGONG_MCP_KEY, "");
  if (!key) errors.push(`缺少 MCP Key：--key 或 env TIANGONG_MCP_KEY（register_agent 返回的 mcpToken / tgk_...）`);

  const agentIdRaw = pick(flags.agentId, process.env.TIANGONG_AGENT_ID, "");
  let agentId = null;
  if (!agentIdRaw) {
    errors.push(`缺少 Agent ID：--agent-id 或 env TIANGONG_AGENT_ID（数字，agents 表主键）`);
  } else {
    agentId = Number(agentIdRaw);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      errors.push(`TIANGONG_AGENT_ID 必须是正整数，收到: "${agentIdRaw}"`);
      agentId = null;
    }
  }

  const mode = String(pick(flags.mode, process.env.TIANGONG_MODE, "http")).toLowerCase();
  if (!VALID_MODES.includes(mode)) errors.push(`--mode 必须是 ${VALID_MODES.join("|")}，收到: "${mode}"`);

  const endpoint = pick(flags.endpoint, process.env.TIANGONG_ENDPOINT, "");
  if (mode === "http") {
    if (!endpoint) {
      const msg = `--mode http 需要 --endpoint URL 或 env TIANGONG_ENDPOINT`;
      if (dryRun) warnings.push(msg + "（干跑豁免，真启动必填）");
      else errors.push(msg);
    } else if (!/^https?:\/\//.test(endpoint)) {
      errors.push(`--endpoint 必须是 http(s) URL，收到: "${endpoint}"`);
    }
  }

  const cmd = pick(flags.cmd, process.env.TIANGONG_CMD, "");
  if (mode === "cli" && !cmd) {
    if (dryRun) warnings.push(`--mode cli 需要 --cmd '<shell command>' 或 env TIANGONG_CMD（干跑豁免，真启动必填）`);
    else errors.push(`--mode cli 需要 --cmd '<shell command>' 或 env TIANGONG_CMD`);
  }

  let pollMs, heartbeatMs, execTimeout;
  try {
    pollMs = toInt("TIANGONG_POLL_MS", pick(flags.pollMs, process.env.TIANGONG_POLL_MS, ""), DEFAULT_POLL_MS);
    heartbeatMs = toInt("TIANGONG_HEARTBEAT_MS", pick(flags.heartbeatMs, process.env.TIANGONG_HEARTBEAT_MS, ""), DEFAULT_HEARTBEAT_MS);
    execTimeout = toInt("TIANGONG_EXEC_TIMEOUT", pick(flags.execTimeout, process.env.TIANGONG_EXEC_TIMEOUT, ""), DEFAULT_EXEC_TIMEOUT_MS);
  } catch (e) {
    errors.push(e.message);
  }

  if (errors.length) return { errors, warnings };
  return {
    errors: [],
    warnings,
    cfg: { baseUrl, key, agentId, mode, endpoint, cmd, pollMs, heartbeatMs, execTimeout },
  };
}

function maskKey(k) {
  if (!k) return "(unset)";
  if (k.length <= 8) return "*".repeat(k.length);
  return k.slice(0, 4) + "*".repeat(Math.min(12, k.length - 8)) + k.slice(-4);
}

function selftestSummary(cfg) {
  return {
    selftest: true,
    version: VERSION,
    node: process.version,
    baseUrl: cfg.baseUrl,
    agentId: cfg.agentId,
    mcpKey: maskKey(cfg.key),
    mode: cfg.mode,
    endpoint: cfg.mode === "http" ? cfg.endpoint : undefined,
    cmd: cfg.mode === "cli" ? cfg.cmd : undefined,
    pollMs: cfg.pollMs,
    heartbeatMs: cfg.heartbeatMs,
    execTimeout: cfg.execTimeout,
    procedures: {
      claim: "agent.claimTask {agentId}",
      heartbeat: "agent.updateHeartbeat {id}",
      writeback: "taskboard.progress {id,progress,status?,lifecycleStatus?,output?,error?}",
    },
  };
}

// ═══════════════════════════════════════════════════════════════
//  tRPC HTTP helpers（沿用 openclaw connector 的 trpcCall 约定）
// ═══════════════════════════════════════════════════════════════

/**
 * POST 调用一个 tRPC 过程。
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
async function trpcCall(cfg, procedure, input) {
  const url = `${cfg.baseUrl}/api/trpc/${procedure}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-key": cfg.key },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const json = await res.json();
    // tRPC v11 包裹：{ result: { data: ... } }
    if (json && json.result && json.result.data !== undefined) return { ok: true, data: json.result.data };
    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 终态回写：失败后有限重试（done/failed 是任务闭环的最后一步，值得多试几次） */
async function writebackFinal(cfg, input) {
  let lastErr = "unknown";
  for (let attempt = 1; attempt <= WRITEBACK_ATTEMPTS; attempt++) {
    const r = await trpcCall(cfg, "taskboard.progress", input);
    if (r.ok) {
      L.info(`↩️ 回写成功 task=${input.id} status=${input.status ?? "-"} progress=${input.progress}`, { attempt });
      return true;
    }
    lastErr = r.error || "unknown";
    L.warn(`回写失败 task=${input.id}（第 ${attempt}/${WRITEBACK_ATTEMPTS} 次）: ${lastErr}`);
    if (attempt < WRITEBACK_ATTEMPTS) await sleep(WRITEBACK_BASE_DELAY_MS * attempt);
  }
  L.error(`❌ 回写最终失败 task=${input.id}，任务结果可能滞留 running：${lastErr}`);
  return false;
}

async function reportDone(cfg, task, output) {
  return writebackFinal(cfg, {
    id: task.id,
    progress: 100,
    status: "done",
    lifecycleStatus: "completed",
    output: truncate(String(output ?? ""), MAX_CAPTURE) || "（执行成功，无输出）",
  });
}

async function reportFailed(cfg, task, error) {
  return writebackFinal(cfg, {
    id: task.id,
    progress: 0,
    status: "failed",
    lifecycleStatus: "failed",
    error: truncate(String(error ?? "执行失败"), MAX_CAPTURE),
  });
}

/** awaiting 语义：不标失败，回写 progress 25 + lifecycleStatus awaiting_result */
async function reportAwaiting(cfg, task, note) {
  const r = await trpcCall(cfg, "taskboard.progress", {
    id: task.id,
    progress: 25,
    status: "running",
    lifecycleStatus: "awaiting_result",
    output: truncate(String(note ?? ""), MAX_CAPTURE),
  });
  if (!r.ok) L.warn(`awaiting 回写失败 task=${task.id}: ${r.error}`);
  return r.ok;
}

function truncate(s, cap) {
  return s.length > cap ? s.slice(0, cap) + `\n…[truncated ${s.length - cap} chars]` : s;
}

// ═══════════════════════════════════════════════════════════════
//  任务 prompt 组装
// ═══════════════════════════════════════════════════════════════

/**
 * 由认领结果组装执行 prompt：
 * input 字段若是 JSON（天宫任务 metadata 常见形态）取其中的可读文本，失败则原样使用；
 * description 作为兜底/补充。
 */
function buildPrompt(task) {
  const parts = [];
  if (task.description) parts.push(String(task.description));
  const raw = task.input;
  if (raw) {
    let text = String(raw);
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object") {
        const cand = obj.prompt ?? obj.input ?? obj.text ?? obj.description;
        if (typeof cand === "string" && cand) text = cand;
      }
    } catch {
      /* 非 JSON，原样使用 */
    }
    if (!parts.includes(text)) parts.push(text);
  }
  return parts.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════
//  Adapter：http
// ═══════════════════════════════════════════════════════════════

/**
 * POST {taskId, name, description, prompt} 到 endpoint。
 * 响应 JSON：{output} → done；{error} → failed；非 200/网络错/超时 → failed。
 * 既无 output 也无 error 时，把整个响应文本当 output（宽松兼容）。
 */
async function runHttpAdapter(cfg, task, prompt) {
  const body = {
    taskId: task.id,          // 数字 id：对端若需自行回写，这就是 taskboard.progress 的 id
    taskNo: task.taskId,      // "T-xxx" 字符串编号，仅展示/追踪用
    name: task.name,
    description: task.description ?? null,
    prompt,
  };
  let res;
  try {
    res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.execTimeout),
    });
  } catch (err) {
    const msg = err?.name === "TimeoutError" ? `执行超时（${cfg.execTimeout}ms）` : `网络错误: ${err?.message ?? err}`;
    return { kind: "failed", error: `${task.name}: HTTP adapter 调用失败 — ${msg}` };
  }
  const text = truncate(await res.text().catch(() => ""), MAX_CAPTURE);
  if (!res.ok) {
    return { kind: "failed", error: `${task.name}: HTTP ${res.status} — ${text.slice(0, 500)}` };
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
  if (parsed && typeof parsed === "object") {
    if (parsed.error !== undefined && parsed.error !== null && parsed.output === undefined) {
      return { kind: "failed", error: `${task.name}: ${typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error)}` };
    }
    if (parsed.output !== undefined) {
      return { kind: "done", output: typeof parsed.output === "string" ? parsed.output : JSON.stringify(parsed.output, null, 2) };
    }
  }
  return { kind: "done", output: text };
}

// ═══════════════════════════════════════════════════════════════
//  Adapter：cli
// ═══════════════════════════════════════════════════════════════

/**
 * /bin/sh -c cmd，prompt 写 stdin，收集 stdout/stderr。
 * exit 0 → done（stdout 为 output）
 * exit 2 → awaiting（回写 25%，不算失败）
 * 其他 exit / spawn 错 / 超时 → failed
 */
function runCliAdapter(cfg, task, prompt) {
  return new Promise((resolve) => {
    let child;
    try {
      // 安全：key 不进子进程 env（spawn options.env 是引用传递，必须先复制再删）
      const childEnv = { ...process.env };
      delete childEnv.TIANGONG_MCP_KEY;
      child = spawn("/bin/sh", ["-c", cfg.cmd], {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
    } catch (err) {
      resolve({ kind: "failed", error: `${task.name}: CLI spawn 失败 — ${err?.message ?? err}` });
      return;
    }

    let out = "";
    let errTail = "";
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* noop */ }
      finish({ kind: "failed", error: `${task.name}: CLI 执行超时（${cfg.execTimeout}ms），已杀死进程` });
    }, cfg.execTimeout);

    child.stdout.on("data", (b) => { if (out.length < MAX_CAPTURE) out += b; });
    child.stderr.on("data", (b) => { errTail = (errTail + b).slice(-4000); });

    child.stdin.on("error", () => { /* EPIPE：子进程不读 stdin，忽略 */ });
    try { child.stdin.write(prompt ?? ""); child.stdin.end(); } catch { /* noop */ }

    child.on("error", (err) => {
      finish({ kind: "failed", error: `${task.name}: CLI 进程错误 — ${err?.message ?? err}` });
    });

    child.on("close", (code, signal) => {
      if (timedOut) return; // 超时分支已 finish
      if (code === 0) {
        finish({ kind: "done", output: truncate(out, MAX_CAPTURE) });
      } else if (code === 2) {
        finish({ kind: "awaiting", note: out.trim() || `CLI exit 2（awaiting），等待外部系统调 taskboard.progress 回写结果（task id=${task.id}）` });
      } else {
        finish({ kind: "failed", error: `${task.name}: CLI exit=${code} signal=${signal ?? "-"} — ${errTail || out || "无输出"}` });
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  Adapter：callback
// ═══════════════════════════════════════════════════════════════

/**
 * 认领占位模式：立即回写 progress 25 + awaiting_result，任务保持未完成，
 * 由对端系统自行调 taskboard.progress 完成。connector 继续轮询下一任务。
 */
async function runCallbackAdapter(cfg, task) {
  const note = `已认领，等待外部系统异步回写（connector=${cfg.mode} callback，数字 taskId=${task.id}，回写过程 taskboard.progress {id:${task.id},...}）`;
  const ok = await reportAwaiting(cfg, task, note);
  return { kind: "kept", ok };
}

// ═══════════════════════════════════════════════════════════════
//  执行编排：认领 → adapter → 回写
// ═══════════════════════════════════════════════════════════════

async function executeTask(cfg, task) {
  const t0 = Date.now();
  L.info(`🎯 认领到任务 ${task.name} (id=${task.id} taskId=${task.taskId})`, {
    mode: cfg.mode,
    approvalRequired: task.approvalRequired ?? false,
  });
  const prompt = buildPrompt(task);

  let result;
  try {
    if (cfg.mode === "http") result = await runHttpAdapter(cfg, task, prompt);
    else if (cfg.mode === "cli") result = await runCliAdapter(cfg, task, prompt);
    else result = await runCallbackAdapter(cfg, task);
  } catch (err) {
    // adapter 内部应自捕获；这里是最后防线，避免执行器裸退
    result = { kind: "failed", error: `${task.name}: adapter 未捕获异常 — ${err?.message ?? err}` };
  }

  const elapsedMs = Date.now() - t0;
  if (result.kind === "done") {
    await reportDone(cfg, task, result.output);
  } else if (result.kind === "failed") {
    await reportFailed(cfg, task, result.error);
  } else if (result.kind === "awaiting") {
    await reportAwaiting(cfg, task, result.note);
  }
  L.info(`✅ 任务处理结束 ${task.name} (id=${task.id})`, { kind: result.kind, elapsedMs });
}

// ═══════════════════════════════════════════════════════════════
//  主循环：轮询认领 + 心跳 + 优雅退出
// ═══════════════════════════════════════════════════════════════

async function main() {
  let flags;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`配置错误: ${e.message}\n\n`);
    printUsage();
    process.exit(2);
  }
  if (flags.help) { printUsage(); process.exit(0); }
  if (flags.debug) LOG_DEBUG = true;

  const { cfg, errors } = resolveConfig(flags);
  if (errors.length) {
    for (const e of errors) process.stderr.write(`配置错误: ${e}\n`);
    process.stderr.write(`\n必填：TIANGONG_MCP_KEY 与 TIANGONG_AGENT_ID（--key/--agent-id 或 env）。\n`);
    process.exit(1);
  }

  if (flags.selftest) {
    // 干跑：打印解析后的配置+模式即退出，绝不联网。
    process.stdout.write(JSON.stringify(selftestSummary(cfg), null, 2) + "\n");
    process.exit(0);
  }

  // 运行时纪律：key 不进子进程 env（cli adapter 里再兜一层），不进 stdout 日志。
  L.info(`🚀 universal-connector v${VERSION} 启动`, {
    baseUrl: cfg.baseUrl,
    agentId: cfg.agentId,
    mode: cfg.mode,
    pollMs: cfg.pollMs,
    heartbeatMs: cfg.heartbeatMs,
    execTimeout: cfg.execTimeout,
    node: process.version,
  });

  let stopping = false;
  let busy = false;
  let claimTick = null;

  // ── 认领轮询 tick（重入保护：一轮任务未完不认领下一个）──
  const doClaimTick = async () => {
    if (stopping || busy || claimTick) return;
    busy = true;
    claimTick = true;
    try {
      const r = await trpcCall(cfg, "agent.claimTask", { agentId: cfg.agentId });
      if (!r.ok) {
        L.warn(`认领检查失败: ${r.error}`);
        return;
      }
      const data = r.data ?? {};
      if (data.reason === "budget_exhausted") {
        L.warn("预算熔断：本轮不认领任务（agent budget exhausted）");
        return;
      }
      const task = data.task ?? null;
      if (!task) {
        L.debug("无可认领任务");
        return;
      }
      await executeTask(cfg, task);
    } catch (e) {
      L.warn(`认领轮询异常: ${e?.message ?? e}`);
    } finally {
      busy = false;
      claimTick = null;
    }
  };

  // ── 心跳：agent.updateHeartbeat {id}（实际 API 无 status 字段，服务端自行置 online）──
  const doHeartbeat = async () => {
    if (stopping) return;
    const r = await trpcCall(cfg, "agent.updateHeartbeat", { id: cfg.agentId });
    if (!r.ok) {
      L.warn(`心跳失败: ${r.error}`);
      return;
    }
    // updateHeartbeat 也会附带认领任务（claimedTask）。不能丢：空闲时直接执行，
    // 忙时只能靠超时重派兜底（会延迟），故记 warn 便于排查。
    const extra = r.data?.claimedTask ?? null;
    if (extra) {
      if (!busy) {
        L.info(`心跳附带认领 ${extra.name ?? extra.id ?? "?"}，空闲直接执行`);
        busy = true;
        try { await executeTask(cfg, extra); } finally { busy = false; }
      } else {
        L.warn(`心跳附带认领 ${extra.name ?? extra.id ?? "?"}，当前忙碌无法执行，等超时重派兜底`);
      }
    }
    L.debug("💓 心跳成功");
  };

  const pollTimer = setInterval(() => { doClaimTick().catch((e) => L.warn(`轮询 tick 异常: ${e?.message ?? e}`)); }, cfg.pollMs);
  const hbTimer = setInterval(() => { doHeartbeat().catch((e) => L.warn(`心跳 tick 异常: ${e?.message ?? e}`)); }, cfg.heartbeatMs);

  // ── 优雅退出：停轮询，等当前任务收尾；二次信号立即强退 ──
  const onSignal = (sig) => {
    if (stopping) {
      L.warn(`${sig} 二次信号，立即强制退出（当前任务可能未回写终态）`);
      process.exit(1);
    }
    stopping = true;
    clearInterval(pollTimer);
    clearInterval(hbTimer);
    L.info(`🛑 收到 ${sig}，停止轮询；${busy ? "等待当前任务收尾…" : "无进行中任务，退出"}`);
    if (!busy) process.exit(0);
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  // 启动即各打一次，不等首个 interval
  doHeartbeat().catch(() => {});
  doClaimTick().catch(() => {});

  // 退出等待：busy 收尾后自然结束进程（timers 已 clear，事件环空了自退）。
  // 兜底：收尾最长等 execTimeout，超时强退，避免信号后卡死。
  const deadline = Date.now() + cfg.execTimeout;
  while (busy && Date.now() < deadline) {
    await sleep(250);
  }
  if (stopping) {
    if (busy) L.warn("收尾等待超时，强制退出");
    process.exit(0);
  }
}

main().catch((err) => {
  L.error(`执行器崩溃: ${err?.stack ?? err}`);
  process.exit(1);
});
