#!/usr/bin/env node

/**
 * A2A-lite v0.1 验证脚本
 *
 * 验证核心语义：
 *  1. started ≠ completed/done（投递成功不代表最终完成）
 *  2. dispatch/ack/result 三段式状态可记录
 *  3. 只有 final result 才产生 artifact
 *
 * 用法:
 *   node scripts/verify-a2a-v01.mjs [--verbose]
 *
 * 通过检查代码中的状态转换逻辑进行静态验证。
 * 不需要运行服务。
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const VERBOSE = process.argv.includes("--verbose");

let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
    if (detail) console.log(`     ${detail}`);
  }
  if (VERBOSE && detail) console.log(`     → ${detail}`);
}

// ─── Check 1: task-runner.ts uses A2A lifecycle statuses, not just "done" ───
{
  const runner = readFileSync(resolve(root, "api/lib/task-runner.ts"), "utf-8");
  
  // Must contain lifecycleStatus updates
  report(
    "TaskRunner 使用 lifecycleStatus",
    runner.includes("lifecycleStatus"),
    "task-runner.ts should set lifecycleStatus fields"
  );

  // Must NOT go directly from running->done without lifecycleStatus
  const hasDone = runner.includes('status: "done"') || runner.includes("status: 'done'");
  const hasSubmitted = runner.includes('lifecycleStatus: "submitted"') || runner.includes("lifecycleStatus: 'submitted'");
  const hasCompleted = runner.includes('lifecycleStatus: "completed"') || runner.includes("lifecycleStatus: 'completed'");
  const hasFailed = runner.includes('status: "failed"') || runner.includes("status: 'failed'");
  const failedWithLifecycle = runner.includes('lifecycleStatus: "failed"') || runner.includes("lifecycleStatus: 'failed'");
  report(
    "done 状态先设置 lifecycleStatus=submitted，再 completed",
    (hasDone && hasSubmitted && hasCompleted) || !hasDone,
    `done blocks should transition through submitted before completed`
  );
  report(
    "failed 状态同步设置 lifecycleStatus=failed",
    (hasFailed && failedWithLifecycle) || !hasFailed,
    `failed blocks have lifecycleStatus=failed`
  );

  // Must not directly jump to completed without submitted
  report(
    "TaskRunner 不直接跳过 submitted 到 completed",
    runner.includes('lifecycleStatus: "submitted"'),
    "runner must set submitted before completed"
  );

  // Must handle awaiting_result
  report(
    "TaskRunner 处理 awaiting_result",
    runner.includes("awaiting_result"),
    "task-runner.ts should handle gateway-started-only case"
  );

  report(
    "TaskRunner command exit code 2 转 awaitingResult",
    runner.includes("code === 2") && runner.includes("awaitingResult: true"),
    "command runner should map runner.mjs exit code 2 to awaiting_result"
  );

  // Must record artifacts
  report(
    "TaskRunner 记录 artifacts",
    runner.includes("taskArtifacts") || runner.includes("recordArtifact"),
    "task-runner.ts should write taskArtifacts"
  );
}

// ─── Check 2: a2a-router.ts has dispatch/ack/result endpoints ───
{
  const a2a = readFileSync(resolve(root, "api/a2a-router.ts"), "utf-8");

  report(
    "A2A router 有 dispatch endpoint",
    a2a.includes("dispatch:") && a2a.includes("lifecycleStatus") && a2a.includes('"dispatched"'),
    "dispatch mutation exists"
  );

  report(
    "A2A router 有 ack endpoint",
    a2a.includes("ack:") && a2a.includes('"accepted"'),
    "ack mutation exists"
  );

  report(
    "A2A router 有 submitResult endpoint",
    a2a.includes("submitResult") && a2a.includes("recordArtifact"),
    "submitResult creates artifact"
  );

  report(
    "A2A submitResult 设置 submitted 并保留 artifact",
    a2a.includes("submitResult")
      && a2a.includes('const nextStatus: (typeof LIFECYCLE_STATUSES)[number] = "submitted"')
      && a2a.includes('status: "running"')
      && a2a.includes("Math.max(task.progress ?? 0, 95)")
      && !a2a.includes('completedAt: new Date()')
      && a2a.includes("recordArtifact"),
    "submitResult should mark task submitted/running (not done/completed) and create artifact"
  );

  report(
    "A2A review 负责 submitted→completed 转换",
    a2a.includes("review:")
      && a2a.includes('"submitted"')
      && a2a.includes('"reviewing"')
      && a2a.includes('"completed"')
      && a2a.includes("isValidLifecycleTransition"),
    "review mutation handles approval and completion"
  );

  report(
    "A2A 有严格生命周期转换校验",
    a2a.includes("to === \"completed\"") && a2a.includes("to === \"submitted\"") && a2a.includes("to === \"reviewing\"") && a2a.includes("isValidLifecycleTransition"),
    "lifecycle transitions enforce strict ordering"
  );

  report(
    "A2A router 有 getThread endpoint 返回 messages/artifacts",
    a2a.includes("getThread") && (a2a.includes("messages:") || a2a.includes("threads:")) && a2a.includes("artifacts"),
    "getThread returns thread data"
  );

  report(
    "A2A router 有 markAwaitingResult",
    a2a.includes("markAwaitingResult") || a2a.includes("awaiting_result"),
    "can mark tasks as awaiting result"
  );

  report(
    "A2A router 有 fail/timeout/cancel endpoints",
    a2a.includes('"failed"') && a2a.includes('"timeout"') && a2a.includes('"cancelled"'),
    "terminal states exist"
  );
}

// ─── Check 3: Schema has new tables and fields ───
{
  const schema = readFileSync(resolve(root, "db/schema.ts"), "utf-8");

  report(
    "Schema 有 agents.agentCard 字段",
    schema.includes("agent_card"),
    "agent_card column in agents table"
  );

  report(
    "Schema 有 agents.openclawAgent 字段",
    schema.includes("openclaw_agent"),
    "openclaw_agent column in agents table"
  );

  report(
    "Schema 有 agents.canModifyTiangongCore 字段",
    schema.includes("can_modify_tiangong_core"),
    "permission boundary field exists"
  );

  report(
    "Schema 有 agents.canSendExternalMessage 字段",
    schema.includes("can_send_external_message"),
    "permission boundary field exists"
  );

  report(
    "Schema 有 tasks.lifecycleStatus 字段",
    schema.includes("lifecycle_status"),
    "lifecycle_status column in tasks table"
  );

  report(
    "Schema 有 tasks.dispatchedAt/acceptedAt/completedAt 时间戳",
    schema.includes("dispatched_at") && schema.includes("accepted_at") && schema.includes("completed_at"),
    "A2A timestamp columns"
  );

  report(
    "Schema 有 task_threads 表",
    schema.includes("task_threads"),
    "task_threads table defined"
  );

  report(
    "Schema 有 task_messages 表",
    schema.includes("task_messages"),
    "task_messages table defined"
  );

  report(
    "Schema 有 task_artifacts 表",
    schema.includes("task_artifacts"),
    "task_artifacts table defined"
  );
}

// ─── Check 4: connector.mjs has A2A dispatch/ack/result flow ───
{
  const conn = readFileSync(resolve(root, "scripts/openclaw-connector/connector.mjs"), "utf-8");

  report(
    "Connector 使用 a2a.dispatch",
    conn.includes("a2a.dispatch"),
    "connector dispatches through a2a router"
  );

  report(
    "Connector 使用 a2a.ack",
    conn.includes("a2a.ack"),
    "connector acknowledges through a2a router"
  );

  report(
    "Connector 使用 a2a.submitResult",
    conn.includes("a2a.submitResult"),
    "connector submits results through a2a router"
  );

  report(
    "Connector 使用 a2a.review 完成 submitted 任务",
    conn.includes("a2a.review") && conn.includes("approved: true"),
    "connector calls review after submitResult to complete task"
  );

  report(
    "Connector 使用 lifecycleStatus",
    conn.includes("lifecycleStatus"),
    "connector sets lifecycle status"
  );
}

// ─── Check 5: runner.mjs exits with code 2 for awaiting_result ───
{
  const runner = readFileSync(resolve(root, "scripts/openclaw-connector/runner.mjs"), "utf-8");

  report(
    "Runner 对 started-only 退出码 2（awaiting_result）",
    runner.includes("exit(2)") || runner.includes("awaiting final result"),
    "runner exits 2 when gateway returns started only"
  );

  report(
    "Runner 不将 started 当最终输出",
    runner.includes("isOnlyStarted"),
    "runner checks for started-only responses"
  );
}

// ─── Check 6: agent-router.ts sets lifecycleStatus on claim ───
{
  const ar = readFileSync(resolve(root, "api/agent-router.ts"), "utf-8");

  report(
    "Agent claimTask 设置 lifecycleStatus=claimed",
    ar.includes("lifecycleStatus") && ar.includes('"claimed"'),
    "claim sets lifecycle to claimed"
  );

  report(
    "Agent claimTask 设置 claimedAt 时间戳",
    ar.includes("claimedAt"),
    "claim records claimedAt timestamp"
  );
}

// ─── Check 7: tRPC router registered ───
{
  const router = readFileSync(resolve(root, "api/router.ts"), "utf-8");
  report(
    "a2a router 被注册到 appRouter",
    router.includes("a2a:") && router.includes("a2aRouter"),
    "a2a router registered in appRouter"
  );
}

// ─── Check 8: task-router returns thread messages and artifacts ───
{
  const tr = readFileSync(resolve(root, "api/task-router.ts"), "utf-8");
  report(
    "Task getById 返回 threadMessages 和 artifacts",
    tr.includes("threadMessages") && tr.includes("artifacts"),
    "task getById returns A2A thread data"
  );
}

// ─── Check 9: version metadata is generated from real git/build env ───
{
  const commit = readFileSync(resolve(root, "api/commit.ts"), "utf-8");
  const boot = readFileSync(resolve(root, "api/boot.ts"), "utf-8");
  const pkg = readFileSync(resolve(root, "package.json"), "utf-8");

  report(
    "api/commit.ts 由构建脚本生成",
    commit.includes("BUILD_TIME") && commit.includes("COMMIT_SHA") && commit.includes("BRANCH"),
    "commit.ts contains generated build metadata"
  );

  report(
    "/api/version 使用 BUILD_META 字段",
    boot.includes("BUILD_META") && boot.includes("shortCommit") && boot.includes("branch"),
    "version endpoint uses generated build metadata"
  );

  report(
    "package.json 有 prebuild/precheck 脚本生成元数据",
    pkg.includes("prebuild") && pkg.includes("precheck") && pkg.includes("generate-build-meta"),
    "build scripts invoke metadata generation"
  );
}

// ─── Check 10: thread messages record lifecycle events ───
{
  const a2a = readFileSync(resolve(root, "api/a2a-router.ts"), "utf-8");
  report(
    "A2A router 线程消息记录 lifecycleStatus",
    a2a.includes("lifecycleStatus: nextStatus") || a2a.includes("lifecycleStatus: \"submitted\""),
    "task messages include lifecycle status in metadata"
  );
}

// ─── Summary ───
console.log(`\n══════════════════════════════════════════════`);
console.log(`  A2A-lite v0.1 验证完成`);
console.log(`  ✅ 通过: ${passed}  /  ${passed + failed}`);
if (failed > 0) {
  console.log(`  ❌ 失败: ${failed}`);
}
console.log(`══════════════════════════════════════════════\n`);

if (failed > 0) {
  process.exit(1);
}
