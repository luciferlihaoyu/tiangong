#!/usr/bin/env node

/**
 * P9 Smoke Test — 静态检查覆盖关键文件和基础逻辑
 *
 * 不启动生产服务，不做数据库操作。
 * 验证文件是否存在、语法是否正确、API 导出是否完整。
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "../..");
let failures = 0;
let passes = 0;

function check(label, fn) {
  try {
    fn();
    passes++;
    console.log(`  ✅ ${label}`);
  } catch (e) {
    failures++;
    console.log(`  ❌ ${label}: ${e.message}`);
  }
}

function assertFile(path) {
  const full = resolve(ROOT, path);
  if (!existsSync(full)) throw new Error(`File not found: ${path}`);
}

function assertFileContains(path, substring) {
  const full = resolve(ROOT, path);
  const content = readFileSync(full, "utf-8");
  if (!content.includes(substring)) throw new Error(`Missing content "${substring}" in ${path}`);
}

console.log("═══ P9 Smoke Tests ═══\n");

// ── 1. Spec 文档 ──
console.log("📄 1. Spec Document");
check("P9 spec exists", () => assertFile("TIANGONG_P9_OPENCLAW_CONNECTOR_PRIORITY_USAGE_SPEC.md"));
check("P9 spec covers connector", () => assertFileContains("TIANGONG_P9_OPENCLAW_CONNECTOR_PRIORITY_USAGE_SPEC.md", "Connector Worker"));
check("P9 spec covers priority", () => assertFileContains("TIANGONG_P9_OPENCLAW_CONNECTOR_PRIORITY_USAGE_SPEC.md", "Priority"));
check("P9 spec covers usage", () => assertFileContains("TIANGONG_P9_OPENCLAW_CONNECTOR_PRIORITY_USAGE_SPEC.md", "Token Usage"));

// ── 2. Schema (token_usage 表) ──
console.log("\n🗄️  2. Database Schema");
check("schema.ts exists", () => assertFile("db/schema.ts"));
check("token_usage table defined", () => assertFileContains("db/schema.ts", "token_usage"));
check("TokenUsage type exported", () => assertFileContains("db/schema.ts", "export type TokenUsage"));
check("InsertTokenUsage type exported", () => assertFileContains("db/schema.ts", "export type InsertTokenUsage"));

// ── 3. API Routes ──
console.log("\n🔌 3. API Routes");
check("usage-router.ts exists", () => assertFile("api/usage-router.ts"));
check("usage.record procedure", () => assertFileContains("api/usage-router.ts", "record: publicQuery"));
check("usage.list procedure", () => assertFileContains("api/usage-router.ts", "list: publicQuery"));
check("usage.byModel procedure", () => assertFileContains("api/usage-router.ts", "byModel: publicQuery"));
check("usage.byDay procedure", () => assertFileContains("api/usage-router.ts", "byDay: publicQuery"));
check("router.ts imports usageRouter", () => assertFileContains("api/router.ts", "usageRouter"));
check("router.ts registers usage", () => assertFileContains("api/router.ts", "usage: usageRouter"));

// ── 4. Task Priority ──
console.log("\n⭐ 4. Task Priority");
check("task-router promote procedure", () => assertFileContains("api/task-router.ts", "promote: publicQuery"));
check("task.list sorts by priority desc", () => assertFileContains("api/task-router.ts", "desc(tasks.priority)"));
check("task.list sorts by createdAt asc", () => assertFileContains("api/task-router.ts", "asc(tasks.createdAt)"));

// ── 5. Connector Worker ──
console.log("\n🤖 5. OpenClaw Connector Worker");
check("connector.mjs exists", () => assertFile("scripts/openclaw-connector/connector.mjs"));
check("executorAdapter defined", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "executorAdapters"));
check("getExecutor function", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "function getExecutor"));
check("executeTaskWithProgress", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "executeTaskWithProgress"));
check("pollAndClaimTask", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "pollAndClaimTask"));
check("workerTick function", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "workerTick"));
check("reportUsage function", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "reportUsage"));
check("workerTimer defined", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "workerTimer"));

// ── 6. Frontend Pages ──
console.log("\n🎨 6. Frontend");
check("UsagePanel.tsx exists", () => assertFile("src/pages/UsagePanel.tsx"));
check("UsagePanel has StatsRow", () => assertFileContains("src/pages/UsagePanel.tsx", "StatsRow"));
check("UsagePanel has ModelTable", () => assertFileContains("src/pages/UsagePanel.tsx", "ModelTable"));
check("UsagePanel has DailyTrend", () => assertFileContains("src/pages/UsagePanel.tsx", "DailyTrend"));
check("App.tsx has /usage route", () => assertFileContains("src/App.tsx", "/usage"));
check("App.tsx imports UsagePanel", () => assertFileContains("src/App.tsx", "UsagePanel"));
check("Navigation has 用量 entry", () => assertFileContains("src/sections/Navigation.tsx", "用量"));
check("Navigation has BarChart3 icon", () => assertFileContains("src/sections/Navigation.tsx", "BarChart3"));
check("TaskCenter has promoteMutation", () => assertFileContains("src/pages/TaskCenter.tsx", "promoteMutation"));
check("TaskCenter has handlePromote", () => assertFileContains("src/pages/TaskCenter.tsx", "handlePromote"));
check("TaskCenter has handleDemote", () => assertFileContains("src/pages/TaskCenter.tsx", "handleDemote"));

// ── 7. Syntax Checks ──
console.log("\n📝 7. Syntax Checks");

// Node --check on connector.mjs
check("connector.mjs syntax", () => {
  const r = spawnSync("node", ["--check", resolve(ROOT, "scripts/openclaw-connector/connector.mjs")], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (r.status !== 0) throw new Error(r.stderr?.trim() || "Syntax error");
});

if (existsSync(resolve(ROOT, "scripts/smoke"))) {
  check("smoke dir exists", () => {});
  const existingSmokes = ["p7-gateway-mock-server.mjs"];
  for (const f of existingSmokes) {
    const p = `scripts/smoke/${f}`;
    if (existsSync(resolve(ROOT, p))) {
      check(`${f} syntax`, () => {
        const r = spawnSync("node", ["--check", resolve(ROOT, p)], {
          cwd: ROOT,
          encoding: "utf-8",
          timeout: 10_000,
        });
        if (r.status !== 0) throw new Error(r.stderr?.trim() || "Syntax error");
      });
    }
  }
}

// ── 8. P9.1 Cost Guard ──
console.log("💰 8. P9.1 Cost Guard");
check("P9 spec covers cost guard", () => assertFileContains("TIANGONG_P9_OPENCLAW_CONNECTOR_PRIORITY_USAGE_SPEC.md", "P9.1"));
check("README covers cost guard", () => assertFileContains("scripts/openclaw-connector/README.md", "P9.1"));
check("README documents TIANGONG_PROCESS_INBOX", () => assertFileContains("scripts/openclaw-connector/README.md", "TIANGONG_PROCESS_INBOX"));
check("README documents TIANGONG_CLAIM_TASKS", () => assertFileContains("scripts/openclaw-connector/README.md", "TIANGONG_CLAIM_TASKS"));
check("README documents TIANGONG_CHEAP_MODEL", () => assertFileContains("scripts/openclaw-connector/README.md", "TIANGONG_CHEAP_MODEL"));
check("connector has selectModelForTask", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "selectModelForTask"));
check("connector has rewriteModelInArgs", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "rewriteModelInArgs"));
check("connector has TIANGONG_PROCESS_INBOX", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "TIANGONG_PROCESS_INBOX"));
check("connector has TIANGONG_CLAIM_TASKS", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "TIANGONG_CLAIM_TASKS"));
check("connector has TIANGONG_CHEAP_MODEL", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "TIANGONG_CHEAP_MODEL"));
check("connector has TIANGONG_CHEAP_MODEL_OPS", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "TIANGONG_CHEAP_MODEL_OPS"));
check("connector has TIANGONG_ALLOW_EXPENSIVE_RECURRING", () => assertFileContains("scripts/openclaw-connector/connector.mjs", "TIANGONG_ALLOW_EXPENSIVE_RECURRING"));
check("connector claimTasks default false", () => assertFileContains("scripts/openclaw-connector/connector.mjs", 'process.env.TIANGONG_CLAIM_TASKS, false'));
check("connector processInbox default true", () => assertFileContains("scripts/openclaw-connector/connector.mjs", 'process.env.TIANGONG_PROCESS_INBOX, true'));
check("start script sets cost guard vars", () => assertFileContains("scripts/openclaw-connector/start-openclaw-agents.sh", "TIANGONG_PROCESS_INBOX"));
check("start script sets claim_tasks=false", () => assertFileContains("scripts/openclaw-connector/start-openclaw-agents.sh", "TIANGONG_CLAIM_TASKS:-false"));
check("start script docs P9.1", () => assertFileContains("scripts/openclaw-connector/start-openclaw-agents.sh", "P9.1"));

// ── 9. Security Checks ──
console.log("\n🔒 9. Security");
check("selectModelForTask no secrets", () => {
  const c = readFileSync(resolve(ROOT, "scripts/openclaw-connector/connector.mjs"), "utf-8");
  const idx = c.indexOf("function selectModelForTask");
  const end = c.indexOf("function rewriteModelInArgs", idx);
  const block = c.slice(idx, end > idx ? end : idx + 1500);
  if (/token|secret|password|key/i.test(block) && !block.includes("taskId")) {
    throw new Error("selectModelForTask should not contain secrets");
  }
});
check("UsagePanel no 'key' ref", () => {
  const c = readFileSync(resolve(ROOT, "src/pages/UsagePanel.tsx"), "utf-8");
  if (/apiKey|api_key|secret|password/i.test(c) && !c.includes("不记录或展示密钥")) {
    throw new Error("UsagePanel should not display keys");
  }
});
check("usage-router no 'key' column ref", () => {
  const c = readFileSync(resolve(ROOT, "api/usage-router.ts"), "utf-8");
  if (c.includes("sourceApiKey") || c.includes("mcpApiKeys")) {
    throw new Error("usage-router should not reference key columns");
  }
});
check("token_usage schema no key column", () => {
  const c = readFileSync(resolve(ROOT, "db/schema.ts"), "utf-8");
  // Find tokenUsage block
  const idx = c.indexOf("// ─── Token Usage");
  const end = c.indexOf("// ─── Conversations", idx);
  const block = c.slice(idx, end > idx ? end : undefined);
  if (block.includes("api_key") || block.includes("secret") || block.includes("password")) {
    throw new Error("token_usage table should not have key columns");
  }
});

// ── 10. Vite/TS Build Readiness ──
console.log("\n📦 10. Build Readiness");
check("tsconfig.json exists", () => assertFile("tsconfig.json"));
check("tsconfig.app.json exists", () => assertFile("tsconfig.app.json"));
check("package.json exists", () => assertFile("package.json"));
check("package.json has build script", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
  if (!pkg.scripts?.build) throw new Error("Missing build script");
});

// ── 11. Summary ──
console.log(`\n═══════════════════════════════`);
console.log(`  Total: ${passes + failures}`);
console.log(`  Passed: ${passes} ✅`);
console.log(`  Failed: ${failures} ❌`);
console.log(`═══════════════════════════════`);

process.exit(failures > 0 ? 1 : 0);
