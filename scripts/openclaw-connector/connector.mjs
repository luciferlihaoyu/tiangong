#!/usr/bin/env node

/**
 * 天宫 OpenClaw Connector (P2)
 *
 * 让真实 OpenClaw 助手作为 Agent 接入天宫：
 * - 维持 WebSocket 长连接
 * - 定时心跳保持 Agent 在线
 * - 自动认领分派任务并回传结果
 * - 处理 WebSocket 消息（记录 + ACK）
 * - 自动重连（指数退避，上限 30s）
 * - P2: 可配置执行桥（mock / command）
 *
 * 用法：
 *   # 通过 JSON 配置文件按名称选择 Agent
 *   node connector.mjs --config ./agents.json --agent-name meizhizi
 *
 *   # 通过环境变量或命令行直接指定
 *   node connector.mjs --agent-id 1 --token tg-xxx
 *   TIANGONG_AGENT_ID=1 TIANGONG_MCP_KEY=tg-xxx node connector.mjs
 *
 *   # command 模式（通过 stdin 传 prompt 给可信命令）
 *   TIANGONG_EXEC_MODE=command \
 *   TIANGONG_EXEC_COMMAND="node ./scripts/openclaw-connector/examples/echo-runner.mjs" \
 *   node connector.mjs --config agents.json -n codemaster
 *
 *   # 查看帮助
 *   node connector.mjs --help
 *
 * 环境变量：
 *   TIANGONG_HTTP_BASE        tRPC HTTP base (default: http://localhost:3999)
 *   TIANGONG_WS_BASE          WebSocket base (default: ws://localhost:3999)
 *   TIANGONG_AGENT_ID         Agent 在天宫的数据库 ID
 *   TIANGONG_MCP_KEY          Agent 绑定的 MCP API Key (token)
 *   TIANGONG_AGENT_NAME       Agent 显示名称
 *   TIANGONG_EXEC_MODE          执行模式: mock|command (default: mock)
 *   TIANGONG_EXEC_FILE        command 模式执行文件路径 (优先于 execCommand)
 *   TIANGONG_EXEC_ARGS_JSON  command 模式执行参数 JSON 数组
 *   TIANGONG_EXEC_COMMAND     command 模式命令模板 (legacy, trusted-only)
 *   TIANGONG_EXEC_TIMEOUT_MS  执行超时 ms (default: 300000)
 *   TIANGONG_RESULT_MAX_CHARS 结果最大字符数 (default: 12000)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

// ─── Optional dotenv support ───
try {
  const { config } = await import("dotenv");
  config();
} catch {
  // dotenv not available, skip
}

// ═══════════════════════════════════════════════════════════════
//  Config
// ═══════════════════════════════════════════════════════════════

const HTTP_BASE = process.env.TIANGONG_HTTP_BASE || "http://localhost:3999";
const WS_BASE = process.env.TIANGONG_WS_BASE || "ws://localhost:3999";

class Config {
  constructor() {
    /** @type {number} */
    this.agentId = parseInt(process.env.TIANGONG_AGENT_ID || "0", 10) || 0;
    /** @type {string} */
    this.token = process.env.TIANGONG_MCP_KEY || "";
    /** @type {string} */
    this.agentName = process.env.TIANGONG_AGENT_NAME || `Agent#${this.agentId || "?"}`;
    /** @type {string} */
    this.httpBase = HTTP_BASE.replace(/\/$/, "");
    /** @type {string} */
    this.wsBase = WS_BASE.replace(/\/$/, "");
    /** @type {number} */
    this.heartbeatIntervalMs = 30_000;
    /** @type {number} */
    this.reconnectBaseMs = 1_000;
    /** @type {number} */
    this.reconnectMaxMs = 30_000;
    /** @type {string|null} */
    this.configPath = null;

    // ─── P2: Execution config ───
    /** @type {"mock"|"command"} */
    this.execMode = process.env.TIANGONG_EXEC_MODE || "mock";
    /** @type {string} */
    this.execFile = process.env.TIANGONG_EXEC_FILE || "";
    /** @type {string[]} */
    this.execArgs = this._parseExecArgs(process.env.TIANGONG_EXEC_ARGS_JSON);
    /** @type {string} */
    this.execCommand = process.env.TIANGONG_EXEC_COMMAND || "";
    /** @type {number} */
    this.execTimeoutMs = parseInt(process.env.TIANGONG_EXEC_TIMEOUT_MS || "300000", 10) || 300000;
    /** @type {number} */
    this.resultMaxChars = parseInt(process.env.TIANGONG_RESULT_MAX_CHARS || "12000", 10) || 12000;
  }

  /**
   * Parse TIANGONG_EXEC_ARGS_JSON environment variable
   * @param {string|undefined} json
   * @returns {string[]}
   */
  _parseExecArgs(json) {
    if (!json) return [];
    try {
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
        throw new Error("TIANGONG_EXEC_ARGS_JSON must be a JSON array of strings");
      }
      return parsed;
    } catch (err) {
      throw new Error(`Invalid TIANGONG_EXEC_ARGS_JSON: ${err.message}`);
    }
  }

  /** Load from JSON config file */
  static fromConfigFile(path, agentSelector) {
    const fullPath = resolve(path);
    const raw = readFileSync(fullPath, "utf-8");
    const data = JSON.parse(raw);
    const agents = Array.isArray(data) ? data : data.agents || [];

    if (!agents || agents.length === 0) {
      throw new Error(`Config file ${path} contains no agents`);
    }

    let agent;
    if (agentSelector) {
      agent = agents.find(
        (a) => a.name === agentSelector || String(a.agentId) === String(agentSelector)
      );
      if (!agent) {
        throw new Error(
          `Agent "${agentSelector}" not found in config. Available: ${agents.map((a) => `${a.name} (id=${a.agentId})`).join(", ")}`
        );
      }
    } else {
      agent = agents[0];
      console.log(`[config] Using first agent: ${agent.name} (id=${agent.agentId})`);
    }

    const cfg = new Config();
    cfg.agentId = agent.agentId;
    cfg.token = agent.token;
    cfg.agentName = agent.label || agent.name || `Agent#${agent.agentId}`;
    cfg.configPath = fullPath;

    // Config file can override http/ws base
    if (agent.httpBase) cfg.httpBase = agent.httpBase.replace(/\/$/, "");
    if (agent.wsBase) cfg.wsBase = agent.wsBase.replace(/\/$/, "");

    // ─── P2: Per-agent exec overrides ───
    if (agent.execMode) cfg.execMode = agent.execMode;
    if (agent.execFile) cfg.execFile = agent.execFile;
    if (agent.execArgs !== undefined) {
      if (!Array.isArray(agent.execArgs) || !agent.execArgs.every((v) => typeof v === "string")) {
        throw new Error(`agent.execArgs for ${agent.name || agent.agentId} must be an array of strings`);
      }
      cfg.execArgs = agent.execArgs;
    }
    if (agent.execCommand) cfg.execCommand = agent.execCommand;
    if (agent.execTimeoutMs) cfg.execTimeoutMs = agent.execTimeoutMs;
    if (agent.resultMaxChars) cfg.resultMaxChars = agent.resultMaxChars;

    return cfg;
  }

  /** Validate required fields */
  validate() {
    if (!this.agentId || isNaN(this.agentId) || this.agentId <= 0) {
      throw new Error("Missing or invalid TIANGONG_AGENT_ID");
    }
    if (!this.token || this.token.length < 16) {
      throw new Error("Missing or invalid TIANGONG_MCP_KEY (token must be >= 16 chars)");
    }
    if (this.execMode !== "mock" && this.execMode !== "command") {
      throw new Error("Invalid exec mode: must be mock or command");
    }
    if (this.execMode === "command" && !this.execFile && !this.execCommand) {
      throw new Error("execMode=command requires execFile/execArgs OR execCommand (legacy)");
    }
    if (!Number.isFinite(this.execTimeoutMs) || this.execTimeoutMs <= 0) {
      throw new Error("Invalid execution timeout: must be a positive number");
    }
    if (!Number.isFinite(this.resultMaxChars) || this.resultMaxChars <= 0) {
      throw new Error("Invalid result max chars: must be a positive number");
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Logging
// ═══════════════════════════════════════════════════════════════

function maskToken(s) {
  if (!s || s.length <= 12) return "***";
  return s.slice(0, 6) + "..." + s.slice(-6);
}

function sanitize(obj) {
  if (!obj) return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone.token) clone.token = maskToken(clone.token);
  if (clone.key) clone.key = maskToken(clone.key);
  if (clone.mcpKey) clone.mcpKey = maskToken(clone.mcpKey);
  return clone;
}

function log(level, msg, extra) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const prefix = `[${ts}] [${level.toUpperCase()}]`;
  if (extra !== undefined) {
    console.log(`${prefix} ${msg}`, sanitize(extra));
  } else {
    console.log(`${prefix} ${msg}`);
  }
}

// Shorthand
const L = {
  info: (msg, extra) => log("info", msg, extra),
  warn: (msg, extra) => log("warn", msg, extra),
  error: (msg, extra) => log("error", msg, extra),
  debug: (msg, extra) => log("debug", msg, extra),
};

// ═══════════════════════════════════════════════════════════════
//  tRPC HTTP helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Call a tRPC mutation via HTTP POST.
 * All Tiangong procedures are publicQuery.mutation(), so they accept POST with JSON body.
 *
 * @param {Config} cfg
 * @param {string} procedure - e.g. "agent.updateHeartbeat"
 * @param {object} input - procedure input
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
async function trpcCall(cfg, procedure, input) {
  const url = `${cfg.httpBase}/api/trpc/${procedure}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const json = await res.json();

    // tRPC v11 wraps result in { result: { data: ... } }
    if (json.result && json.result.data !== undefined) {
      return { ok: true, data: json.result.data };
    }

    // Sometimes tRPC returns data directly
    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
//  P2: Task prompt builder
// ═══════════════════════════════════════════════════════════════

/**
 * Build a prompt string from a Tiangong task for execution.
 * Does NOT include token/key — safe to pass to external processes.
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, input?: string }} task
 * @returns {string}
 */
function buildTaskPrompt(cfg, task) {
  const lines = [
    `=== Tiangong Task ===`,
    `Task ID: ${task.taskId}`,
    `Name: ${task.name}`,
    `Agent: ${cfg.agentName} (ID=${cfg.agentId})`,
  ];
  if (task.description) {
    lines.push(`Description: ${task.description}`);
  }
  if (task.input) {
    lines.push(`Input: ${task.input}`);
  }
  lines.push(``);
  lines.push(`Please execute this task and return a concise result.`);
  lines.push(`The output will be written back to Tiangong as the task result.`);
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
//  P2: Execution functions
// ═══════════════════════════════════════════════════════════════

/**
 * Execute a task in mock mode — simulate work and return a fake result.
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, input?: string }} task
 * @returns {Promise<string>}
 */
async function executeMock(cfg, task) {
  await sleep(1500);
  const lines = [
    `[${cfg.agentName}] 任务完成 ✅`,
    `Task: ${task.name}`,
    `ID: ${task.taskId}`,
    `Mode: mock`,
  ];
  if (task.description) {
    lines.push(`Description: ${task.description}`);
  }
  return lines.join("\n");
}

/**
 * Execute a task in command mode — spawn a trusted command, pass prompt via stdin,
 * capture stdout/stderr, enforce timeout.
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, input?: string }} task
 * @param {string} prompt - prompt built by buildTaskPrompt (no token/key inside)
 * @returns {Promise<string>}
 */
function executeCommand(cfg, task, prompt) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    // Do not expose Tiangong connector credentials to the execution command.
    // The command may use its own OpenClaw/provider credentials from the environment,
    // but it should not need the MCP key used by this connector to talk to Tiangong.
    delete childEnv.TIANGONG_MCP_KEY;
    delete childEnv.TIANGONG_TOKEN;

    // P5: Use execFile+execArgs (argv mode, shell:false) if configured; otherwise fallback to legacy execCommand
    let child;
    if (cfg.execFile) {
      L.info(`🚀 执行任务 (command mode: argv)`);
      child = spawn(cfg.execFile, cfg.execArgs, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
    } else {
      L.info(`🚀 执行任务 (command mode: legacy string)`);
      child = spawn(cfg.execCommand, {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Force kill after 5s grace
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5000);
    }, cfg.execTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        const errMsg = `Execution timed out after ${cfg.execTimeoutMs}ms`;
        L.warn(`⏰ ${errMsg}`);
        reject(new Error(errMsg));
        return;
      }

      const output = truncateOutput(stdout, cfg.resultMaxChars);
      const errOutput = truncateOutput(stderr, cfg.resultMaxChars);

      if (code !== 0) {
        const errMsg = `Command exited with code ${code}` + (errOutput ? `\nStderr: ${errOutput}` : "");
        L.warn(`❌ ${errMsg}`);
        reject(new Error(errMsg));
        return;
      }

      // Log stderr as warning if present but command succeeded
      if (stderr.trim()) {
        L.warn(`Command stderr (non-fatal): ${truncateOutput(stderr, 500)}`);
      }

      resolve(output || "(no output)");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      L.error(`Command spawn error: ${err.message}`);
      reject(new Error(`Failed to spawn command: ${err.message}`));
    });

    // Write prompt to stdin and close it
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      clearTimeout(timer);
      reject(new Error(`Failed to write to stdin: ${err.message}`));
    }
  });
}

/**
 * Execute a task according to config.execMode.
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, input?: string }} task
 * @returns {Promise<string>}
 */
async function executeTask(cfg, task) {
  if (cfg.execMode === "command") {
    const prompt = buildTaskPrompt(cfg, task);
    L.info(`🚀 执行任务 (command mode)`);
    L.debug(`Prompt prepared for task ${task.taskId}; chars=${prompt.length}`);
    return executeCommand(cfg, task, prompt);
  }

  // Default: mock
  L.info(`🎭 执行任务 (mock mode)`);
  return executeMock(cfg, task);
}

// ═══════════════════════════════════════════════════════════════
//  P2: Task processing (upgraded)
// ═══════════════════════════════════════════════════════════════

/**
 * Process a claimed or assigned task.
 * P2: uses executeTask for real/mock execution.
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, input?: string }} task
 */
async function processTask(cfg, task) {
  L.info(`🎯 开始处理任务: ${task.name} (taskId=${task.taskId})`);

  // Step 1: Mark running with progress 10
  let r = await trpcCall(cfg, "task.updateProgress", {
    id: task.id,
    progress: 10,
    status: "running",
    output: `[${cfg.agentName}] 开始执行 (mode=${cfg.execMode})...`,
  });
  if (!r.ok) L.warn(`报告进度 10% 失败: ${r.error}`);

  try {
    // Step 2: Execute
    const result = await executeTask(cfg, task);

    // Step 3: Success — mark done with progress 100
    r = await trpcCall(cfg, "task.updateProgress", {
      id: task.id,
      progress: 100,
      status: "done",
      output: truncateOutput(result, cfg.resultMaxChars),
    });
    if (!r.ok) {
      L.warn(`报告完成失败: ${r.error}`);
    } else {
      L.info(`✅ 任务 ${task.name} 已标记为 done`);
    }
  } catch (err) {
    // Step 4: Failure — mark failed with error
    const errMsg = err.message || String(err);
    L.error(`❌ 任务 ${task.name} 执行失败: ${errMsg}`);

    r = await trpcCall(cfg, "task.updateProgress", {
      id: task.id,
      progress: 0,
      status: "failed",
      error: truncateOutput(errMsg, cfg.resultMaxChars),
      output: truncateOutput(`[${cfg.agentName}] 执行失败: ${errMsg}`, cfg.resultMaxChars),
    });
    if (!r.ok) {
      L.warn(`报告失败状态失败: ${r.error}`);
    } else {
      L.info(`⚠️ 任务 ${task.name} 已标记为 failed`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Message handling
// ═══════════════════════════════════════════════════════════════

/**
 * Send an ACK or response message back to the sender.
 *
 * @param {Config} cfg
 * @param {number} toAgentId - agent to reply to
 * @param {string} content
 * @param {string} type - message type
 */
async function sendMessage(cfg, toAgentId, content, type = "response", conversationId = undefined) {
  const msgData = {
    fromAgent: cfg.agentId,
    toAgent: toAgentId,
    content: content,
    type: type,
  };
  if (conversationId !== undefined) msgData.conversationId = conversationId;
  const r = await trpcCall(cfg, "message.send", msgData);
  if (!r.ok) {
    L.warn(`发送消息到 Agent#${toAgentId} 失败: ${r.error}`);
  } else {
    L.info(`📤 ACK → Agent#${toAgentId}: ${content.slice(0, 80)}`);
  }
}

/**
 * P3 Session Runner: handle a command message by spawning a real OpenClaw session.
 * Uses execFile (openclaw-agent-runner.mjs) to get an AI-generated reply.
 * Sends the reply back to the sender via tRPC message.send.
 *
 * @param {Config} cfg
 * @param {{ fromAgent: number, toAgent: number, content: string, id: number, type: string }} msg
 */
async function handleCommand(cfg, msg) {
  const prompt = buildMessagePrompt(cfg, msg);

  L.info(`🧠 启动 OpenClaw 会话处理 command: ${(msg.content || "").slice(0, 100)}`);

  const childEnv = { ...process.env };
  delete childEnv.TIANGONG_MCP_KEY;
  delete childEnv.TIANGONG_TOKEN;

  const result = await new Promise((resolve) => {
    const child = spawn(cfg.execFile, cfg.execArgs, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
    }, cfg.execTimeoutMs);

    child.stdin.write(prompt);
    child.stdin.end();

    const MAX_BYTES = 1_048_576;
    child.stdout.on("data", (chunk) => { const s = chunk.toString(); if (stdout.length < MAX_BYTES) stdout += s; });
    child.stderr.on("data", (chunk) => { const s = chunk.toString(); if (stderr.length < MAX_BYTES) stderr += s; });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ text: `[${cfg.agentName}] 处理超时` });
      } else if (code !== 0) {
        L.warn(`OpenClaw 退出码 ${code}: ${stderr.slice(0, 200)}`);
        resolve({ text: `[${cfg.agentName}] 处理出错` });
      } else {
        resolve({ text: stdout.trim() });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      L.warn(`OpenClaw spawn error: ${err.message}`);
      resolve({ text: `[${cfg.agentName}] 执行错误: ${err.message}` });
    });
  });

  const responseText = result.text || "[无输出]";
  L.info(`✅ OpenClaw 回复 (${responseText.length} chars): ${responseText.slice(0, 120)}`);

  await sendMessage(cfg, Number(msg.fromAgent), responseText, "response");
}

/**
 * Build a prompt for the OpenClaw session from an incoming command message.
 *
 * @param {Config} cfg
 * @param {{ fromAgent: number, toAgent: number, content: string, id: number }} msg
 * @returns {string}
 */
function buildMessagePrompt(cfg, msg) {
  return [
    `=== Tiangong Task ===`,
    `Task ID: MSG-${msg.id}`,
    `Name: 回复消息`,
    ``,
    `你收到了来自 Agent#${msg.fromAgent} 的一条消息。`,
    `你是 ${cfg.agentName} (Agent#${cfg.agentId})。`,
    ``,
    `--- 消息内容 ---`,
    msg.content || "(空)",
    `--- 消息结束 ---`,
    ``,
    `请以你的身份自然回复这条消息。`,
    `不要输出 "ACK" 或 "收到指令"——这是给 AI 模型思考后回复的。`,
    `用中文回复。如果你不知道怎么回复，可以说"收到，正在处理"。`,
  ].join("\n");
}

/**
 * Handle an incoming WebSocket message event.
 *
 * Expected message shapes:
 *   { type: "message", message: { id, fromAgent, toAgent, content, type } }
 *   { type: "broadcast", message: { id, fromAgent, content, type } }
 *   { type: "offline_messages", messages: [...], count: number }
 *   { type: "pong", timestamp: ... }
 *   { type: "error", message: ... }
 *
 * @param {Config} cfg
 * @param {object} data - parsed JSON from WebSocket
 */
async function handleWSMessage(cfg, data) {
  const msgType = data.type || "unknown";

  switch (msgType) {
    case "pong":
      // Silent heartbeat response
      break;

    case "offline_messages": {
      const msgs = data.messages || [];
      L.info(`📬 收到 ${msgs.length} 条离线消息`);
      for (const m of msgs) {
        L.info(`  ← Agent#${m.fromAgent}: ${(m.content || "").slice(0, 120)}`);
      }
      break;
    }

    case "message": {
      const msg = data.message || {};
      L.info(
        `📩 消息 Agent#${msg.fromAgent} → Agent#${msg.toAgent}: ${(msg.content || "").slice(0, 160)}`
      );

      // Send ACK only for command-type messages.
      // Never ACK response messages, otherwise two connectors can create an ACK ping-pong loop.
      if (msg.type === "command" && msg.fromAgent && msg.fromAgent !== cfg.agentId) {
        const ackContent = `ACK: 收到指令 "${(msg.content || "").slice(0, 60)}"`;
        await sendMessage(cfg, msg.fromAgent, ackContent, "response");

        // P3: command mode spawns real OpenClaw session to reply
        if (cfg.execMode === "command") {
          handleCommand(cfg, msg).catch((err) => {
            L.warn(`处理 command 失败: ${err.message}`);
          });
        }
      }
      break;
    }

    case "broadcast": {
      const msg = data.message || {};
      L.info(`📣 广播 Agent#${msg.fromAgent}: ${(msg.content || "").slice(0, 160)}`);
      break;
    }

    case "error": {
      L.warn(`⚠️ 服务端错误: ${data.message || JSON.stringify(data)}`);
      break;
    }

    default:
      L.debug(`📨 未识别消息类型: ${msgType}`, {
        preview: JSON.stringify(data).slice(0, 300),
      });
  }
}

// ═══════════════════════════════════════════════════════════════
//  Heartbeat
// ═══════════════════════════════════════════════════════════════

/**
 * Call heartbeat and handle any claimed tasks in response.
 *
 * @param {Config} cfg
 * @returns {Promise<boolean>} true if heartbeat was successful
 */
async function doHeartbeat(cfg) {
  const r = await trpcCall(cfg, "agent.updateHeartbeat", { id: cfg.agentId });
  if (!r.ok) {
    L.warn(`心跳失败: ${r.error}`);
    return false;
  }

  L.debug("💓 心跳成功");

  const claimedTask = r.data && r.data.claimedTask;
  if (claimedTask) {
    L.info(`🎯 心跳认领到任务: ${claimedTask.name}`);
    await processTask(cfg, claimedTask);
    return true;
  }

  // Fallback: older Tiangong deployments may not claim inside heartbeat.
  const claim = await trpcCall(cfg, "agent.claimTask", { agentId: cfg.agentId });
  if (!claim.ok) {
    L.debug(`主动认领检查失败: ${claim.error}`);
    return true;
  }
  if (claim.data && claim.data.task) {
    L.info(`🎯 主动认领到任务: ${claim.data.task.name}`);
    await processTask(cfg, claim.data.task);
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════
//  WebSocket connection
// ═══════════════════════════════════════════════════════════════

/**
 * Connect to Tiangong WebSocket and run the main event loop.
 * Blocks until disconnected (then returns for reconnect logic).
 *
 * @param {Config} cfg
 * @returns {Promise<{exit: boolean}>}
 */
function connectWS(cfg) {
  return new Promise((resolve) => {
    const wsUrl = `${cfg.wsBase}/ws?agentId=${cfg.agentId}&token=${encodeURIComponent(cfg.token)}`;
    const maskedUrl = `${cfg.wsBase}/ws?agentId=${cfg.agentId}&token=${maskToken(cfg.token)}`;

    L.info(`🔌 连接天宫: ${maskedUrl}`);

    const ws = new WebSocket(wsUrl);

    let heartbeatTimer = null;
    let pingTimer = null;
    let resolved = false;

    function cleanup() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    }

    function done(exit) {
      if (resolved) return;
      resolved = true;
      cleanup();
      try { ws.close(); } catch {}
      resolve({ exit });
    }

    ws.onopen = () => {
      L.info(`✅ ${cfg.agentName} (Agent#${cfg.agentId}) 已连接天宫 WebSocket`);
      const wsExecDetail = cfg.execMode === "command"
        ? (cfg.execFile ? " (argv mode)" : " (legacy string mode)")
        : "";
      L.info(`   执行模式: ${cfg.execMode}${wsExecDetail}`);

      // Start heartbeat via HTTP (more reliable than WS ping for status updates)
      heartbeatTimer = setInterval(() => {
        doHeartbeat(cfg).catch((e) => L.error(`心跳异常: ${e.message}`));
      }, cfg.heartbeatIntervalMs);

      // Also send WS-level ping every 30s (server responds with pong, updates lastHeartbeat)
      pingTimer = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          // Connection likely dead, ws.onclose will fire
        }
      }, 30_000);

      // Initial heartbeat
      doHeartbeat(cfg).catch((e) => L.error(`初始心跳异常: ${e.message}`));
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        L.warn(`收到非法 JSON: ${String(event.data).slice(0, 200)}`);
        return;
      }
      handleWSMessage(cfg, data).catch((e) => L.error(`消息处理异常: ${e.message}`));
    };

    ws.onclose = (event) => {
      L.info(`🔌 WebSocket 断开 (code=${event.code}, reason=${event.reason || "none"})`);
      done(false);
    };

    ws.onerror = (err) => {
      L.error(`WebSocket 错误`, err && err.message ? { error: err.message } : undefined);
      // onclose will fire after onerror
    };
  });
}

// ═══════════════════════════════════════════════════════════════
//  Reconnection logic
// ═══════════════════════════════════════════════════════════════

/**
 * Connect with exponential backoff reconnection.
 *
 * @param {Config} cfg
 */
async function runWithReconnect(cfg) {
  let attempt = 0;

  while (true) {
    const { exit } = await connectWS(cfg);
    if (exit) {
      L.info("退出连接循环");
      break;
    }

    attempt++;
    const delay = Math.min(
      cfg.reconnectBaseMs * Math.pow(2, Math.min(attempt - 1, 5)),
      cfg.reconnectMaxMs
    );
    L.info(`🔄 ${Math.round(delay / 1000)}s 后重连 (第 ${attempt} 次)...`);
    await sleep(delay);
  }
}

// ═══════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Truncate output to maxChars, appending a truncation notice if needed.
 *
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncateOutput(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[... truncated at ${maxChars} chars, original length ${text.length}]`;
}

// ═══════════════════════════════════════════════════════════════
//  CLI
// ═══════════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
天宫 OpenClaw Connector (P2 + P5) — 助手接入器 + 可配置执行桥 (argv 加固)

用法:
  node connector.mjs [options]

选项:
  --config, -c <path>        JSON 配置文件路径 (含 agents 数组)
  --agent-name, -n <name>    从配置文件中选择 Agent (按 name 或 agentId)
  --agent-id <id>            直接指定 Agent 数据库 ID
  --token, -t <key>          直接指定 MCP API Key
  --http-base <url>          HTTP base (default: http://localhost:3999)
  --ws-base <url>            WebSocket base (default: ws://localhost:3999)
  --heartbeat, -i <ms>       心跳间隔 ms (default: 30000)

  --exec-mode <mode>         执行模式: mock|command (default: mock)
  --exec-file <path>         command 模式执行文件 (推荐, argv 模式)
  --exec-args <json>         command 模式执行参数 JSON 数组
  --exec-command <cmd>       command 模式命令 (legacy, trusted-only)
  --exec-timeout <ms>        执行超时 ms (default: 300000)
  --result-max-chars <n>     结果最大字符数 (default: 12000)

  --help, -h                 显示帮助

环境变量:
  TIANGONG_HTTP_BASE         同 --http-base
  TIANGONG_WS_BASE           同 --ws-base
  TIANGONG_AGENT_ID          Agent ID (number)
  TIANGONG_MCP_KEY           Agent 的 MCP API Key
  TIANGONG_AGENT_NAME        Agent 显示名称
  TIANGONG_EXEC_MODE         执行模式: mock|command (default: mock)
  TIANGONG_EXEC_FILE         command 模式执行文件路径 (推荐, argv 模式)
  TIANGONG_EXEC_ARGS_JSON   command 模式执行参数 JSON 数组
  TIANGONG_EXEC_COMMAND      command 模式命令 (legacy, trusted-only)
  TIANGONG_EXEC_TIMEOUT_MS  执行超时 ms (default: 300000)
  TIANGONG_RESULT_MAX_CHARS 结果最大字符数 (default: 12000)

示例:
  # 使用配置文件 (mock 模式)
  node connector.mjs --config ./agents.json --agent-name meizhizi

  # 直接指定
  node connector.mjs --agent-id 1 --token tg-xxx

  # 环境变量
  TIANGONG_AGENT_ID=1 TIANGONG_MCP_KEY=tg-xxx node connector.mjs

  # command 模式 (argv 推荐) — 用 echo-runner 做烟测
  TIANGONG_EXEC_MODE=command \\
  TIANGONG_EXEC_FILE=node \\
  TIANGONG_EXEC_ARGS_JSON='["./scripts/openclaw-connector/examples/echo-runner.mjs"]' \\
  node connector.mjs --config agents.json -n codemaster

  # command 模式 (legacy 字符串方式)
  TIANGONG_EXEC_MODE=command \\
  TIANGONG_EXEC_COMMAND="node ./scripts/openclaw-connector/examples/echo-runner.mjs" \\
  node connector.mjs --config agents.json -n codemaster

  # 连接到线上天宫
  node connector.mjs -c agents.json -n codemaster \\
    --http-base https://tiangg.zeabur.app \\
    --ws-base wss://tiangg.zeabur.app
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    configPath: null,
    agentName: null,
    agentId: null,
    token: null,
    httpBase: null,
    wsBase: null,
    heartbeatMs: null,
    // P2
    execMode: null,
    execFile: null,
    execArgs: null,
    execCommand: null,
    execTimeoutMs: null,
    resultMaxChars: null,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--config":
      case "-c":
        opts.configPath = next;
        i++;
        break;
      case "--agent-name":
      case "-n":
        opts.agentName = next;
        i++;
        break;
      case "--agent-id":
        opts.agentId = parseInt(next, 10);
        i++;
        break;
      case "--token":
      case "-t":
        opts.token = next;
        i++;
        break;
      case "--http-base":
        opts.httpBase = next;
        i++;
        break;
      case "--ws-base":
        opts.wsBase = next;
        i++;
        break;
      case "--heartbeat":
      case "-i":
        opts.heartbeatMs = parseInt(next, 10);
        i++;
        break;
      // P2
      case "--exec-mode":
        opts.execMode = next;
        i++;
        break;
      case "--exec-file":
        opts.execFile = next;
        i++;
        break;
      case "--exec-args":
        try {
          opts.execArgs = JSON.parse(next);
          if (!Array.isArray(opts.execArgs)) opts.execArgs = null;
        } catch {
          opts.execArgs = null;
        }
        i++;
        break;
      case "--exec-command":
        opts.execCommand = next;
        i++;
        break;
      case "--exec-timeout":
        opts.execTimeoutMs = parseInt(next, 10);
        i++;
        break;
      case "--result-max-chars":
        opts.resultMaxChars = parseInt(next, 10);
        i++;
        break;
      case "--help":
      case "-h":
        opts.help = true;
        break;
      default:
        console.error(`未知选项: ${arg}`);
        opts.help = true;
    }
  }

  return opts;
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgs();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  /** @type {Config} */
  let cfg;

  try {
    if (opts.configPath) {
      cfg = Config.fromConfigFile(opts.configPath, opts.agentName);
    } else {
      cfg = new Config();
      if (opts.agentId) cfg.agentId = opts.agentId;
      if (opts.token) cfg.token = opts.token;
      if (opts.agentName) cfg.agentName = opts.agentName;
    }

    // CLI overrides (P1 + P2)
    if (opts.httpBase) cfg.httpBase = opts.httpBase.replace(/\/$/, "");
    if (opts.wsBase) cfg.wsBase = opts.wsBase.replace(/\/$/, "");
    if (opts.heartbeatMs) cfg.heartbeatIntervalMs = opts.heartbeatMs;
    if (opts.execMode) cfg.execMode = opts.execMode;
    if (opts.execFile) cfg.execFile = opts.execFile;
    if (opts.execArgs) cfg.execArgs = opts.execArgs;
    if (opts.execCommand) cfg.execCommand = opts.execCommand;
    if (opts.execTimeoutMs) cfg.execTimeoutMs = opts.execTimeoutMs;
    if (opts.resultMaxChars) cfg.resultMaxChars = opts.resultMaxChars;

    cfg.validate();
  } catch (err) {
    console.error(`❌ 配置错误: ${err.message}`);
    console.error("使用 --help 查看用法");
    process.exit(1);
  }

  L.info("═══════════════════════════════════════════");
  L.info(`天宫 OpenClaw Connector (P2) 启动`);
  L.info(`  Agent: ${cfg.agentName} (ID=${cfg.agentId})`);
  L.info(`  HTTP:  ${cfg.httpBase}`);
  L.info(`  WS:    ${cfg.wsBase}`);
  L.info(`  心跳:  ${cfg.heartbeatIntervalMs}ms`);
  L.info(`  Token: ${maskToken(cfg.token)}`);
  // P5: Show command mode type but not actual command/args for security
  const execDetail = cfg.execMode === "command"
    ? (cfg.execFile ? " (argv mode)" : " (legacy string mode)")
    : "";
  L.info(`  执行:  ${cfg.execMode}${execDetail}`);
  L.info(`  超时:  ${cfg.execTimeoutMs}ms`);
  L.info(`  截断:  ${cfg.resultMaxChars} chars`);
  L.info("═══════════════════════════════════════════");

  // Graceful shutdown
  process.on("SIGINT", () => {
    L.info("收到 SIGINT，正在退出...");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    L.info("收到 SIGTERM，正在退出...");
    process.exit(0);
  });

  await runWithReconnect(cfg);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
