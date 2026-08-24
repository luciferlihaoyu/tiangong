#!/usr/bin/env node

/**
 * P3：OpenClaw Session Runner
 * （参考 docs/TIANGONG_P3_OPENCLAW_SESSION_RUNNER_SPEC.md）
 *
 * 流程：stdin prompt → spawn openclaw agent --json → 解析 → 输出最终文本
 *
 * 安全：
 * - shell:false + argv 数组（不拼 shell）
 * - prompt 不进 stderr
 * - 日志只打印摘要（taskId / sessionKey / chars），不打印完整 prompt
 */

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

// ═══════════════════════════════════════════════════════════════
//  帮助
// ═══════════════════════════════════════════════════════════════

function printHelp() {
  console.log(`天宫 P3：OpenClaw Session Runner — 将天宫 task prompt 派发给 OpenClaw Agent

用法:
  <prompt via stdin> | node openclaw-agent-runner.mjs [options]

选项:
  --agent <id>          目标 OpenClaw agent（必需）
  --session-key <key>   可选会话 key；默认从 prompt 的 Task ID 行生成 tiangong-<agent>-<taskId>
  --model <model>       可选模型覆盖
  --thinking <level>    可选 reasoning/thinking 覆盖
  --timeout <seconds>   传给 openclaw agent --timeout（默认 600）
  --local               透传 --local 给 openclaw agent
  --openclaw-bin <path> 可选 openclaw 二进制路径（默认 "openclaw"）
  --help, -h            显示帮助

环境变量（CLI 优先于 env）:
  OPENCLAW_RUNNER_AGENT            兜底 --agent
  OPENCLAW_RUNNER_SESSION_KEY      兜底 --session-key
  OPENCLAW_RUNNER_MODEL            兜底 --model
  OPENCLAW_RUNNER_THINKING         兜底 --thinking
  OPENCLAW_RUNNER_TIMEOUT_SECONDS  兜底 --timeout（秒）
  OPENCLAW_RUNNER_LOCAL=1          兜底 --local
  OPENCLAW_BIN                     兜底 --openclaw-bin

示例:
  # 基本用法
  printf '=== Tiangong Task ===\\nTask ID: P3-TEST\\nName: test\\n' | \\
    node openclaw-agent-runner.mjs --agent codemaster --timeout 600

  # 使用 mock openclaw 烟测
  printf '=== Tiangong Task ===\\nTask ID: P3-MOCK\\nName: test\\n' | \\
    node openclaw-agent-runner.mjs --agent codemaster --openclaw-bin /tmp/mock-openclaw
`);
}

// ═══════════════════════════════════════════════════════════════
//  CLI + env 解析
// ═══════════════════════════════════════════════════════════════

/** 读取 OPENCLAW_RUNNER_* 环境变量作为 CLI 的兜底（CLI 优先于 env）。 */
function parseEnv() {
  return {
    agent: process.env.OPENCLAW_RUNNER_AGENT || "",
    sessionKey: process.env.OPENCLAW_RUNNER_SESSION_KEY || "",
    model: process.env.OPENCLAW_RUNNER_MODEL || "",
    thinking: process.env.OPENCLAW_RUNNER_THINKING || "",
    timeoutSeconds: parseInt(process.env.OPENCLAW_RUNNER_TIMEOUT_SECONDS || "0", 10) || 0,
    local: process.env.OPENCLAW_RUNNER_LOCAL === "1",
    openclawBin: process.env.OPENCLAW_BIN || "",
  };
}

// ═══════════════════════════════════════════════════════════════
//  stdin reader
// ═══════════════════════════════════════════════════════════════

/** 累积读取 stdin 全部字节（on('data') 累积 + on('end') resolve）。 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════════════
//  spawnCollect
// ═══════════════════════════════════════════════════════════════

/**
 * spawn 并收集 stdout/stderr，带 timeout 与 max-bytes 保护。
 *
 * @param {string} bin            可执行路径
 * @param {string[]} args         argv 数组（shell: false，不拼 shell）
 * @param {number} timeoutMs      超时后 SIGTERM，宽限 5s 后 SIGKILL
 * @param {number} maxOutputBytes stdout/stderr 各自最大收集字节（默认 1MB）
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

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // 宽限期后强制结束
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
      }, 5000).unref();
    }, timeoutMs);

    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ code, signal, stdout, stderr, timedOut });
    };

    child.stdout.on("data", (chunk) => {
      if (stdout.length < maxOutputBytes) {
        stdout += chunk.toString();
        if (stdout.length > maxOutputBytes) {
          stdout = stdout.slice(0, maxOutputBytes) + "\n[... stdout truncated]";
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < maxOutputBytes) {
        stderr += chunk.toString();
        if (stderr.length > maxOutputBytes) {
          stderr = stderr.slice(0, maxOutputBytes) + "\n[... stderr truncated]";
        }
      }
    });

    child.on("close", (code, signal) => done(code, signal));
    child.on("error", (err) => {
      stderr += `spawn error: ${err.message}\n`;
      done(-1, null);
    });
  });
}

// ═══════════════════════════════════════════════════════════════
//  JSON 提取
// ═══════════════════════════════════════════════════════════════

/**
 * 从 openclaw agent --json 输出中提取最终文本，按优先级：
 * payloads[].text → result.payloads[].text → reply → text → message → 截断 JSON 摘要。
 *
 * @param {string} raw
 * @returns {string}
 */
function extractText(raw) {
  if (!raw || !raw.trim()) return "";

  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return raw.trim(); // 非 JSON，原样返回
  }

  const textsFromPayloads = (payloads) =>
    payloads
      .filter((p) => p && typeof p.text === "string" && p.text.trim())
      .map((p) => p.text);

  if (Array.isArray(parsed.payloads)) {
    const texts = textsFromPayloads(parsed.payloads);
    if (texts.length > 0) return texts.join("\n");
  }

  if (parsed.result && Array.isArray(parsed.result.payloads)) {
    const texts = textsFromPayloads(parsed.result.payloads);
    if (texts.length > 0) return texts.join("\n");
  }

  if (typeof parsed.reply === "string" && parsed.reply.trim()) return parsed.reply;
  if (typeof parsed.text === "string" && parsed.text.trim()) return parsed.text;
  if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;

  // 无法识别 → 输出截断后的 JSON 摘要（不 dump 原始完整输出）
  const keys = Object.keys(parsed).slice(0, 10).join(", ");
  return `[runner] unable to extract text from openclaw output; keys: ${keys}\n${JSON.stringify(parsed).slice(0, 500)}`;
}

// ═══════════════════════════════════════════════════════════════
//  诊断辅助
// ═══════════════════════════════════════════════════════════════

/** 截断诊断文本，避免把超长输出/敏感内容打进 stderr。 */
function truncate(s, maxLen) {
  if (!s) return "";
  return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
}

/** stderr 输出诊断并退出非 0。 */
function fail(message, code = 1) {
  process.stderr.write(`[openclaw-agent-runner] ${message}\n`);
  process.exit(code);
}

/**
 * 从 prompt 的 "Task ID:" 行生成稳定 session key（spec 推荐，避免会话上下文互相污染）。
 * 字符清理到 [a-zA-Z0-9._:-]，防止注入。
 *
 * @param {string} prompt
 * @param {string} agent
 * @returns {string} 空串表示 prompt 中没有 Task ID
 */
function sessionKeyFromPrompt(prompt, agent) {
  const match = prompt.match(/^Task ID:\s*(\S+)/m);
  if (!match) return "";
  const taskId = match[1].replace(/[^a-zA-Z0-9._:-]/g, "_");
  return `tiangong-${agent}-${taskId}`;
}

// ═══════════════════════════════════════════════════════════════
//  main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      agent: { type: "string" },
      "session-key": { type: "string" },
      model: { type: "string" },
      thinking: { type: "string" },
      timeout: { type: "string" },
      local: { type: "boolean" },
      "openclaw-bin": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const env = parseEnv();
  const opts = {
    agent: values.agent || env.agent || "",
    sessionKey: values["session-key"] || env.sessionKey || "",
    model: values.model || env.model || "",
    thinking: values.thinking || env.thinking || "",
    timeout: parseInt(values.timeout || "", 10) || env.timeoutSeconds || 600,
    local: values.local || env.local,
    openclawBin: values["openclaw-bin"] || env.openclawBin || "openclaw",
  };

  if (!opts.agent) {
    fail("缺少 --agent（或用 OPENCLAW_RUNNER_AGENT 提供）", 2);
  }

  const prompt = await readStdin();
  if (!prompt.trim()) {
    fail("stdin 为空，没有收到 task prompt", 2);
  }

  const sessionKey = opts.sessionKey || sessionKeyFromPrompt(prompt, opts.agent);

  // 安全摘要日志：只打 agent/sessionKey/chars 等摘要，不打印完整 prompt
  process.stderr.write(
    `[openclaw-agent-runner] agent=${opts.agent} sessionKey=${sessionKey || "(none)"} ` +
      `chars=${prompt.length} model=${opts.model || "(default)"} thinking=${opts.thinking || "(default)"} ` +
      `timeout=${opts.timeout}s local=${opts.local} bin=${opts.openclawBin}\n`
  );

  // argv 数组 + shell:false，不拼 shell
  const args = ["agent", "--agent", opts.agent, "--message", prompt, "--json"];
  if (sessionKey) args.push("--session-key", sessionKey);
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  args.push("--timeout", String(opts.timeout));
  if (opts.local) args.push("--local");

  // runner timeout 略大于 openclaw agent --timeout（+30s）
  const runnerTimeoutMs = (opts.timeout + 30) * 1000;

  const { code, signal, stdout, stderr, timedOut } = await spawnCollect(
    opts.openclawBin,
    args,
    runnerTimeoutMs
  );

  if (timedOut) {
    fail(`openclaw agent 超时（${runnerTimeoutMs}ms）未完成`, 1);
  }

  if (code !== 0) {
    process.stderr.write(
      `[openclaw-agent-runner] openclaw agent 退出码 ${code}${signal ? ` (signal=${signal})` : ""}\n`
    );
    if (stdout.trim()) {
      process.stderr.write(`[openclaw-agent-runner] stdout: ${truncate(stdout, 500)}\n`);
    }
    if (stderr.trim()) {
      process.stderr.write(`[openclaw-agent-runner] stderr: ${truncate(stderr, 800)}\n`);
    }
    process.exit(code || 1);
  }

  const text = extractText(stdout);
  if (!text) {
    fail("openclaw agent 返回空输出", 3);
  }

  process.stdout.write(text + "\n");
  process.exit(0);
}

main().catch((err) => {
  fail(`致命错误: ${err.message}`, 2);
});
