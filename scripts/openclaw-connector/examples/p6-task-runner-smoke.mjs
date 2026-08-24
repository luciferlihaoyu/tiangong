#!/usr/bin/env node

/**
 * P6 端到端 smoke — task-runner command 模式
 * （参考 docs/TIANGONG_P6_COMMAND_OPENCLAW_RUNNER_SPEC.md L74-83 验收段）
 *
 * 验证：
 *   1. spawn argv 模式（shell:false + 数组）直连 mock-openclaw → stdout 含 MOCK_OPENCLAW_OK
 *   2. 走 P3 runner（openclaw-agent-runner.mjs）透传到 mock-openclaw → stdout 含 MOCK_OPENCLAW_OK
 *   3. argv 注入防御：--agent 含 shell 字符也不执行（spawn shell:false）
 *
 * 不导入 api/lib/task-runner.ts（TS 不能被 .mjs 直接 require），复刻其 command 模式
 * spawn argv 行为进行端到端验证——若 task-runner spawn 逻辑与此处漂离，两者之一将失败。
 *
 * 复刻对齐点（api/lib/task-runner.ts）：
 *   - argv spawn:  L843-850  spawn(CONFIG.execFile, execArgs, { shell:false, ... })
 *   - 调用点:      L460      executeCommand(prompt, effectiveTimeout)
 *   - timeout:     L915-920  SIGTERM → 5s grace → SIGKILL
 *   - error:       L944-950  child.on("error") → resolve({ success:false })
 *   - stdin:       L958-959  child.stdin.write(prompt); child.stdin.end()
 *
 * 不引入新依赖；只用 node 内建（node:child_process / node:fs / node:url / node:path）。
 *
 * 用法：node scripts/openclaw-connector/examples/p6-task-runner-smoke.mjs
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_OPENCLAW = join(__dirname, "mock-openclaw.mjs");
const OPENCLAW_RUNNER = join(__dirname, "openclaw-agent-runner.mjs");
const INJECT_FILE = "/tmp/p6-shouldnotexist";

/**
 * 复刻 task-runner.ts command 模式 spawn argv（请保持对齐，见文件头注释行号）：
 *   - spawn(file, args, { shell:false })（argv 模式）
 *   - prompt 通过 stdin 写入
 *   - timeout: SIGTERM → 5s grace → SIGKILL
 *   - close/error 事件驱动 resolve
 */
async function runCommandExecution({ file, args, prompt, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;

    // timeout: SIGTERM → 5s grace → SIGKILL（对齐 task-runner.ts L915-920）
    const killer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* 已退出 */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
      }, 5000);
    }, timeoutMs);

    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr, killed });
    };

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code, signal) => done(code, signal));
    child.on("error", (err) => {
      stderr += `spawn error: ${err.message}\n`;
      done(-1, null);
    });

    // prompt 通过 stdin 传入（对齐 task-runner.ts L958-959）
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
  });
}

const tests = [
  {
    name: "直连 mock-openclaw 返回 MOCK_OPENCLAW_OK",
    async fn() {
      const result = await runCommandExecution({
        file: "node",
        args: [MOCK_OPENCLAW],
        prompt: "[TASK] P6-MOCK\n[INPUT] hello\n",
        timeoutMs: 10000,
      });
      if (result.code !== 0) {
        throw new Error(`mock 退出码非 0: ${result.code}, stderr=${result.stderr}`);
      }
      if (!result.stdout.includes("MOCK_OPENCLAW_OK")) {
        throw new Error(`stdout 应含 MOCK_OPENCLAW_OK，实际: ${result.stdout}`);
      }
    },
  },
  {
    name: "P3 runner 透传到 mock 返回 MOCK_OPENCLAW_OK",
    async fn() {
      const result = await runCommandExecution({
        file: "node",
        args: [OPENCLAW_RUNNER, "--agent", "codemaster", "--openclaw-bin", MOCK_OPENCLAW],
        prompt: "=== Tiangong Task ===\nTask ID: P6-MOCK\nName: test\n",
        timeoutMs: 15000,
      });
      if (result.code !== 0) {
        throw new Error(`runner 退出码非 0: ${result.code}, stderr=${result.stderr}`);
      }
      if (!result.stdout.includes("MOCK_OPENCLAW_OK")) {
        throw new Error(`stdout 应含 MOCK_OPENCLAW_OK，实际: ${result.stdout}`);
      }
    },
  },
  {
    name: "argv 注入防御：--agent 含 shell 字符不执行",
    async fn() {
      // 清理可能的历史残留，保证断言基线的干净
      if (existsSync(INJECT_FILE)) rmSync(INJECT_FILE);

      const result = await runCommandExecution({
        file: "node",
        args: [MOCK_OPENCLAW, "--agent", "codemaster; touch " + INJECT_FILE],
        prompt: "P6 smoke injection test",
        timeoutMs: 10000,
      });

      // spawn shell:false → ";" 只是普通 argv 字面量，绝不被当作 shell 执行
      if (existsSync(INJECT_FILE)) {
        throw new Error(`shell 注入被执行！${INJECT_FILE} 已创建`);
      }
      // mock 收到该 argv（不执行 shell），仍正常输出并退出 0
      if (result.code !== 0) {
        throw new Error(`mock 退出码非 0: ${result.code}, stderr=${result.stderr}`);
      }
      if (!result.stdout.includes("MOCK_OPENCLAW_OK")) {
        throw new Error(`stdout 应含 MOCK_OPENCLAW_OK，实际: ${result.stdout}`);
      }
    },
  },
];

let pass = 0;
let fail = 0;

console.log("# P6 task-runner command 模式 smoke（参考 spec L74-83 验收段）");
for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
    pass++;
  } catch (e) {
    console.error(`  ✗ ${t.name}: ${e.message}`);
    fail++;
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
