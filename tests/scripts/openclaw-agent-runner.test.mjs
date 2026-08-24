/**
 * P3 t2：openclaw-agent-runner 测试套件（node:test + node:assert/strict，无新依赖）
 *
 * 覆盖 19 个用例：
 *   A. 基础 CLI 透传（agent / session-key / model / thinking / timeout / local）
 *   B. env 兜底（OPENCLAW_RUNNER_AGENT / OPENCLAW_BIN）
 *   C. JSON 5 形态解析（payloads / result.payloads / reply / text / message / 未知截断）
 *   D. 错误处理（非 0 exit / timeout）
 *   E. 安全（shell 注入防御 / 敏感信息不打印）
 *   F. --help
 *
 * 策略：mkdtemp 创建临时目录，写入纯 Node.js mock openclaw（chmod 0o755），
 *   spawn runner 时通过 --openclaw-bin 指向 mock；mock 把收到的 argv 通过
 *   ARGV_LOG 环境变量写回日志文件，测试再读取断言透传。after 清理临时目录。
 */
import { test, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(
  new URL("../../scripts/openclaw-connector/examples/openclaw-agent-runner.mjs", import.meta.url)
);

let tmpDir;
let argvLogPath;
let mockOpenclawPath;
let customBinPath;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "p3-runner-"));
  argvLogPath = join(tmpDir, "argv.json");

  // mock openclaw：把收到的 argv 写进 ARGV_LOG，并按 MOCK_OUTPUT 输出 JSON 形态
  const mockScript = `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(process.env.ARGV_LOG, JSON.stringify({ argv, cwd: process.cwd() }));
const outputMode = process.env.MOCK_OUTPUT || 'payloads';
const exitCode = parseInt(process.env.MOCK_EXIT || '0', 10);
const texts = (process.env.MOCK_TEXTS || 'MOCK_OK').split('|');
if (outputMode === 'sleep') {
  // 保持存活超过 runner timeout，等待 runner 的 SIGTERM（不主动退出）
  setTimeout(() => {}, parseInt(process.env.MOCK_SLEEP_MS || '60000', 10));
} else {
  if (outputMode === 'payloads') console.log(JSON.stringify({ payloads: texts.map(t => ({ text: t })) }));
  else if (outputMode === 'result') console.log(JSON.stringify({ result: { payloads: texts.map(t => ({ text: t })) } }));
  else if (outputMode === 'reply') console.log(JSON.stringify({ reply: texts[0] }));
  else if (outputMode === 'text') console.log(JSON.stringify({ text: texts[0] }));
  else if (outputMode === 'message') console.log(JSON.stringify({ message: texts[0] }));
  else if (outputMode === 'unknown') console.log(JSON.stringify({ foo: 1, bar: 'x'.repeat(200) }));
  else if (outputMode === 'stderr') console.error(process.env.MOCK_STDERR_TEXT || 'oops');
  process.exit(exitCode);
}
`;
  mockOpenclawPath = join(tmpDir, "mock-openclaw");
  writeFileSync(mockOpenclawPath, mockScript);
  chmodSync(mockOpenclawPath, 0o755);

  // OPENCLAW_BIN 兜底测试用的简单 shell script mock
  customBinPath = join(tmpDir, "custom-openclaw");
  const customScript = `#!/bin/sh
echo "custom-bin-marker" > "\$ARGV_LOG"
printf '{"payloads":[{"text":"CUSTOM_BIN_OK"}]}'
`;
  writeFileSync(customBinPath, customScript);
  chmodSync(customBinPath, 0o755);
});

after(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // 清空 argv 日志，避免上一个用例的残留造成误判
  writeFileSync(argvLogPath, "");
});

/** 读取 mock 记录的 argv；找不到 / 非 JSON 时返回 null。 */
function readArgv() {
  const raw = readFileSync(argvLogPath, "utf8").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw).argv;
  } catch {
    return null;
  }
}

/**
 * spawn runner，返回 { code, stdout, stderr }。
 * - agent=null 时不注入默认 --agent（用于测 env 兜底 / 注入 / --help 等场景）
 * - openclawBin=null 时不传 --openclaw-bin（改用 OPENCLAW_BIN 环境变量验证兜底）
 */
function runRunner({
  stdin = "hello",
  env = {},
  args = [],
  outputMode = "payloads",
  openclawBin = mockOpenclawPath,
  agent = "testagent",
} = {}) {
  return new Promise((resolve) => {
    const runnerArgs = [runnerPath];
    if (openclawBin) runnerArgs.push("--openclaw-bin", openclawBin);
    if (agent !== null) runnerArgs.push("--agent", agent);
    runnerArgs.push(...args);

    const child = spawn("node", runnerArgs, {
      env: { ...process.env, ARGV_LOG: argvLogPath, MOCK_OUTPUT: outputMode, ...env },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));

    // --help 等场景 runner 可能先退出，写入 stdin 可能 EPIPE，忽略即可
    child.stdin.on("error", () => {});
    try {
      if (child.stdin.writable) {
        child.stdin.write(stdin);
        child.stdin.end();
      }
    } catch {
      /* runner 已退出 */
    }
  });
}

/** 断言 argv 中存在 flag（value 提供时校验其后一个元素）。 */
function assertArgvPair(argv, flag, value) {
  assert.ok(Array.isArray(argv), "mock 应记录 argv");
  const idx = argv.indexOf(flag);
  assert.notEqual(idx, -1, `argv 应包含 ${flag}，实际: ${JSON.stringify(argv)}`);
  if (value !== undefined) {
    assert.equal(argv[idx + 1], value, `${flag} 值应为 ${value}，实际: ${JSON.stringify(argv)}`);
  }
}

// ═══════════════════════ A. 基础 CLI 透传 ═══════════════════════

test("A1 --agent codemaster 透传为 argv[0..2]", async () => {
  const { code, stderr } = await runRunner({ args: ["--agent", "codemaster"], agent: null });
  assert.equal(code, 0, stderr);
  const argv = readArgv();
  assert.ok(argv, "mock 应记录 argv");
  assert.equal(argv[0], "agent");
  assert.equal(argv[1], "--agent");
  assert.equal(argv[2], "codemaster");
  assert.ok(argv.includes("--json"), `argv 应含 --json: ${JSON.stringify(argv)}`);
});

test("A2 --session-key mykey 透传", async () => {
  const { code, stderr } = await runRunner({ args: ["--session-key", "mykey"] });
  assert.equal(code, 0, stderr);
  assertArgvPair(readArgv(), "--session-key", "mykey");
});

test("A3 --model gpt-4 透传", async () => {
  const { code, stderr } = await runRunner({ args: ["--model", "gpt-4"] });
  assert.equal(code, 0, stderr);
  assertArgvPair(readArgv(), "--model", "gpt-4");
});

test("A4 --thinking high 透传", async () => {
  const { code, stderr } = await runRunner({ args: ["--thinking", "high"] });
  assert.equal(code, 0, stderr);
  assertArgvPair(readArgv(), "--thinking", "high");
});

test("A5 --timeout 30 透传", async () => {
  const { code, stderr } = await runRunner({ args: ["--timeout", "30"] });
  assert.equal(code, 0, stderr);
  assertArgvPair(readArgv(), "--timeout", "30");
});

test("A6 --local 透传（纯 flag）", async () => {
  const { code, stderr } = await runRunner({ args: ["--local"] });
  assert.equal(code, 0, stderr);
  assertArgvPair(readArgv(), "--local");
});

// ═══════════════════════ B. env 兜底 ═══════════════════════

test("B7 OPENCLAW_RUNNER_AGENT env 兜底 --agent", async () => {
  const { code, stderr } = await runRunner({ agent: null, env: { OPENCLAW_RUNNER_AGENT: "envagent" } });
  assert.equal(code, 0, stderr);
  assertArgvPair(readArgv(), "--agent", "envagent");
});

test("B8 OPENCLAW_BIN 走自定义路径（shell script）", async () => {
  const { code, stdout, stderr } = await runRunner({
    openclawBin: null,
    env: { OPENCLAW_BIN: customBinPath },
  });
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "CUSTOM_BIN_OK", `应走自定义 bin: ${stdout}`);
  assert.ok(
    readFileSync(argvLogPath, "utf8").includes("custom-bin-marker"),
    "自定义 shell script 应被调用"
  );
});

// ═══════════════════════ C. JSON 5 形态解析 ═══════════════════════

test("C9 {payloads:[{text}]} → stdout", async () => {
  const { code, stdout, stderr } = await runRunner({ outputMode: "payloads", env: { MOCK_TEXTS: "A" } });
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "A", stdout);
});

test("C10 {result:{payloads:[{text}]}} → stdout", async () => {
  const { code, stdout, stderr } = await runRunner({ outputMode: "result", env: { MOCK_TEXTS: "B" } });
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "B", stdout);
});

test("C11 {reply} → stdout", async () => {
  const { code, stdout, stderr } = await runRunner({ outputMode: "reply", env: { MOCK_TEXTS: "C" } });
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "C", stdout);
});

test("C12 {text} → stdout", async () => {
  const { code, stdout, stderr } = await runRunner({ outputMode: "text", env: { MOCK_TEXTS: "D" } });
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "D", stdout);
});

test("C13 {message} → stdout", async () => {
  const { code, stdout, stderr } = await runRunner({ outputMode: "message", env: { MOCK_TEXTS: "E" } });
  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "E", stdout);
});

test("C14 未知形态 {foo} → 截断 JSON 摘要", async () => {
  const { code, stdout, stderr } = await runRunner({ outputMode: "unknown" });
  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes("[runner]"), stdout);
  assert.ok(stdout.includes("foo"), `摘要应含 key foo: ${stdout}`);
});

// ═══════════════════════ D. 错误处理 ═══════════════════════

test("D15 mock exit 7 + stderr boom → runner 非 0，stderr 含 7/boom", async () => {
  const { code, stderr } = await runRunner({
    outputMode: "stderr",
    env: { MOCK_EXIT: "7", MOCK_STDERR_TEXT: "boom" },
  });
  assert.notEqual(code, 0, `应非 0 退出: ${code}`);
  assert.ok(stderr.includes("7"), `stderr 应含退出码: ${stderr}`);
  assert.ok(stderr.includes("boom"), `stderr 应含 boom: ${stderr}`);
});

test("D16 mock sleep 超过 runner timeout → 非 0（timeout 触发）", async () => {
  // runner 内部超时 = (timeout+30)*1000；用 OPENCLAW_RUNNER_TIMEOUT_SECONDS=-29
  // 得到 1000ms，让测试快速触发 timeout；mock sleep 60s 远超 1s。
  const { code, stderr } = await runRunner({
    outputMode: "sleep",
    env: { MOCK_SLEEP_MS: "60000", OPENCLAW_RUNNER_TIMEOUT_SECONDS: "-29" },
  });
  assert.notEqual(code, 0, `timeout 应非 0 退出: ${code}`);
  assert.ok(stderr.includes("超时"), `stderr 应含超时: ${stderr}`);
});

// ═══════════════════════ E. 安全 ═══════════════════════

test("E17 shell 注入防御：--agent 整段作为单参数，不执行 shell", async () => {
  const payload = "codemaster; rm -rf /tmp/shouldnotexist";
  const target = "/tmp/shouldnotexist";
  rmSync(target, { recursive: true, force: true }); // 确保起始不存在
  const { code, stderr } = await runRunner({ args: ["--agent", payload], agent: null });
  assert.equal(code, 0, stderr);
  // 整段原样作为单参数（若被 shell 拼接/分割，argv[2] 不会是完整串）
  assertArgvPair(readArgv(), "--agent", payload);
  assert.equal(existsSync(target), false, "注入 payload 不应被 shell 执行");
});

test("E18 stdin 含敏感 token → stderr/stdout 不打印", async () => {
  const secret = "tg-secret-key-12345";
  const stdin = `=== Tiangong Task ===\nTask ID: SECRET-TEST\nName: test\napi-key=${secret}\n`;
  const { code, stdout, stderr } = await runRunner({ stdin });
  assert.equal(code, 0, stderr);
  assert.ok(!stderr.includes(secret), `stderr 不应含敏感串: ${stderr}`);
  assert.ok(!stdout.includes(secret), `stdout 不应含敏感串: ${stdout}`);
});

// ═══════════════════════ F. --help ═══════════════════════

test("F19 --help → exit 0 + 用法/--agent/OPENCLAW_RUNNER_AGENT", async () => {
  const { code, stdout } = await runRunner({ args: ["--help"], agent: null });
  assert.equal(code, 0);
  // t1 帮助文本使用中文「用法:」；兼容英文 "Usage"
  assert.ok(stdout.includes("用法") || stdout.includes("Usage"), stdout);
  assert.ok(stdout.includes("--agent"), stdout);
  assert.ok(stdout.includes("OPENCLAW_RUNNER_AGENT"), stdout);
});
