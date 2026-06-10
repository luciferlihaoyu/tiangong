#!/usr/bin/env node

/**
 * Echo Runner — 天宫 P2 执行桥烟测工具
 *
 * 用途：验证 connector 的 command 执行模式。
 * 从 stdin 读取 task prompt，输出包含 "ECHO_RUNNER_OK" 和 prompt 摘要。
 *
 * 用法：
 *   echo "hello world" | node echo-runner.mjs
 *   # 输出: ECHO_RUNNER_OK | chars=11 | hello world...
 *
 *   # 模拟失败
 *   FAIL_MODE=1 node echo-runner.mjs
 *   # 退出码 1，stderr 输出错误信息
 *
 *   # 模拟超时（sleep 太久）
 *   SLEEP_SEC=400 node echo-runner.mjs
 *
 * 环境变量：
 *   FAIL_MODE=1    非 0 退出（模拟执行失败）
 *   SLEEP_SEC=N    执行前 sleep N 秒（模拟慢任务/超时）
 */

import { createInterface } from "node:readline";

async function main() {
  const failMode = process.env.FAIL_MODE === "1";
  const sleepSec = parseInt(process.env.SLEEP_SEC || "0", 10);

  // Simulate slow execution
  if (sleepSec > 0) {
    await new Promise((r) => setTimeout(r, sleepSec * 1000));
  }

  // Read all stdin
  let input = "";
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    input += line + "\n";
  }

  const trimmed = input.trim();
  const summary = trimmed.length > 200 ? trimmed.slice(0, 200) + "..." : trimmed;

  if (failMode) {
    process.stderr.write(`ECHO_RUNNER_FAIL: simulated failure\n`);
    process.exit(1);
  }

  const output = [
    `ECHO_RUNNER_OK`,
    `chars=${trimmed.length}`,
    `summary: ${summary}`,
    `---`,
    trimmed,
  ].join("\n");

  process.stdout.write(output + "\n");
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`ECHO_RUNNER_ERROR: ${err.message}\n`);
  process.exit(2);
});
