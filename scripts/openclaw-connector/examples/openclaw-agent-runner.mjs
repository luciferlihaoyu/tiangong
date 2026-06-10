#!/usr/bin/env node

/**
 * 天宫 P3：OpenClaw Session Runner / 会话调度桥
 *
 * 在 P2 command 执行桥之上，调用 openclaw agent --json 将天宫 task prompt
 * 派发给 OpenClaw Agent/session，提取最终文本输出给 connector 回写。
 *
 * 用法：
 *   printf '=== Tiangong Task ===\nTask ID: P3-TEST\nName: test\n' | \
 *     node openclaw-agent-runner.mjs --agent codemaster --timeout 600
 *
 *   # 通过 connector 的 execCommand 使用：
 *   TIANGONG_EXEC_COMMAND="node ./scripts/openclaw-connector/examples/openclaw-agent-runner.mjs --agent codemaster --timeout 600"
 *
 * 选项：
 *   --agent <id>          目标 OpenClaw agent（必需）
 *   --session-key <key>   可选会话 key；默认从 prompt Task ID 生成
 *   --model <model>       可选模型覆盖
 *   --thinking <level>    可选 reasoning/thinking 覆盖
 *   --timeout <seconds>   传给 openclaw agent --timeout（默认 300）
 *   --local               透传 --local 给 openclaw agent
 *   --json                保留（内部默认 --json，此选项仅用于 debug）
 *   --openclaw-bin <path> 可选 openclaw 二进制路径（默认 "openclaw"）
 *   --help, -h            显示帮助
 *
 * 环境变量：
 *   OPENCLAW_RUNNER_AGENT
 *   OPENCLAW_RUNNER_SESSION_KEY
 *   OPENCLAW_RUNNER_MODEL
 *   OPENCLAW_RUNNER_THINKING
 *   OPENCLAW_RUNNER_TIMEOUT_SECONDS
 *   OPENCLAW_RUNNER_LOCAL=1
 *   OPENCLAW_BIN
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// ═══════════════════════════════════════════════════════════════
//  Help
// ═══════════════════════════════════════════════════════════════

function printHelp() {
  console.log(`
天宫 P3：OpenClaw Session Runner — 将天宫 task prompt 派发给 OpenClaw Agent

用法:
  <prompt via stdin> | node openclaw-agent-runner.mjs [options]

选项:
  --agent <id>          目标 OpenClaw agent（必需）
  --session-key <key>   可选会话 key；默认从 prompt Task ID 生成
  --model <model>       可选模型覆盖
  --thinking <level>    可选 reasoning/thinking 覆盖
  --timeout <seconds>   传给 openclaw agent --timeout（默认 300）
  --local               透传 --local 给 openclaw agent
  --json                保留（内部默认 --json，此选项仅用于 debug）
  --openclaw-bin <path> 可选 openclaw 二进制路径（默认 "openclaw"）
  --help, -h            显示帮助

环境变量:
  OPENCLAW_RUNNER_AGENT
  OPENCLAW_RUNNER_SESSION_KEY
  OPENCLAW_RUNNER_MODEL
  OPENCLAW_RUNNER_THINKING
  OPENCLAW_RUNNER_TIMEOUT_SECONDS
  OPENCLAW_RUNNER_LOCAL=1
  OPENCLAW_BIN

示例:
  # 基本用法
  printf '=== Tiangong Task ===\\nTask ID: P3-TEST\\nName: test\\n' | \\
    node openclaw-agent-runner.mjs --agent codemaster --timeout 600

  # 通过 connector 的 execCommand 使用
  TIANGONG_EXEC_COMMAND="node ./scripts/openclaw-connector/examples/openclaw-agent-runner.mjs --agent codemaster --timeout 600"

  # 使用 mock openclaw 烟测
  printf '=== Tiangong Task ===\\nTask ID: P3-MOCK\\nName: test\\n' | \\
    node openclaw-agent-runner.mjs --agent codemaster --openclaw-bin /tmp/mock-openclaw
`);
}

// ═══════════════════════════════════════════════════════════════
//  CLI + Env parsing
// ═══════════════════════════════════════════════════════════════

function parseArgsAndEnv() {
  const args = process.argv.slice(2);
  const opts = {
    agent: process.env.OPENCLAW_RUNNER_AGENT || "",
    sessionKey: process.env.OPENCLAW_RUNNER_SESSION_KEY || "",
    model: process.env.OPENCLAW_RUNNER_MODEL || "",
    thinking: process.env.OPENCLAW_RUNNER_THINKING || "",
    timeoutSeconds: parseInt(process.env.OPENCLAW_RUNNER_TIMEOUT_SECONDS || "0", 10) || 0,
    local: process.env.OPENCLAW_RUNNER_LOCAL === "1",
    json: false,
    openclawBin: process.env.OPENCLAW_BIN || "openclaw",
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--agent":
        opts.agent = next;
        i++;
        break;
      case "--session-key":
        opts.sessionKey = next;
        i++;
        break;
      case "--model":
        opts.model = next;
        i++;
        break;
      case "--thinking":
        opts.thinking = next;
        i++;
        break;
      case "--timeout":
        opts.timeoutSeconds = parseInt(next, 10) || 0;
        i++;
        break;
      case "--local":
        opts.local = true;
        break;
      case "--json":
        opts.json = true;
        break;
      case "--openclaw-bin":
        opts.openclawBin = next;
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
//  Stdin reader
// ═══════════════════════════════════════════════════════════════

async function readStdin() {
  let input = "";
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    input += line + "\n";
  }
  return input;
}

// ═══════════════════════════════════════════════════════════════
//  Session key generation from prompt
// ═══════════════════════════════════════════════════════════════

/**
 * Extract Task ID from a Tiangong prompt and generate a safe session key.
 * Format: tiangong-${agent}-${taskId}
 * Characters are sanitized to [a-zA-Z0-9._:-]
 *
 * @param {string} prompt
 * @param {string} agent
 * @returns {string}
 */
function generateSessionKey(prompt, agent) {
  const match = prompt.match(/^Task ID:\s*(\S+)/m);
  if (!match) return "";

  let taskId = match[1];
  // Sanitize to safe chars: a-zA-Z0-9._:-
  taskId = taskId.replace(/[^a-zA-Z0-9._:-]/g, "_");

  return `tiangong-${agent}-${taskId}`;
}

// ═══════════════════════════════════════════════════════════════
//  spawnCollect — spawn with stdout/stderr limits
// ═══════════════════════════════════════════════════════════════

/**
 * Spawn a child process, collect stdout/stderr with size limits, enforce timeout.
 *
 * @param {string} bin - executable path
 * @param {string[]} args - argv array (shell: false)
 * @param {number} timeoutMs - kill after this many ms
 * @param {number} maxOutputBytes - max stdout/stderr bytes to collect (default 1MB)
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
function spawnCollect(bin, args, timeoutMs, maxOutputBytes = 1_048_576) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Force kill after 5s grace
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 5000);
    }, timeoutMs);

    function done(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    }

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      if (stdout.length < maxOutputBytes) {
        stdout += s;
        if (stdout.length > maxOutputBytes) {
          stdout = stdout.slice(0, maxOutputBytes) + "\n\n[... stdout truncated]";
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      if (stderr.length < maxOutputBytes) {
        stderr += s;
        if (stderr.length > maxOutputBytes) {
          stderr = stderr.slice(0, maxOutputBytes) + "\n\n[... stderr truncated]";
        }
      }
    });

    child.on("close", (code, signal) => done(code, signal));
    child.on("error", (err) => {
      stderr += `spawn error: ${err.message}`;
      done(-1, null);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  JSON text extraction
// ═══════════════════════════════════════════════════════════════

/**
 * Extract final text from openclaw agent --json output.
 * Tries multiple known shapes in priority order.
 *
 * @param {string} raw - raw stdout from openclaw agent --json
 * @returns {string}
 */
function extractText(raw) {
  if (!raw || !raw.trim()) return "";

  // Try to parse as JSON
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    // Not JSON — return raw (safely)
    return raw.trim();
  }

  // Priority extraction paths:
  // 1. payloads[].text (direct array)
  if (Array.isArray(parsed.payloads)) {
    const texts = parsed.payloads
      .filter((p) => p && typeof p.text === "string" && p.text.trim())
      .map((p) => p.text);
    if (texts.length > 0) return texts.join("\n");
  }

  // 2. result.payloads[].text
  if (parsed.result && Array.isArray(parsed.result.payloads)) {
    const texts = parsed.result.payloads
      .filter((p) => p && typeof p.text === "string" && p.text.trim())
      .map((p) => p.text);
    if (texts.length > 0) return texts.join("\n");
  }

  // 3. reply (string)
  if (typeof parsed.reply === "string" && parsed.reply.trim()) {
    return parsed.reply;
  }

  // 4. text (string)
  if (typeof parsed.text === "string" && parsed.text.trim()) {
    return parsed.text;
  }

  // 5. message (string)
  if (typeof parsed.message === "string" && parsed.message.trim()) {
    return parsed.message;
  }

  // 6. result as string
  if (typeof parsed.result === "string" && parsed.result.trim()) {
    return parsed.result;
  }

  // 7. result.text
  if (parsed.result && typeof parsed.result.text === "string" && parsed.result.text.trim()) {
    return parsed.result.text;
  }

  // 8. result.reply
  if (parsed.result && typeof parsed.result.reply === "string" && parsed.result.reply.trim()) {
    return parsed.result.reply;
  }

  // 9. result.message
  if (parsed.result && typeof parsed.result.message === "string" && parsed.result.message.trim()) {
    return parsed.result.message;
  }

  // Fallback: return a safe summary of the JSON (no raw dump)
  const keys = Object.keys(parsed).slice(0, 10).join(", ");
  const summary = JSON.stringify(parsed).slice(0, 500);
  return `[runner: unable to extract text from openclaw output; keys: ${keys}]\n${summary}`;
}

// ═══════════════════════════════════════════════════════════════
//  Diagnostics helpers
// ═══════════════════════════════════════════════════════════════

/**
 * Sanitize a string for safe diagnostics — remove potential tokens/keys.
 * Strips patterns like tg-..., sk-..., and long base64-like strings.
 *
 * @param {string} s
 * @param {number} maxLen
 * @returns {string}
 */
function safeDiagnostic(s, maxLen = 500) {
  if (!s) return "";
  let cleaned = s
    .replace(/\b(tg-[a-zA-Z0-9_-]{16,})\b/g, "tg-***")
    .replace(/\b(sk-[a-zA-Z0-9_-]{16,})\b/g, "sk-***")
    .replace(/\b([A-Za-z0-9+/=]{40,})\b/g, "***[base64]***");
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen) + "...";
  }
  return cleaned;
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const opts = parseArgsAndEnv();

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Validate required
  if (!opts.agent) {
    console.error("错误: 缺少 --agent 参数（或 OPENCLAW_RUNNER_AGENT 环境变量）");
    console.error("使用 --help 查看用法");
    process.exit(2);
  }

  // Read prompt from stdin
  const prompt = await readStdin();

  if (!prompt.trim()) {
    console.error("错误: stdin 为空，没有收到 task prompt");
    process.exit(2);
  }

  // Generate session key if not provided
  let sessionKey = opts.sessionKey;
  if (!sessionKey) {
    sessionKey = generateSessionKey(prompt, opts.agent);
  }

  // Build argv array — shell: false, no shell injection
  const args = ["agent", "--agent", opts.agent, "--message", prompt, "--json"];

  if (sessionKey) {
    args.push("--session-key", sessionKey);
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.thinking) {
    args.push("--thinking", opts.thinking);
  }

  const timeoutSeconds = opts.timeoutSeconds || 300;
  args.push("--timeout", String(timeoutSeconds));

  if (opts.local) {
    args.push("--local");
  }

  // Runner timeout = agent timeout + 30s buffer
  const runnerTimeoutMs = (timeoutSeconds + 30) * 1000;

  // Log safe diagnostics to stderr (no prompt, no token)
  const diagInfo = {
    agent: opts.agent,
    sessionKey: sessionKey || "(none)",
    model: opts.model || "(default)",
    thinking: opts.thinking || "(default)",
    timeout: timeoutSeconds,
    local: opts.local,
    promptChars: prompt.length,
    bin: opts.openclawBin,
  };
  process.stderr.write(`[runner] ${JSON.stringify(diagInfo)}\n`);

  // Execute
  const { code, signal, stdout, stderr, timedOut } = await spawnCollect(
    opts.openclawBin,
    args,
    runnerTimeoutMs
  );

  if (timedOut) {
    process.stderr.write(
      `[runner] 超时: openclaw agent 在 ${runnerTimeoutMs}ms 内未完成\n`
    );
    process.exit(1);
  }

  if (code !== 0) {
    const diag = safeDiagnostic(stderr, 800);
    process.stderr.write(
      `[runner] openclaw agent 退出码 ${code}${signal ? ` (signal=${signal})` : ""}\n`
    );
    if (diag) {
      process.stderr.write(`[runner] stderr: ${diag}\n`);
    }
    process.exit(code || 1);
  }

  // Extract and output final text
  const text = extractText(stdout);

  if (!text) {
    // Non-zero exit for empty output
    process.stderr.write("[runner] openclaw agent 返回了空输出\n");
    process.exit(3);
  }

  process.stdout.write(text + "\n");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[runner] 致命错误: ${safeDiagnostic(err.message, 500)}\n`);
  process.exit(2);
});
