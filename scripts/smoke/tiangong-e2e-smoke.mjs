#!/usr/bin/env node
/**
 * 天宫端到端任务执行冒烟测试
 *
 * 验证完整任务生命周期：
 *   1. 创建任务 → 2. 分发到 Agent → 3. Agent 认领 → 4. Agent 执行 → 5. 结果回写
 *
 * 用法：
 *   node scripts/smoke/tiangong-e2e-smoke.mjs
 *   TIANGONG_BASE_URL=https://tiangg.zeabur.app node scripts/smoke/tiangong-e2e-smoke.mjs
 */

const baseUrl = (process.env.TIANGONG_BASE_URL || "https://tiangg.zeabur.app").replace(/\/$/, "");
const trpcBase = `${baseUrl}/api/trpc`;

const TARGET_AGENT_ID = 1;           // 女娲 — 数据库 ID
const TARGET_MAILBOX_ID = "meizhizi"; // 女娲 — mailbox ID
const TEST_MARKER = `e2e-smoke-${Date.now()}`;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 60_000;

let passed = 0;
let failed = 0;
let taskDbId = null;
let taskIdStr = null;

function pass(name, detail = "") {
  passed++;
  console.log(`✅  ${name}${detail ? `: ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failed++;
  console.log(`❌  ${name}${detail ? `: ${detail}` : ""}`);
}

async function trpcPost(path, input) {
  const res = await fetch(`${trpcBase}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const error = new Error(`${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    error.status = res.status;
    error.body = text;
    throw error;
  }
  return json.result?.data ?? json;
}

async function trpcGet(path, input) {
  const qs = new URLSearchParams({ input: JSON.stringify(input) });
  const res = await fetch(`${trpcBase}/${path}?${qs.toString()}`, { method: "GET" });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const error = new Error(`${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
    error.status = res.status;
    error.body = text;
    throw error;
  }
  return json.result?.data ?? json;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
//  Step 1: 创建测试任务
// ═══════════════════════════════════════════════════════════════
async function step1_createTask() {
  console.log("\n▶ Step 1: 创建测试任务...");

  // 获取唯一 taskId（或直接生成）
  const nextId = await trpcGet("task.nextTaskId", {});
  taskIdStr = nextId?.taskId || `SMOKE-${Date.now()}`;

  const createInput = {
    taskId: taskIdStr,
    name: `【E2E冒烟】${TEST_MARKER}`,
    agentId: TARGET_AGENT_ID,
    description: "天宫端到端冒烟测试任务",
    input: "写一首关于 AI 的诗，不超过 8 行",
    status: "queued",
    lifecycleStatus: "queued",
    priority: 5,
  };

  const created = await trpcPost("task.create", createInput);
  if (!created?.success) throw new Error(`task.create 失败: ${JSON.stringify(created)}`);
  pass("task.create 成功", `taskId=${taskIdStr}`);
}

// ═══════════════════════════════════════════════════════════════
//  Step 2: 验证任务创建
// ═══════════════════════════════════════════════════════════════
async function step2_verifyCreated() {
  console.log("\n▶ Step 2: 验证任务创建...");

  // task.create 不返回 id，需要通过 task.list 查找
  const list = await trpcGet("task.list", {
    agentId: TARGET_AGENT_ID,
    status: "queued",
  });

  const task = list.find((t) => t.taskId === taskIdStr);
  if (!task) throw new Error(`在 agentId=${TARGET_AGENT_ID} 的 queued 任务中未找到 ${taskIdStr}`);
  taskDbId = task.id;
  pass("task.list 找到新建任务", `id=${taskDbId}, name=${task.name}`);

  // 用 task.getById 二次确认
  const got = await trpcGet("task.getById", { id: taskDbId });
  if (!got) throw new Error(`task.getById(${taskDbId}) 返回 null`);
  if (got.taskId !== taskIdStr) throw new Error(`taskId 不匹配: ${got.taskId} !== ${taskIdStr}`);
  if (got.status !== "queued") throw new Error(`初始状态不是 queued: ${got.status}`);
  if (got.lifecycleStatus !== "queued") throw new Error(`初始 lifecycleStatus 不是 queued: ${got.lifecycleStatus}`);
  pass("task.getById 验证通过", `status=${got.status}, lifecycle=${got.lifecycleStatus}`);
}

// ═══════════════════════════════════════════════════════════════
//  Step 3: 模拟任务分发（mailbox 通知 Agent）
// ═══════════════════════════════════════════════════════════════
async function step3_dispatchMailbox() {
  console.log("\n▶ Step 3: 通过 mailbox 通知 Agent...");

  const sent = await trpcPost("mailbox.send", {
    toMailboxId: TARGET_MAILBOX_ID,
    type: "direct",
    subject: `新任务分配: ${taskIdStr}`,
    body: `你有新的任务待认领和执行。\n\n任务: ${taskIdStr}\n内容: 写一首关于 AI 的诗，不超过 8 行`,
    payload: { taskId: taskIdStr, taskDbId, marker: TEST_MARKER, type: "task_assignment" },
  });

  if (!sent?.success || !sent.messageId) throw new Error(`mailbox.send 失败: ${JSON.stringify(sent)}`);
  pass("mailbox.send 成功", `messageId=${sent.messageId}`);
}

// ═══════════════════════════════════════════════════════════════
//  Step 4: 等待执行（轮询任务状态）
// ═══════════════════════════════════════════════════════════════
async function step4_waitExecution() {
  console.log("\n▶ Step 4: 等待任务执行（轮询最多 60s）...");

  const start = Date.now();
  let task = null;
  let lastStatus = null;
  let lastLifecycle = null;
  let pollCount = 0;

  while (Date.now() - start < MAX_POLL_MS) {
    pollCount++;
    await sleep(POLL_INTERVAL_MS);

    task = await trpcGet("task.getById", { id: taskDbId });
    if (!task) {
      console.log(`   第 ${pollCount} 次轮询: task.getById 返回 null`);
      continue;
    }

    const statusChanged = task.status !== lastStatus || task.lifecycleStatus !== lastLifecycle;
    if (statusChanged) {
      console.log(
        `   第 ${pollCount} 次轮询: status=${task.status}, lifecycle=${task.lifecycleStatus}, progress=${task.progress ?? 0}%` +
        (task.output ? `, output=${task.output.length} chars` : "")
      );
      lastStatus = task.status;
      lastLifecycle = task.lifecycleStatus;
    } else {
      process.stdout.write(`   第 ${pollCount} 次轮询: 状态未变化 \r`);
    }

    // 成功完成
    if (task.status === "done" && task.lifecycleStatus === "completed") {
      console.log("");
      pass("任务执行完成", `耗时 ${(Date.now() - start) / 1000}s, progress=${task.progress}%`);
      return task;
    }

    // 失败
    if (task.status === "failed" || ["failed", "timeout", "cancelled"].includes(task.lifecycleStatus)) {
      console.log("");
      throw new Error(
        `任务执行失败: status=${task.status}, lifecycle=${task.lifecycleStatus}, error=${task.error || "(无)"}`
      );
    }
  }

  console.log("");
  throw new Error(
    `轮询超时 (${MAX_POLL_MS / 1000}s): 最终状态 status=${task?.status || "?"}, lifecycle=${task?.lifecycleStatus || "?"}`
  );
}

// ═══════════════════════════════════════════════════════════════
//  Step 5: 验证结果
// ═══════════════════════════════════════════════════════════════
async function step5_verifyResult(task) {
  console.log("\n▶ Step 5: 验证任务结果...");

  if (task.status !== "done") {
    fail("任务状态应为 done", `实际=${task.status}`);
  } else {
    pass("任务状态为 done");
  }

  if (task.lifecycleStatus !== "completed") {
    fail("任务 lifecycleStatus 应为 completed", `实际=${task.lifecycleStatus}`);
  } else {
    pass("任务 lifecycleStatus 为 completed");
  }

  if (!task.output || task.output.trim().length === 0) {
    fail("任务 output 为空");
  } else {
    const preview = task.output.trim().slice(0, 120);
    pass("任务 output 非空", `${task.output.length} chars — "${preview}..."`);
  }

  if (task.progress !== 100) {
    fail("任务进度应为 100%", `实际=${task.progress}%`);
  } else {
    pass("任务进度为 100%");
  }

  if (task.artifacts && task.artifacts.length > 0) {
    pass("任务包含 artifacts", `${task.artifacts.length} 个`);
  } else {
    // artifact 不一定有，仅作为信息提示
    console.log(`   ℹ️  无 artifacts（非硬性要求）`);
  }
}

// ═══════════════════════════════════════════════════════════════
//  Step 6: 清理
// ═══════════════════════════════════════════════════════════════
async function step6_cleanup() {
  console.log("\n▶ Step 6: 清理测试任务...");

  if (!taskDbId) {
    console.log("   跳过清理: taskDbId 未获取");
    return;
  }

  try {
    const del = await trpcPost("task.delete", { id: taskDbId });
    if (del?.success) {
      pass("task.delete 成功", `id=${taskDbId}`);
    } else {
      fail("task.delete 失败", JSON.stringify(del));
    }
  } catch (err) {
    fail("task.delete 异常", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  天宫端到端任务执行冒烟测试");
  console.log(`  目标: ${baseUrl}`);
  console.log(`  Agent: 女娲 (id=${TARGET_AGENT_ID}, mailbox=${TARGET_MAILBOX_ID})`);
  console.log(`  Marker: ${TEST_MARKER}`);
  console.log("═══════════════════════════════════════════");

  try {
    await step1_createTask();
    await step2_verifyCreated();
    await step3_dispatchMailbox();
    const task = await step4_waitExecution();
    await step5_verifyResult(task);
  } catch (err) {
    fail("测试流程异常", err.stack || err.message);
  } finally {
    await step6_cleanup();
  }

  console.log("\n═══════════════════════════════════════════");
  console.log(`  结果: ${passed} passed / ${failed} failed`);
  if (failed === 0) {
    console.log("  🎉 PASS — 端到端任务生命周期验证通过");
  } else {
    console.log("  💥 FAIL — 存在未通过的检查项");
  }
  console.log("═══════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
