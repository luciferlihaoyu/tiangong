#!/usr/bin/env node

/**
 * 天宫 OpenClaw Connector (P8.1: reliable message bus)
 *
 * 让真实 OpenClaw 助手作为 Agent 接入天宫：
 * - 维持 WebSocket 长连接
 * - 定时心跳保持 Agent 在线
 * - 自动认领分派任务并回传结果
 * - P8.1: 统一 inbox 处理，ACK/去重，离线消息补偿
 * - P2: 可配置执行桥（mock / command）
 * - 处理 WebSocket 消息（记录 + ACK）
 * - 自动重连（指数退避，上限 30s）
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
 *   TIANGONG_PROCESS_INBOX    处理 inbox 消息 (default: true, 无成本)
 *   TIANGONG_CLAIM_TASKS      认领并执行任务 (default: false, 安全默认)
 *   TIANGONG_CHEAP_MODEL      低成本模型 (default: deepseek-official/deepseek-v4-flash)
 *   TIANGONG_CHEAP_MODEL_OPS  运营内容低成本模型 (default: minimax-cn/MiniMax-M3)
 *   TIANGONG_ALLOW_EXPENSIVE_RECURRING  允许重复任务使用昂贵模型 (default: false)
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

    // ─── P8.1: inbox processing config ───
    /** @type {number} Max queued messages to process at once */
    this.inboxBatchSize = parseInt(process.env.TIANGONG_INBOX_BATCH_SIZE || "20", 10) || 20;

    // ─── P9.1: Cost guard / execution gates ───
    /** @type {boolean} Process inbox messages (safe, no model cost) — default true */
    this.processInbox = this._parseBool(process.env.TIANGONG_PROCESS_INBOX, true);
    /** @type {boolean} Claim and execute tasks (costs model calls) — default false for safety */
    this.claimTasks = this._parseBool(process.env.TIANGONG_CLAIM_TASKS, false);
    /** @type {string} Cheap model for recurring/low-priority tasks */
    this.cheapModel = process.env.TIANGONG_CHEAP_MODEL || "deepseek-official/deepseek-v4-flash";
    /** @type {string} Cheap model for ops/content tasks */
    this.cheapModelOps = process.env.TIANGONG_CHEAP_MODEL_OPS || "minimax-cn/MiniMax-M3";
    /** @type {boolean} Allow expensive models for recurring tasks */
    this.allowExpensiveRecurring = this._parseBool(process.env.TIANGONG_ALLOW_EXPENSIVE_RECURRING, false);
  }

  /**
   * Parse a boolean from a string, treating "0"/"false"/"no" as false.
   * @param {string|undefined} val
   * @param {boolean} defaultVal
   * @returns {boolean}
   */
  _parseBool(val, defaultVal) {
    if (val === undefined || val === null || val === "") return defaultVal;
    const lower = String(val).trim().toLowerCase();
    if (lower === "0" || lower === "false" || lower === "no" || lower === "off") return false;
    if (lower === "1" || lower === "true" || lower === "yes" || lower === "on") return true;
    return defaultVal;
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
    cfg.agentName = agent.label || agent.name || `Agent#${agent.agentId}`;
    cfg.token = resolveAgentToken(agent, cfg.agentId, agent.name);
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

    // ─── P9.1: Per-agent cost guard overrides ───
    if (agent.processInbox !== undefined) cfg.processInbox = Boolean(agent.processInbox);
    if (agent.claimTasks !== undefined) cfg.claimTasks = Boolean(agent.claimTasks);
    if (agent.cheapModel) cfg.cheapModel = agent.cheapModel;
    if (agent.cheapModelOps) cfg.cheapModelOps = agent.cheapModelOps;
    if (agent.allowExpensiveRecurring !== undefined) cfg.allowExpensiveRecurring = Boolean(agent.allowExpensiveRecurring);

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
    if (this.claimTasks && this.execMode === "command" && !this.allowExpensiveRecurring) {
      // safe: cheap-model guard will apply for recurring tasks
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

function envNamePart(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readTokenFile(path) {
  if (!path) return "";
  try {
    return readFileSync(resolve(path), "utf-8").trim();
  } catch {
    return "";
  }
}

function resolveAgentToken(agent, agentId, agentName) {
  if (agent.tokenEnv) {
    const fromEnv = process.env[agent.tokenEnv];
    if (fromEnv) return fromEnv.trim();
  }
  if (agent.tokenFile) {
    const fromFile = readTokenFile(agent.tokenFile);
    if (fromFile) return fromFile;
  }

  const namePart = envNamePart(agentName || agent.name);
  const candidates = [
    namePart ? `TIANGONG_${namePart}_MCP_KEY` : "",
    agentId ? `TIANGONG_AGENT_${agentId}_MCP_KEY` : "",
    "TIANGONG_MCP_KEY",
  ].filter(Boolean);

  for (const envName of candidates) {
    const value = process.env[envName];
    if (value) return value.trim();
  }

  // Backward-compatible local-only fallback. Do not commit real tokens in agents.json.
  if (agent.token) return String(agent.token).trim();
  return "";
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

    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Call a tRPC query via HTTP GET.
 *
 * tRPC rejects POST requests to query procedures with HTTP 405. Use this for
 * publicQuery endpoints such as message.inbox and message.ack.
 *
 * @param {Config} cfg
 * @param {string} procedure - e.g. "message.inbox"
 * @param {object} input - procedure input
 * @returns {Promise<{ok: boolean, data?: any, error?: string}>}
 */
async function trpcQuery(cfg, procedure, input) {
  const qs = new URLSearchParams({ input: JSON.stringify(input) });
  const url = `${cfg.httpBase}/api/trpc/${procedure}?${qs.toString()}`;
  try {
    const res = await fetch(url, { method: "GET" });

    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    const json = await res.json();

    // tRPC v11 wraps result in { result: { data: ... } }
    if (json.result && json.result.data !== undefined) {
      return { ok: true, data: json.result.data };
    }

    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════════
//  P8.1: Inbox processor (dedup + ACK)
// ═══════════════════════════════════════════════════════════════

/**
 * Dedup tracker: prevents processing the same message twice.
 * Uses a Map with periodic cleanup of old entries.
 */
class DedupTracker {
  constructor(maxAgeMs = 5 * 60_000) {
    /** @type {Map<number, number>} messageId -> timestamp */
    this.processed = new Map();
    this.maxAgeMs = maxAgeMs;
  }

  /**
   * Check if message was already processed.
   * @param {number} messageId
   * @returns {boolean} true if already processed
   */
  has(messageId) {
    const ts = this.processed.get(messageId);
    if (!ts) return false;
    if (Date.now() - ts > this.maxAgeMs) {
      this.processed.delete(messageId);
      return false;
    }
    return true;
  }

  /**
   * Mark message as processed.
   * @param {number} messageId
   */
  mark(messageId) {
    this.processed.set(messageId, Date.now());
    // Periodic cleanup every 100 marks
    if (this.processed.size % 100 === 0) this.cleanup();
  }

  /**
   * Remove expired entries.
   */
  cleanup() {
    const now = Date.now();
    for (const [id, ts] of this.processed) {
      if (now - ts > this.maxAgeMs) this.processed.delete(id);
    }
  }

  /** @returns {number} */
  get size() {
    return this.processed.size;
  }
}

/**
 * Unified inbox processor.
 *
 * Handles incoming messages (live + offline) through a single pipeline:
 * 1. Filter already-processed (by messageId) → skip
 * 2. Record as seen in dedup tracker
 * 3. Send ACK via tRPC message.ack (if not already acked by server)
 * 4. For command-type messages: optionally handle via handleCommand
 */
class InboxProcessor {
  /**
   * @param {Config} cfg
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.dedup = new DedupTracker();
  }

  /**
   * Process a batch of inbox messages.
   * @param {Array<{id: number, fromAgent: number, toAgent: number, content: string, type: string, status?: string, conversationId?: number, correlationId?: string}>} msgs
   * @param {object} [opts]
   * @param {boolean} [opts.autoAck] - auto-send ACK for unacked messages (default true)
   * @param {boolean} [opts.handleCommands] - process command messages (default true)
   * @returns {Promise<{processed: number, skipped: number, acked: number}>}
   */
  async processBatch(msgs, opts = {}) {
    const autoAck = opts.autoAck !== false;
    const handleCommands = opts.handleCommands !== false;

    let processed = 0;
    let skipped = 0;
    let acked = 0;

    for (const msg of msgs) {
      // Skip if already processed (dedup by messageId)
      if (this.dedup.has(msg.id)) {
        skipped++;
        continue;
      }

      // Mark as seen
      this.dedup.mark(msg.id);
      processed++;

      // Auto-ACK: send ACK for unacked messages
      if (autoAck && msg.status !== "acked" && msg.type !== "ack") {
        await this.sendAck(msg.id);
        acked++;
      }

      // For command messages: optionally auto-reply (smoke-safe: mock only)
      if (handleCommands && msg.type === "command" && msg.fromAgent !== this.cfg.agentId) {
        // In mock mode: send a simple ACK reply instead of spawning OpenClaw
        const ackContent =
          `ACK: 已收到指令 "${(msg.content || "").slice(0, 60)}"` +
          (msg.correlationId ? ` [corr=${msg.correlationId.slice(0, 16)}]` : "");
        await sendMessage(this.cfg, msg.fromAgent, ackContent, "response", msg.conversationId);
      }
    }

    return { processed, skipped, acked };
  }

  /**
   * Send ACK via tRPC message.ack (idempotent server-side).
   * @param {number} messageId
   */
  async sendAck(messageId) {
    const r = await trpcCall(this.cfg, "message.ack", {
      messageId,
      agentId: this.cfg.agentId,
    });
    if (r.ok) {
      L.debug(`✅ ACK message #${messageId}${r.data?.idempotent ? " (already acked)" : ""}`);
    } else {
      L.warn(`ACK message #${messageId} failed: ${r.error}`);
    }
    return r;
  }

  /**
   * Fetch and process pending inbox messages via tRPC.
   * @returns {Promise<{count: number, processed: number, skipped: number, acked: number}>}
   */
  async fetchAndProcessInbox() {
    const r = await trpcQuery(this.cfg, "message.inbox", {
      agentId: this.cfg.agentId,
      limit: this.cfg.inboxBatchSize,
      includeAcked: false,
    });

    if (!r.ok || !r.data) {
      L.warn(`Inbox fetch failed: ${r.error}`);
      return { count: 0, processed: 0, skipped: 0, acked: 0 };
    }

    const msgs = r.data;
    if (!msgs || msgs.length === 0) return { count: 0, processed: 0, skipped: 0, acked: 0 };

    const result = await this.processBatch(msgs);
    return { count: msgs.length, ...result };
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

/**
 * Build a prompt for mailbox message processing.
 * Similar to buildTaskPrompt but tailored for mailbox conversations.
 *
 * @param {Config} cfg
 * @param {{ id: number, fromMailboxId: string, toMailboxId: string, subject?: string, body?: string, type?: string }} msg
 * @returns {string}
 */
function buildMailboxPrompt(cfg, msg) {
  const lines = [
    `=== Tiangong Mailbox Message ===`,
    `Message ID: ${msg.id}`,
    `From: ${msg.fromMailboxId}`,
    `To: ${cfg.agentName}`,
    `Type: ${msg.type || "direct"}`,
  ];
  if (msg.subject) {
    lines.push(`Subject: ${msg.subject}`);
  }
  if (msg.body) {
    lines.push(``);
    lines.push(`--- Message Body ---`);
    lines.push(msg.body);
    lines.push(`--- End of Message ---`);
  }
  lines.push(``);
  lines.push(`You are ${cfg.agentName}, an AI agent in the Tiangong multi-agent platform.`);
  lines.push(`You received a message from ${msg.fromMailboxId}. Please respond naturally.`);
  lines.push(`Your reply will be sent back via the Tiangong mailbox system.`);
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
//  P9.1: Cost guard — model selection for recurring tasks
// ═══════════════════════════════════════════════════════════════

/**
 * Determine if and what cheap model should be enforced for a task.
 * Returns null if the original model should be used, otherwise the cheap model name.
 *
 * Rules:
 * - priority >= 8: always use original model (high priority override)
 * - allowExpensiveRecurring=true: use original model
 * - Ops/content tasks: use cheapModelOps
 * - All other recurring/low-priority tasks: use cheapModel
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, priority?: number }} task
 * @returns {string|null} cheap model name, or null to keep original
 */
function selectModelForTask(cfg, task) {
  // High-priority tasks always keep their original model
  if (typeof task.priority === "number" && task.priority >= 8) return null;

  // If connector is configured to allow expensive models for recurring tasks
  if (cfg.allowExpensiveRecurring) return null;

  // Determine if task is ops/content type
  const taskName = (task.name || "").toLowerCase();
  const taskDesc = (task.description || "").toLowerCase();
  const combined = taskName + " " + taskDesc;
  const isOps = /operat|content|translate|summar|运营|内容|翻译|摘要/i.test(combined);

  return isOps ? cfg.cheapModelOps : cfg.cheapModel;
}

/**
 * Rewrite the --model argument in an exec args array.
 * If --model is found, replace its value. Otherwise append --model <model>.
 *
 * @param {string[]} execArgs
 * @param {string} newModel
 * @returns {string[]} new args array (shallow copy)
 */
function rewriteModelInArgs(execArgs, newModel) {
  const result = [...execArgs];
  for (let i = 0; i < result.length - 1; i++) {
    if (result[i] === "--model") {
      result[i + 1] = newModel;
      return result;
    }
  }
  // No --model found; append it
  result.push("--model", newModel);
  return result;
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
 * P9.1: Applies cost guard — rewrites model in execArgs to cheap model
 * for recurring/low-priority tasks unless overridden.
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, input?: string, priority?: number }} task
 * @param {string} prompt - prompt built by buildTaskPrompt (no token/key inside)
 * @returns {Promise<string>}
 */
function executeCommand(cfg, task, prompt) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    delete childEnv.TIANGONG_MCP_KEY;
    delete childEnv.TIANGONG_TOKEN;

    // P9.1: Apply cost guard — use cheap model for recurring tasks
    let effectiveArgs = cfg.execArgs;
    const cheapModel = selectModelForTask(cfg, task);
    if (cheapModel) {
      effectiveArgs = rewriteModelInArgs(cfg.execArgs, cheapModel);
      L.info(`💸 成本守卫: "${task.name}" → model=${cheapModel}`);
    }

    let child;
    if (cfg.execFile) {
      L.info(`🚀 执行任务 (command mode: argv)`);
      child = spawn(cfg.execFile, effectiveArgs, {
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

  L.info(`🎭 执行任务 (mock mode)`);
  return executeMock(cfg, task);
}

// ═══════════════════════════════════════════════════════════════
//  P9: Executor Adapter + Worker Loop + Usage Reporting
// ═══════════════════════════════════════════════════════════════

/**
 * P9: Executor adapter map — makes it easy to add new execution modes.
 * Each adapter receives (cfg, task, prompt).
 * P9.1: command adapter now builds the prompt internally via buildTaskPrompt.
 */
const executorAdapters = {
  mock: (cfg, task, _prompt) => executeMock(cfg, task),
  command: (cfg, task, _prompt) => {
    const prompt = buildTaskPrompt(cfg, task);
    return executeCommand(cfg, task, prompt);
  },
};

/**
 * P9: Get the executor adapter for the current config.
 * @param {Config} cfg
 * @returns {function(Config, object): Promise<string>}
 */
function getExecutor(cfg) {
  return executorAdapters[cfg.execMode] || executorAdapters.mock;
}

/**
 * P9: Report token usage to Tiangong after task execution.
 * Simulated usage based on task complexity and execution mode.
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, input?: string }} task
 * @param {string} result
 * @param {boolean} success
 */
async function reportUsage(cfg, task, result, success) {
  const model = cfg.execMode === "command" ? "openclaw-connector" : "mock-executor";
  const provider = cfg.execMode === "command" ? "openclaw" : "tiangong-mock";

  // Simulate token counts based on task content
  const inputLen = (task.description?.length ?? 0) + (task.input?.length ?? 0) + 100;
  const outputLen = result?.length ?? 0;
  const promptTokens = Math.max(10, Math.floor(inputLen / 3));
  const completionTokens = Math.max(5, Math.floor(outputLen / 2));
  const totalTokens = promptTokens + completionTokens;
  const costCents = Math.round(totalTokens * 0.002 * 100) / 100; // ~$0.002/1K tokens

  try {
    const r = await trpcCall(cfg, "usage.record", {
      model,
      provider,
      promptTokens,
      completionTokens,
      totalTokens,
      callCount: 1,
      costCents: Math.max(1, Math.round(costCents)),
      taskId: task.id,
      agentId: cfg.agentId,
    });
    if (r.ok) {
      L.debug(`📊 用量上报: ${totalTokens} tokens (${promptTokens}+${completionTokens}), model=${model}`);
    } else {
      L.warn(`用量上报失败: ${r.error}`);
    }
  } catch (e) {
    L.warn(`用量上报异常: ${e.message}`);
  }
}

/**
 * P9: Execute a task with full progress reporting pipeline.
 * A2A-lite v0.1 upgrade: dispatch → ack → working → awaiting_result / submitted → completed
 * Updates progress at 10%, 25%, 50%, 75%, then writes final result.
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, input?: string }} task
 */
async function executeTaskWithProgress(cfg, task) {
  L.info(`🎯 开始处理任务: ${task.name} (taskId=${task.taskId})`);

  // A2A-lite: record dispatch event
  await trpcCall(cfg, "a2a.dispatch", {
    taskId: task.id,
    targetAgentId: cfg.agentId,
    dispatcherAgentId: cfg.agentId,
    payload: `Connector dispatching task ${task.taskId} to ${cfg.agentName}`,
  });

  // Report progress 10%
  let r = await trpcCall(cfg, "task.updateProgress", {
    id: task.id,
    progress: 10,
    status: "running",
    lifecycleStatus: "dispatched",
    output: `[${cfg.agentName}] 开始执行 (mode=${cfg.execMode})...`,
  });
  if (!r.ok) L.warn(`报告进度 10% 失败: ${r.error}`);
  await sleep(200);

  // A2A-lite: ack
  await trpcCall(cfg, "a2a.ack", {
    taskId: task.id,
    agentId: cfg.agentId,
    note: `Agent ${cfg.agentName} acknowledged task`,
  });

  // Report progress 25%
  r = await trpcCall(cfg, "task.updateProgress", {
    id: task.id,
    progress: 25,
    status: "running",
    lifecycleStatus: "working",
    output: `[${cfg.agentName}] 解析任务参数...`,
  });
  if (!r.ok) L.warn(`报告进度 25% 失败: ${r.error}`);

  try {
    const executor = getExecutor(cfg);
    const prompt = cfg.execMode === "command" ? buildTaskPrompt(cfg, task) : "";
    const result = await executor(cfg, task, prompt);

    // Report progress 50% and 75% before final
    await trpcCall(cfg, "task.updateProgress", { id: task.id, progress: 50, status: "running", lifecycleStatus: "working", output: `[${cfg.agentName}] 执行中 (50%)...` });
    await sleep(100);
    await trpcCall(cfg, "task.updateProgress", { id: task.id, progress: 75, status: "running", lifecycleStatus: "working", output: `[${cfg.agentName}] 整理结果 (75%)...` });
    await sleep(100);

    // A2A-lite: submit result
    const submitR = await trpcCall(cfg, "a2a.submitResult", {
      taskId: task.id,
      agentId: cfg.agentId,
      output: truncateOutput(result, cfg.resultMaxChars),
      artifactType: "task_result",
      artifactName: `result-${task.taskId}`,
    });
    if (!submitR.ok) {
      throw new Error(`A2A submitResult failed: ${submitR.error}`);
    }
    L.info(`✅ 任务 ${task.name} 已提交结果 (artifactId=${submitR.data?.artifactId})`);

    // A2A-lite: review / complete the task only after successful submission
    const reviewR = await trpcCall(cfg, "a2a.review", {
      taskId: task.id,
      approved: true,
      note: "Connector auto-approved after successful execution",
    });
    if (!reviewR.ok) {
      L.warn(`A2A review failed: ${reviewR.error}`);
    } else {
      L.info(`✅ 任务 ${task.name} 已审核完成`);
    }

    // P9: Report usage after completion
    await reportUsage(cfg, task, result, true);
  } catch (err) {
    const errMsg = err.message || String(err);
    L.error(`❌ 任务 ${task.name} 执行失败: ${errMsg}`);

    // A2A-lite: check if this is an "awaiting_result" scenario (runner exit code 2)
    const isAwaitingResult = errMsg.includes("awaiting final result") || errMsg.includes("started");
    if (isAwaitingResult) {
      await trpcCall(cfg, "a2a.markAwaitingResult", {
        taskId: task.id,
        agentId: cfg.agentId,
        note: `Gateway returned 'started' only. Task is awaiting final result.`,
      });
      L.info(`⏳ 任务 ${task.name} 进入 awaiting_result 状态`);
    } else {
      r = await trpcCall(cfg, "a2a.fail", {
        taskId: task.id,
        agentId: cfg.agentId,
        error: truncateOutput(errMsg, cfg.resultMaxChars),
      });
      if (!r.ok) {
        L.warn(`报告失败状态失败: ${r.error}`);
      } else {
        L.info(`⚠️ 任务 ${task.name} 已标记为 failed`);
      }
    }

    // P9: Report usage even on failure
    await reportUsage(cfg, task, errMsg, false);
  }
}

/**
 * P9: Active task claim loop — runs independently of heartbeat inbox processing.
 * Polls the task list for queued tasks assigned to this agent, claims, and executes.
 *
 * @param {Config} cfg
 * @returns {Promise<boolean>} true if a task was claimed and processed
 */
async function pollAndClaimTask(cfg) {
  try {
    // Try the dedicated claim endpoint first
    const claim = await trpcCall(cfg, "agent.claimTask", { agentId: cfg.agentId });
    if (!claim.ok) {
      if (claim.error && claim.error.includes("not found")) {
        return false;
      }
      L.debug(`主动认领检查: ${claim.error}`);
      return false;
    }

    const task = claim.data?.task;
    if (!task) return false;

    L.info(`🎯 主动认领到任务: ${task.name} (taskId=${task.taskId})`);
    await executeTaskWithProgress(cfg, task);
    return true;
  } catch (e) {
    L.warn(`主动认领异常: ${e.message}`);
    return false;
  }
}

/**
 * P9: Worker tick — run active task claiming cycle.
 * @param {Config} cfg
 * @param {InboxProcessor} inbox
 */
async function workerTick(cfg, inbox) {
  // 1. Process inbox (gated by processInbox)
  if (cfg.processInbox) {
    try {
      const inboxResult = await inbox.fetchAndProcessInbox();
      if (inboxResult.count > 0) {
        L.debug(`📥 Worker inbox: ${inboxResult.count} msgs, ${inboxResult.processed} processed, ${inboxResult.acked} acked`);
      }
    } catch (e) {
      L.warn(`Worker inbox check error: ${e.message}`);
    }
  }

  // 2. Try to claim and execute a task (gated by claimTasks)
  if (cfg.claimTasks) {
    await pollAndClaimTask(cfg);
  }
}

// ═══════════════════════════════════════════════════════════════
//  P2: Task processing (upgraded — delegates to P9 executeTaskWithProgress)
// ═══════════════════════════════════════════════════════════════

/**
 * Process a claimed or assigned task. Delegates to P9 pipeline.
 *
 * @param {Config} cfg
 * @param {{ id: number, taskId: string, name: string, description?: string, input?: string }} task
 */
async function processTask(cfg, task) {
  await executeTaskWithProgress(cfg, task);
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
    L.info(`📤 回复 → Agent#${toAgentId}: ${content.slice(0, 80)}`);
  }
}

/**
 * P3 Session Runner: handle a command message by spawning a real OpenClaw session.
 * P8.1: only called when execMode is "command" and message is not handled by inbox auto-reply.
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

  const convId = Number(msg.conversationId) || undefined;
  await sendMessage(cfg, Number(msg.fromAgent), responseText, "response", convId);
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

// ═══════════════════════════════════════════════════════════════
//  P8.1: Handle WS message with inbox integration
// ═══════════════════════════════════════════════════════════════

/**
 * Handle an incoming WebSocket message event.
 *
 * P8.1 unified pipeline:
 * - "offline_messages" → feed into inbox processor
 * - "message" → feed into inbox processor (single message batch)
 * - "broadcast" → log only
 * - "pong" → silent
 *
 * @param {Config} cfg
 * @param {InboxProcessor} inbox
 * @param {object} data - parsed JSON from WebSocket
 */
async function handleWSMessage(cfg, inbox, data) {
  const msgType = data.type || "unknown";

  switch (msgType) {
    case "pong":
      break;

    case "offline_messages": {
      const msgs = data.messages || [];
      L.info(`📬 收到 ${msgs.length} 条离线消息`);
      if (msgs.length > 0) {
        const result = await inbox.processBatch(msgs, {
          autoAck: true,
          handleCommands: false, // Don't auto-handle commands during offline batch
        });
        L.info(
          `📬 离线消息处理: ${result.processed} processed, ${result.skipped} skipped, ${result.acked} acked`
        );
      }
      break;
    }

    case "message": {
      const msg = data.message || {};
      // Skip own messages echoed back
      if (msg.fromAgent === cfg.agentId) break;

      L.info(
        `📩 消息 Agent#${msg.fromAgent} → Agent#${msg.toAgent}: ${(msg.content || "").slice(0, 160)}`
      );

      // Process through inbox (dedup + ACK)
      const result = await inbox.processBatch([msg], {
        autoAck: true,
        handleCommands: msg.type === "command", // Auto-reply for commands in mock mode
      });

      if (result.skipped > 0) {
        L.debug(`⏭️ 消息 #${msg.id} 已处理过，跳过`);
      }

      break;
    }

    case "mailbox_message": {
      const msg = data.message || {};
      L.info(`📬 Mailbox: ${msg.fromMailboxId} → ${msg.toMailboxId}: ${(msg.body || msg.subject || "").slice(0, 160)}`);

      // Use the message's toMailboxId as our mailboxId (the recipient)
      const myMailboxId = msg.toMailboxId;

      // Send an immediate ACK reply to confirm receipt
      const ackContent = `[${myMailboxId}] 已收到您的消息，正在处理中...`;
      trpcCall(cfg, "mailbox.reply", {
        messageId: msg.id,
        fromMailboxId: myMailboxId,
        body: ackContent,
      }).catch((e) => L.warn(`Mailbox ACK reply failed: ${e.message}`));

      // In command mode: deliver to OpenClaw session via gateway for async processing
      if (cfg.execMode === "command" && msg.body && msg.fromMailboxId) {
        const prompt = buildMailboxPrompt(cfg, msg);
        L.info(`🧠 投递 Mailbox 消息到 OpenClaw: ${(msg.body || "").slice(0, 100)}`);

        // Fire and forget — deliver to session, don't wait for result
        executeCommand(cfg, {
          id: msg.id,
          taskId: `MB-${msg.id}`,
          name: `Mailbox: ${msg.fromMailboxId} → ${myMailboxId}`,
          description: msg.body || "",
          input: msg.body || "",
        }, prompt).then((result) => {
          L.info(`📨 Mailbox 消息已投递到 OpenClaw session`);
        }).catch((err) => {
          L.warn(`Mailbox 投递失败: ${err.message}`);
        });
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
 * P8.1: also trigger inbox processing.
 *
 * @param {Config} cfg
 * @param {InboxProcessor} inbox
 * @returns {Promise<boolean>} true if heartbeat was successful
 */
async function doHeartbeat(cfg, inbox) {
  const r = await trpcCall(cfg, "agent.updateHeartbeat", { id: cfg.agentId });
  if (!r.ok) {
    L.warn(`心跳失败: ${r.error}`);
    return false;
  }

  L.debug("💓 心跳成功");

  // P8.1: Process inbox on heartbeat (gated by processInbox)
  if (cfg.processInbox) {
    inbox.fetchAndProcessInbox().then((result) => {
      if (result.count > 0) {
        L.debug(
          `📥 Inbox: ${result.count} fetched, ${result.processed} processed, ${result.skipped} skipped, ${result.acked} acked`
        );
      }
    }).catch((e) => {
      L.warn(`Inbox process error: ${e.message}`);
    });
  }

  // P9.1: Task claiming and execution gated by claimTasks
  if (!cfg.claimTasks) {
    L.debug("📴 任务认领已禁用 (TIANGONG_CLAIM_TASKS=false)，仅维持心跳");
    return true;
  }

  const claimedTask = r.data && r.data.claimedTask;
  if (claimedTask) {
    L.info(`🎯 心跳认领到任务: ${claimedTask.name}`);
    await processTask(cfg, claimedTask);
    return true;
  }

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
    const inbox = new InboxProcessor(cfg);

    let heartbeatTimer = null;
    let pingTimer = null;
    let workerTimer = null;  // P9: task claim/execute loop
    let resolved = false;

    function cleanup() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (workerTimer) { clearInterval(workerTimer); workerTimer = null; }
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
      L.info(`   Inbox: batch=${cfg.inboxBatchSize}, dedup=${inbox.dedup.size}`);

      heartbeatTimer = setInterval(() => {
        doHeartbeat(cfg, inbox).catch((e) => L.error(`心跳异常: ${e.message}`));
      }, cfg.heartbeatIntervalMs);

      pingTimer = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: "ping" }));
        } catch {}
      }, 30_000);

      // P9: Worker claim loop (every 10s, independent of heartbeat)
      workerTimer = setInterval(() => {
        workerTick(cfg, inbox).catch((e) => L.error(`Worker tick 异常: ${e.message}`));
      }, 10_000);

      // P9: Initial worker tick + heartbeat
      doHeartbeat(cfg, inbox).catch((e) => L.error(`初始心跳异常: ${e.message}`));
      workerTick(cfg, inbox).catch((e) => L.error(`初始 worker tick 异常: ${e.message}`));
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        L.warn(`收到非法 JSON: ${String(event.data).slice(0, 200)}`);
        return;
      }
      handleWSMessage(cfg, inbox, data).catch((e) => L.error(`消息处理异常: ${e.message}`));
    };

    ws.onclose = (event) => {
      L.info(`🔌 WebSocket 断开 (code=${event.code}, reason=${event.reason || "none"})`);
      done(false);
    };

    ws.onerror = (err) => {
      L.error(`WebSocket 错误`, err && err.message ? { error: err.message } : undefined);
    };
  });
}

// ═══════════════════════════════════════════════════════════════
//  Reconnection logic
// ═══════════════════════════════════════════════════════════════

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
天宫 OpenClaw Connector (P8.1) — 助手接入器 + 可靠消息总线

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

  P9.1 成本守卫:
  --process-inbox <bool>     处理 inbox (default: true, 安全)
  --claim-tasks <bool>       认领执行任务 (default: false, 安全)
  --cheap-model <model>      低成本模型 (default: deepseek-official/deepseek-v4-flash)
  --cheap-model-ops <model>  运营低成本模型 (default: minimax-cn/MiniMax-M3)
  --allow-expensive-recurring 允许重复任务用昂贵模型

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
  TIANGONG_INBOX_BATCH_SIZE  P8.1: inbox 批大小 (default: 20)

示例:
  node connector.mjs --config ./agents.json --agent-name meizhizi
  TIANGONG_AGENT_ID=1 TIANGONG_MCP_KEY=tg-xxx node connector.mjs
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
    execMode: null,
    execFile: null,
    execArgs: null,
    execCommand: null,
    execTimeoutMs: null,
    resultMaxChars: null,
    // P9.1 cost guard
    processInbox: null,
    claimTasks: null,
    cheapModel: null,
    cheapModelOps: null,
    allowExpensiveRecurring: false,
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
      // ─── P9.1 cost guard CLI flags ───
      case "--process-inbox":
        opts.processInbox = next;
        i++;
        break;
      case "--claim-tasks":
        opts.claimTasks = next;
        i++;
        break;
      case "--cheap-model":
        opts.cheapModel = next;
        i++;
        break;
      case "--cheap-model-ops":
        opts.cheapModelOps = next;
        i++;
        break;
      case "--allow-expensive-recurring":
        opts.allowExpensiveRecurring = true;
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
      // Allow --token to override config file token
      if (opts.token) cfg.token = opts.token;
    } else {
      cfg = new Config();
      if (opts.agentId) cfg.agentId = opts.agentId;
      if (opts.token) cfg.token = opts.token;
      if (opts.agentName) cfg.agentName = opts.agentName;
    }

    if (opts.httpBase) cfg.httpBase = opts.httpBase.replace(/\/$/, "");
    if (opts.wsBase) cfg.wsBase = opts.wsBase.replace(/\/$/, "");
    if (opts.heartbeatMs) cfg.heartbeatIntervalMs = opts.heartbeatMs;
    if (opts.execMode) cfg.execMode = opts.execMode;
    if (opts.execFile) cfg.execFile = opts.execFile;
    if (opts.execArgs) cfg.execArgs = opts.execArgs;
    if (opts.execCommand) cfg.execCommand = opts.execCommand;
    if (opts.execTimeoutMs) cfg.execTimeoutMs = opts.execTimeoutMs;
    if (opts.resultMaxChars) cfg.resultMaxChars = opts.resultMaxChars;

    // P9.1: Apply CLI overrides for cost guard
    if (opts.processInbox !== null) cfg.processInbox = cfg._parseBool(String(opts.processInbox), true);
    if (opts.claimTasks !== null) cfg.claimTasks = cfg._parseBool(String(opts.claimTasks), false);
    if (opts.cheapModel) cfg.cheapModel = opts.cheapModel;
    if (opts.cheapModelOps) cfg.cheapModelOps = opts.cheapModelOps;
    if (opts.allowExpensiveRecurring) cfg.allowExpensiveRecurring = true;

    cfg.validate();
  } catch (err) {
    console.error(`❌ 配置错误: ${err.message}`);
    console.error("使用 --help 查看用法");
    process.exit(1);
  }

  L.info("═══════════════════════════════════════════");
  L.info(`天宫 OpenClaw Connector (P8.1) 启动`);
  L.info(`  Agent: ${cfg.agentName} (ID=${cfg.agentId})`);
  L.info(`  HTTP:  ${cfg.httpBase}`);
  L.info(`  WS:    ${cfg.wsBase}`);
  L.info(`  心跳:  ${cfg.heartbeatIntervalMs}ms`);
  L.info(`  Token: ${maskToken(cfg.token)}`);
  const execDetail = cfg.execMode === "command"
    ? (cfg.execFile ? " (argv mode)" : " (legacy string mode)")
    : "";
  L.info(`  执行:  ${cfg.execMode}${execDetail}`);
  L.info(`  超时:  ${cfg.execTimeoutMs}ms`);
  L.info(`  Inbox: batch=${cfg.inboxBatchSize}`);
  L.info("─── P9.1 Cost Guard ───");
  L.info(`  Process inbox: ${cfg.processInbox ? "✅ enabled" : "❌ disabled"}`);
  L.info(`  Claim tasks:   ${cfg.claimTasks ? "✅ enabled" : "❌ disabled (safe default)"}`);
  L.info(`  Cheap model:   ${cfg.cheapModel}`);
  L.info(`  Cheap ops:     ${cfg.cheapModelOps}`);
  if (cfg.allowExpensiveRecurring) L.info(`  ⚠️  Allow expensive recurring: ON`);
  L.info("═══════════════════════════════════════════");

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
