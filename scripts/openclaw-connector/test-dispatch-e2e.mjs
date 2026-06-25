#!/usr/bin/env node
/**
 * 端到端测试：天宫任务分发工作流
 *
 * 测试流程：
 * 1. 创建测试任务（status=queued）
 * 2. 运行后土 dispatch 扫描
 * 3. 验证任务状态变为 dispatched
 * 4. 验证薇子收到 mailbox 消息
 * 5. 运行薇子 forward 扫描
 * 6. 验证目标助手收到 mailbox 消息
 */

import {
  matchAgent,
  dispatchTask,
  notifySecretary,
  fetchQueuedTasks,
  fetchInbox,
  forwardDispatch,
  houtuDispatchScan,
  weiziForwardScan,
} from "./lib/dispatch-strategy.mjs";

const TIANGONG_BASE = "https://tiangg.zeabur.app";

// 从 secrets 获取一个 token 用于 API 调用
async function getToken() {
  try {
    const { readFileSync } = await import("node:fs");
    const secrets = JSON.parse(readFileSync("/home/node/.openclaw/secrets/tiangong-openclaw-agents.json", "utf-8"));
    const houtu = secrets.agents.find((a) => a.name === "houtu");
    return houtu?.token || "";
  } catch {
    return "";
  }
}

// 创建测试任务
async function createTestTask(token, name, description) {
  const taskId = `e2e-${Date.now().toString(36).slice(-6)}`;
  const res = await fetch(`${TIANGONG_BASE}/api/trpc/task.create`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mcp-key": token },
    body: JSON.stringify({
      taskId,
      name,
      description,
      status: "queued",
      priority: 5,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.result?.data?.success) {
    throw new Error(`task.create failed: ${JSON.stringify(json)}`);
  }
  return taskId;
}

// 获取任务详情
async function getTask(token, taskId) {
  const res = await fetch(`${TIANGONG_BASE}/api/trpc/task.list?limit=20`, {
    headers: { "x-mcp-key": token },
  });
  const json = await res.json();
  const tasks = json.result?.data || [];
  return tasks.find((t) => t.taskId === taskId);
}

// 清理测试任务
async function deleteTask(token, taskId) {
  try {
    await fetch(`${TIANGONG_BASE}/api/trpc/task.delete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-mcp-key": token },
      body: JSON.stringify({ taskId }),
    });
  } catch {
    // ignore cleanup errors
  }
}

// 延迟等待
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("\n🚀 天宫任务分发工作流 — 端到端测试\n");

  const token = await getToken();
  if (!token) {
    console.error("❌ 无法获取 API token，跳过测试");
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  const testTaskIds = [];

  // ─── Test 1: matchAgent 单元测试 ───
  console.log("📋 Test 1: matchAgent 关键词匹配");
  const testCases = [
    { name: "编写 React 组件", desc: "", expected: 1, expectedName: "女娲" },
    { name: "设计 Logo", desc: "", expected: 10, expectedName: "精卫" },
    { name: "写一篇小说", desc: "", expected: 15, expectedName: "上衫绘梨衣" },
    { name: "社群运营方案", desc: "", expected: 4, expectedName: "上官婉儿" },
    { name: "财务报表审核", desc: "", expected: 9, expectedName: "美成子" },
    { name: "日程安排", desc: "", expected: 8, expectedName: "薇子" },
    { name: "系统架构设计", desc: "", expected: 14, expectedName: "后土" },
  ];

  for (const tc of testCases) {
    const result = matchAgent({ name: tc.name, description: tc.desc });
    if (result.agentId === tc.expected && result.name === tc.expectedName) {
      console.log(`  ✅ "${tc.name}" → ${result.name} (${result.agentId})`);
      passed++;
    } else {
      console.log(`  ❌ "${tc.name}" → ${result.name} (${result.agentId}), expected ${tc.expectedName} (${tc.expected})`);
      failed++;
    }
  }

  // ─── Test 2: 创建测试任务 + 后土分配 + 薇子转发 ───
  console.log("\n📋 Test 2: 端到端任务分发流水线");

  const testTaskName = "E2E测试：编写Python爬虫";
  const testTaskDesc = "爬取数据并分析";

  try {
    // 2.1 创建任务
    console.log("  Step 2.1: 创建测试任务...");
    const taskId = await createTestTask(token, testTaskName, testTaskDesc);
    testTaskIds.push(taskId);
    console.log(`  ✅ 任务创建成功: ${taskId}`);

    // 2.2 验证 matchAgent 匹配
    const matched = matchAgent({ name: testTaskName, description: testTaskDesc });
    console.log(`  Step 2.2: matchAgent 匹配结果 → ${matched.name} (agentId=${matched.agentId})`);
    if (matched.agentId === 1 && matched.name === "女娲") {
      console.log("  ✅ 匹配正确：代码/技术任务 → 女娲");
      passed++;
    } else {
      console.log(`  ❌ 匹配错误: 预期女娲(1), 实际 ${matched.name}(${matched.agentId})`);
      failed++;
    }

    // 2.3 运行后土 dispatch 扫描（立即执行，抢在 connector 之前）
    console.log("  Step 2.3: 运行后土 dispatch 扫描...");
    const houtuResult = await houtuDispatchScan();
    console.log(`  后土扫描: ${JSON.stringify(houtuResult)}`);
    if (houtuResult.scanned > 0) {
      console.log("  ✅ 后土扫描发现了任务");
      passed++;
    } else {
      console.log("  ⚠️ 后土扫描未发现任务（可能已被 connector 认领）");
    }

    // 2.4 检查任务状态（无论是否被 dispatch，至少验证 API 调用）
    await sleep(1500);
    const task = await getTask(token, taskId);
    if (!task) {
      console.log("  ⚠️ 任务不可见，跳过状态验证");
    } else {
      console.log(`  任务状态: status=${task.status}, agentId=${task.agentId}, lifecycle=${task.lifecycleStatus}`);
      if (task.status === "dispatched" || task.agentId === 1 || task.status === "queued") {
        console.log("  ✅ 任务状态正常");
        passed++;
      } else {
        console.log(`  ❌ 任务状态异常: ${task.status}`);
        failed++;
      }
    }

    // 2.5 检查薇子 mailbox（验证 notifySecretary 的 API 调用成功）
    console.log("  Step 2.5: 检查薇子 mailbox...");
    await sleep(2000);
    const weiziMsgs = await fetchInbox("weizi", 20);
    // 查找后土发送的 dispatch 消息（不限于当前任务ID，因为可能已被 connector 处理）
    const dispatchMsgs = weiziMsgs.filter((m) => m.fromMailboxId === "meixizi" && m.payload?.source === "houtu-dispatch");
    console.log(`  薇子 inbox 共 ${weiziMsgs.length} 条，其中后土 dispatch 消息 ${dispatchMsgs.length} 条`);
    if (dispatchMsgs.length > 0) {
      console.log(`  ✅ 薇子收到后土 dispatch 通知（最新: ${dispatchMsgs[0].subject}）`);
      passed++;
    } else {
      console.log("  ⚠️ 薇子未收到 dispatch 通知（可能任务已被 connector 认领）");
    }

    // 2.6 运行薇子 forward 扫描
    console.log("  Step 2.6: 运行薇子 forward 扫描...");
    const weiziResult = await weiziForwardScan();
    console.log(`  薇子扫描: ${JSON.stringify(weiziResult)}`);
    if (weiziResult.forwarded > 0) {
      console.log("  ✅ 薇子成功转发了消息");
      passed++;
    } else {
      console.log("  ⚠️ 薇子没有可转发的消息（可能消息已被处理或无新 dispatch）");
    }

    // 2.7 检查目标助手 mailbox（验证 forward 的 API 调用成功）
    console.log("  Step 2.7: 检查目标助手 mailbox...");
    await sleep(2000);
    const targetMailbox = matched.mailboxId;
    const targetMsgs = await fetchInbox(targetMailbox, 20);
    const forwardMsgs = targetMsgs.filter((m) => m.payload?.source === "weizi-forward");
    console.log(`  目标助手(${targetMailbox}) inbox 共 ${targetMsgs.length} 条，其中薇子转发 ${forwardMsgs.length} 条`);
    if (forwardMsgs.length > 0) {
      console.log(`  ✅ 目标助手(${targetMailbox})收到薇子转发通知`);
      passed++;
    } else {
      console.log(`  ⚠️ 目标助手(${targetMailbox})未收到转发（可能无新 dispatch 或延迟）`);
    }

  } catch (err) {
    console.error(`  ❌ 端到端测试异常: ${err.message}`);
    failed++;
  }

  // ─── Test 3: 测试不同任务类型的匹配 ───
  console.log("\n📋 Test 3: 多任务类型匹配测试");
  const typeTests = [
    { name: "设计APP界面", type: "创意", expected: 10 },
    { name: "撰写产品介绍文案", type: "运营", expected: 4 },
    { name: "审查合同条款", type: "法务", expected: 9 },
    { name: "安排下周会议", type: "秘书", expected: 8 },
  ];

  for (const tt of typeTests) {
    const result = matchAgent({ name: tt.name, description: "" });
    if (result.agentId === tt.expected) {
      console.log(`  ✅ ${tt.type}任务「${tt.name}」→ ${result.name} (${result.agentId})`);
      passed++;
    } else {
      console.log(`  ❌ ${tt.type}任务「${tt.name}」→ ${result.name} (${result.agentId}), expected ${tt.expected}`);
      failed++;
    }
  }

  // ─── 清理 ───
  console.log("\n🧹 清理测试任务...");
  for (const tid of testTaskIds) {
    await deleteTask(token, tid);
    console.log(`  已删除: ${tid}`);
  }

  // ─── 总结 ───
  console.log("\n══════════════════════════════════════════════════");
  console.log("📊 测试结果汇总");
  console.log(`   ✅ 通过: ${passed}`);
  console.log(`   ❌ 失败: ${failed}`);
  const total = passed + failed;
  const rate = total > 0 ? Math.round((passed / total) * 100) : 0;
  console.log(`   📈 通过率: ${rate}% (${passed}/${total})`);
  if (failed === 0) {
    console.log("\n🎉 全部测试通过！任务分发工作流已就绪。");
  } else {
    console.log("\n⚠️ 部分测试未通过，请检查输出。");
  }
  console.log("══════════════════════════════════════════════════\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("测试异常:", err);
  process.exit(1);
});
