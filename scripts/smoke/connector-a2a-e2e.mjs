#!/usr/bin/env node
/**
 * 第二轮：真实 Connector 端到端最小闭环 Smoke Test
 *
 * 验证链路（本地可重复，不触碰生产）：
 *   1. agent.claimTask 返回 queued task
 *   2. connector 调用 a2a.dispatch
 *   3. connector 调用 a2a.ack
 *   4. connector 调用 task.updateProgress working (25%, 50%, 75%)
 *   5. connector 调用 a2a.submitResult
 *   6. stub 模拟 submitResult 后 final 状态为 done/completed/progress=100/artifact=1
 *   7. usage.record 被调用
 *   8. 脚本最终输出 PASS / FAIL
 *
 * 用法：
 *   node scripts/smoke/connector-a2a-e2e.mjs
 *
 * 环境：纯本地，dummy token，不连接 Zeabur / 生产 OpenClaw Gateway。
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

let wsModule;
try {
  wsModule = await import("ws");
} catch {
  console.error("❌ ws module not available; run npm install first");
  process.exit(1);
}
const { WebSocketServer } = wsModule;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");

const STUB_PORT = 0; // let OS assign
const CONNECTOR_TIMEOUT_MS = 12_000;

// ─── Call journal ───
const calls = [];

function record(procedure, input) {
  calls.push({ procedure, input, time: Date.now() });
}

// ─── tRPC response helpers ───
function sendJson(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ result: { data } }));
}

function send404(res) {
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
}

// ─── Stub state ───
let claimTaskCount = 0;
let artifactId = 0;
const taskState = {
  status: "queued",
  lifecycleStatus: "queued",
  progress: 0,
  completedAt: null,
  artifactCount: 0,
};

// ─── HTTP / tRPC stub ───
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const path = url.pathname;

  let body = "";
  for await (const chunk of req) body += chunk;

  let input = {};
  try {
    input = body ? JSON.parse(body) : {};
  } catch {
    // ignore parse errors for GET
  }

  // ── GET query endpoints (trpcQuery) ──
  if (req.method === "GET" && path.includes("/api/trpc/")) {
    const qsInput = url.searchParams.get("input");
    if (qsInput) {
      try {
        input = JSON.parse(qsInput);
      } catch {}
    }
    const proc = path.split("/api/trpc/").pop();
    record(proc, input);

    if (proc === "message.inbox") {
      sendJson(res, []);
      return;
    }
    send404(res);
    return;
  }

  // ── POST mutation endpoints (trpcCall) ──
  if (req.method === "POST" && path.includes("/api/trpc/")) {
    const proc = path.split("/api/trpc/").pop();
    record(proc, input);

    switch (proc) {
      case "agent.updateHeartbeat": {
        sendJson(res, { success: true, claimedTask: null });
        return;
      }
      case "agent.claimTask": {
        claimTaskCount++;
        if (claimTaskCount === 1) {
          sendJson(res, {
            task: {
              id: 99901,
              taskId: "SMOKE-A2A-001",
              name: "Smoke: A2A end-to-end",
              description: "Verify connector full lifecycle with echo runner",
              input: "echo hello world",
              priority: 5,
            },
          });
        } else {
          sendJson(res, { task: null });
        }
        return;
      }
      case "a2a.dispatch": {
        taskState.lifecycleStatus = "dispatched";
        sendJson(res, { success: true, lifecycleStatus: "dispatched" });
        return;
      }
      case "a2a.ack": {
        taskState.lifecycleStatus = "accepted";
        sendJson(res, { success: true, lifecycleStatus: "accepted" });
        return;
      }
      case "task.updateProgress": {
        if (typeof input.status === "string") taskState.status = input.status;
        if (typeof input.lifecycleStatus === "string") taskState.lifecycleStatus = input.lifecycleStatus;
        if (typeof input.progress === "number") taskState.progress = input.progress;
        sendJson(res, { success: true });
        return;
      }
      case "a2a.submitResult": {
        artifactId = 1;
        taskState.status = "done";
        taskState.lifecycleStatus = "completed";
        taskState.progress = 100;
        taskState.completedAt = new Date().toISOString();
        taskState.artifactCount = 1;
        sendJson(res, { success: true, lifecycleStatus: "completed", artifactId });
        return;
      }
      case "a2a.review": {
        sendJson(res, { success: true, lifecycleStatus: input.approved ? "completed" : "reviewing" });
        return;
      }
      case "a2a.fail": {
        sendJson(res, { success: true, lifecycleStatus: "failed" });
        return;
      }
      case "a2a.markAwaitingResult": {
        sendJson(res, { success: true, lifecycleStatus: "awaiting_result" });
        return;
      }
      case "usage.record": {
        sendJson(res, { success: true });
        return;
      }
      case "message.ack": {
        sendJson(res, { success: true, idempotent: false });
        return;
      }
      case "message.send": {
        sendJson(res, { success: true, messageId: 1 });
        return;
      }
      default:
        send404(res);
        return;
    }
  }

  send404(res);
});

// ─── WebSocket stub ───
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: "welcome", ok: true }));
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
          }
        } catch {}
      });
    });
  } else {
    socket.destroy();
  }
});

// ─── Main ───
async function main() {
  // 1. Start stub server
  await new Promise((r) => server.listen(STUB_PORT, "127.0.0.1", r));
  const port = server.address().port;
  console.log(`[stub] HTTP+WS stub listening on ${port}`);

  // 2. Spawn connector
  const env = {
    ...process.env,
    TIANGONG_HTTP_BASE: `http://127.0.0.1:${port}`,
    TIANGONG_WS_BASE: `ws://127.0.0.1:${port}`,
    TIANGONG_AGENT_ID: "999",
    TIANGONG_MCP_KEY: "dummy-token-for-smoke-12345",
    TIANGONG_AGENT_NAME: "SmokeAgent",
    TIANGONG_EXEC_MODE: "command",
    TIANGONG_EXEC_FILE: "node",
    TIANGONG_EXEC_ARGS_JSON: JSON.stringify([
      "scripts/openclaw-connector/examples/echo-runner.mjs",
    ]),
    TIANGONG_CLAIM_TASKS: "true",
    TIANGONG_PROCESS_INBOX: "true",
    TIANGONG_EXEC_TIMEOUT_MS: "10000",
    TIANGONG_RESULT_MAX_CHARS: "8000",
  };

  const connectorPath = resolve(ROOT, "scripts/openclaw-connector/connector.mjs");
  console.log(`[smoke] Spawning connector → ${connectorPath}`);
  const child = spawn("node", [connectorPath], {
    cwd: ROOT,
    env,
    stdio: "pipe",
  });

  let connectorOutput = "";
  child.stdout.on("data", (d) => {
    const s = d.toString();
    connectorOutput += s;
    if (process.env.SMOKE_VERBOSE) process.stdout.write(s);
  });
  child.stderr.on("data", (d) => {
    const s = d.toString();
    connectorOutput += s;
    if (process.env.SMOKE_VERBOSE) process.stderr.write(s);
  });

  // 3. Wait for connector to process the task
  console.log(`[smoke] Waiting ${CONNECTOR_TIMEOUT_MS}ms for connector to process...`);
  await new Promise((r) => setTimeout(r, CONNECTOR_TIMEOUT_MS));

  // 4. Kill connector
  console.log("[smoke] Killing connector...");
  child.kill("SIGTERM");
  await new Promise((r) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      r();
    }, 3000);
    child.on("exit", () => {
      clearTimeout(t);
      r();
    });
  });

  // 5. Close stub
  await new Promise((r) => {
    wss.close(() => server.close(r));
  });

  // 6. Analyze
  console.log("\n═══════════════════════════════════════════");
  console.log("  A2A Connector End-to-End Smoke Analysis");
  console.log("═══════════════════════════════════════════\n");

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
  }

  // Find calls
  const claimCalls = calls.filter((c) => c.procedure === "agent.claimTask");
  const dispatchCalls = calls.filter((c) => c.procedure === "a2a.dispatch");
  const ackCalls = calls.filter((c) => c.procedure === "a2a.ack");
  const progressCalls = calls.filter((c) => c.procedure === "task.updateProgress");
  const submitResultCalls = calls.filter((c) => c.procedure === "a2a.submitResult");
  const reviewCalls = calls.filter((c) => c.procedure === "a2a.review");
  const failCalls = calls.filter((c) => c.procedure === "a2a.fail");
  const usageCalls = calls.filter((c) => c.procedure === "usage.record");
  const heartbeatCalls = calls.filter((c) => c.procedure === "agent.updateHeartbeat");

  // Check 1: claimTask returned a task.
  // The request journal stores calls, while the stub response returns the task on first call.
  report(
    "agent.claimTask 被调用",
    claimCalls.length > 0,
    claimCalls.length > 0 ? `called ${claimCalls.length} time(s)` : "从未调用"
  );

  // Check 2: dispatch
  report(
    "a2a.dispatch 被调用",
    dispatchCalls.length > 0,
    dispatchCalls.length > 0 ? `called ${dispatchCalls.length} time(s)` : "从未调用"
  );

  // Check 3: ack
  report(
    "a2a.ack 被调用",
    ackCalls.length > 0,
    ackCalls.length > 0 ? `called ${ackCalls.length} time(s)` : "从未调用"
  );

  // Check 4: progress calls
  const workingProgress = progressCalls.filter((c) => c.input?.lifecycleStatus === "working");
  report(
    "task.updateProgress 包含 working 状态",
    workingProgress.length >= 1,
    workingProgress.length >= 1 ? `working updates: ${workingProgress.length}` : "无 working 进度更新"
  );

  const dispatchedProgress = progressCalls.find((c) => c.input?.lifecycleStatus === "dispatched");
  report(
    "task.updateProgress 包含 dispatched 状态 (10%)",
    dispatchedProgress !== undefined,
    dispatchedProgress ? `progress=${dispatchedProgress.input.progress}` : "无 dispatched 进度更新"
  );

  const allProgressValues = progressCalls.map((c) => c.input?.progress).filter((v) => v !== undefined);
  report(
    "进度覆盖 10/25/50/75",
    [10, 25, 50, 75].every((v) => allProgressValues.includes(v)),
    `progress values: ${allProgressValues.join(", ")}`
  );

  // Check 5: submitResult
  report(
    "a2a.submitResult 被调用",
    submitResultCalls.length > 0,
    submitResultCalls.length > 0 ? `called ${submitResultCalls.length} time(s)` : "从未调用"
  );
  const submitInput = submitResultCalls[0]?.input;
  report(
    "submitResult 包含 artifactType",
    submitInput?.artifactType !== undefined,
    submitInput ? `artifactType=${submitInput.artifactType}` : "无 submitResult input"
  );

  // Check 6: final state verification (done/completed/progress=100/completedAt/artifact=1)
  report(
    "submitResult 触发 final 状态 done/completed/progress=100/artifact=1",
    taskState.status === "done"
      && taskState.lifecycleStatus === "completed"
      && taskState.progress === 100
      && Boolean(taskState.completedAt)
      && taskState.artifactCount === 1
      && artifactId === 1,
    JSON.stringify(taskState)
  );

  // Check 7: usage.record
  report(
    "usage.record 被调用",
    usageCalls.length > 0,
    usageCalls.length > 0 ? `called ${usageCalls.length} time(s)` : "从未调用"
  );

  // Check 8: no duplicate review after submitResult (A2A-lite: submitResult is final)
  // After connector fix, review should NOT be called after submitResult
  report(
    "a2a.review 未被冗余调用（submitResult 已是最终完成）",
    reviewCalls.length === 0,
    reviewCalls.length > 0 ? `review called ${reviewCalls.length} time(s) — redundant!` : "review not called (correct)"
  );

  // Check 9: heartbeat
  report(
    "agent.updateHeartbeat 被调用",
    heartbeatCalls.length > 0,
    heartbeatCalls.length > 0 ? `called ${heartbeatCalls.length} time(s)` : "从未调用"
  );

  // Check 10: submitResult output contains expected marker from echo-runner
  const _submitInput = submitResultCalls[0]?.input;
  const hasEchoOk = _submitInput?.output?.includes("ECHO_RUNNER_OK") || connectorOutput.includes("ECHO_RUNNER_OK");
  report(
    "echo-runner 实际执行并返回 ECHO_RUNNER_OK",
    hasEchoOk,
    hasEchoOk ? "echo runner executed successfully" : "ECHO_RUNNER_OK not found in output"
  );

  // Check 11: no failure path
  report(
    "a2a.fail 未被调用（任务未失败）",
    failCalls.length === 0,
    failCalls.length > 0 ? `fail called ${failCalls.length} time(s)` : "no failure"
  );

  // Summary
  console.log(`\n═══════════════════════════════════════════`);
  console.log(`  Result: ${passed} passed / ${failed} failed`);
  if (failed === 0) {
    console.log(`  🎉 PASS`);
  } else {
    console.log(`  💥 FAIL`);
  }
  console.log(`═══════════════════════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
