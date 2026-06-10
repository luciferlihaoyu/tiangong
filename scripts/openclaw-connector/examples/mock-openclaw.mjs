#!/usr/bin/env node

/**
 * Mock openclaw — 用于 P3 runner 本地烟测
 *
 * 模拟 openclaw agent --json 输出，不调用真实模型。
 * 用法：
 *   chmod +x /tmp/mock-openclaw
 *   printf '=== Tiangong Task ===\nTask ID: P3-MOCK\nName: test\n' | \
 *     node openclaw-agent-runner.mjs --agent codemaster --openclaw-bin /tmp/mock-openclaw
 *
 * 环境变量：
 *   MOCK_FAIL=1        非 0 退出（模拟执行失败）
 *   MOCK_TIMEOUT_SEC=N  sleep N 秒后输出（模拟慢任务）
 *   MOCK_EMPTY=1       输出空 JSON（模拟空输出）
 *   MOCK_SHAPE=<name>  指定输出 JSON 形状: payloads|result-payloads|reply|text|message|result-string|result-text|result-reply|result-message|bad-json
 */

const failMode = process.env.MOCK_FAIL === "1";
const timeoutSec = parseInt(process.env.MOCK_TIMEOUT_SEC || "0", 10);
const emptyMode = process.env.MOCK_EMPTY === "1";
const shape = process.env.MOCK_SHAPE || "payloads";

// Parse --message from argv (for diagnostics, not used)
const args = process.argv.slice(2);
let messageIdx = args.indexOf("--message");
const promptLen = messageIdx >= 0 && args[messageIdx + 1] ? args[messageIdx + 1].length : 0;

if (timeoutSec > 0) {
  await new Promise((r) => setTimeout(r, timeoutSec * 1000));
}

if (failMode) {
  process.stderr.write("MOCK_OPENCLAW_FAIL: simulated failure\n");
  process.exit(1);
}

if (emptyMode) {
  process.stdout.write("\n");
  process.exit(0);
}

let output;

switch (shape) {
  case "payloads":
    output = JSON.stringify({
      payloads: [{ text: "MOCK_OPENCLAW_OK" }],
      meta: { durationMs: 1 },
    });
    break;

  case "result-payloads":
    output = JSON.stringify({
      result: {
        payloads: [{ text: "MOCK_OPENCLAW_OK" }],
      },
      meta: { durationMs: 2 },
    });
    break;

  case "reply":
    output = JSON.stringify({
      reply: "MOCK_OPENCLAW_OK",
      meta: { durationMs: 3 },
    });
    break;

  case "text":
    output = JSON.stringify({
      text: "MOCK_OPENCLAW_OK",
      meta: { durationMs: 4 },
    });
    break;

  case "message":
    output = JSON.stringify({
      message: "MOCK_OPENCLAW_OK",
      meta: { durationMs: 5 },
    });
    break;

  case "result-string":
    output = JSON.stringify({
      result: "MOCK_OPENCLAW_OK",
      meta: { durationMs: 6 },
    });
    break;

  case "result-text":
    output = JSON.stringify({
      result: { text: "MOCK_OPENCLAW_OK" },
      meta: { durationMs: 7 },
    });
    break;

  case "result-reply":
    output = JSON.stringify({
      result: { reply: "MOCK_OPENCLAW_OK" },
      meta: { durationMs: 8 },
    });
    break;

  case "result-message":
    output = JSON.stringify({
      result: { message: "MOCK_OPENCLAW_OK" },
      meta: { durationMs: 9 },
    });
    break;

  case "bad-json":
    output = "MOCK_OPENCLAW_OK (raw text, not JSON)";
    break;

  default:
    output = JSON.stringify({
      payloads: [{ text: "MOCK_OPENCLAW_OK" }],
      meta: { durationMs: 1 },
    });
}

process.stdout.write(output + "\n");
process.exit(0);
