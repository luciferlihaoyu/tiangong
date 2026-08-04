#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const OPENCODE_BIN = "/usr/local/bin/opencode";
const DEFAULT_MODEL = "openai/gpt-5.6-sol";

async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(data);
    };

    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", finish);
    const timer = setTimeout(finish, 5000);
  });
}

function runOpenCode(prompt, workDir) {
  return new Promise((resolve, reject) => {
    const args = ["run", prompt, "--dir", workDir, "--print-logs"];
    const model = process.env.OPENCODE_MODEL;
    if (model) args.push("-m", model);
    if (process.env.OPENCODE_AUTO !== "false") args.push("--auto");

    const configuredTimeout = Number.parseInt(process.env.OPENCODE_TIMEOUT_MS || "900000", 10);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 900000;
    const child = spawn(OPENCODE_BIN, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { process.stderr.write(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(new Error(`Failed to spawn OpenCode: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        reject(new Error(`OpenCode timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        reject(new Error(`OpenCode exited with code ${code}`));
      } else {
        resolve(stdout.trim() || "[无输出]");
      }
    });
  });
}

async function reportUsage(prompt, result) {
  const mcpKey = process.env.TIANGONG_MCP_KEY;
  if (process.env.TIANGONG_REPORT_USAGE !== "true" || !mcpKey) return;

  const agentId = Number.parseInt(process.env.TIANGONG_AGENT_ID || "0", 10);
  if (!agentId) return;

  const promptTokens = Math.max(10, Math.floor(prompt.length / 3));
  const completionTokens = Math.max(5, Math.floor(result.length / 2));
  const totalTokens = promptTokens + completionTokens;
  const httpBase = (process.env.TIANGONG_HTTP_BASE || "https://tiangg.zeabur.app").replace(/\/$/, "");

  try {
    const response = await fetch(`${httpBase}/api/trpc/usage.record`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcp-key": mcpKey,
      },
      body: JSON.stringify({
        model: process.env.OPENCODE_MODEL || DEFAULT_MODEL,
        provider: "opencode",
        promptTokens,
        completionTokens,
        totalTokens,
        cachedPromptTokens: 0,
        uncachedPromptTokens: promptTokens,
        callCount: 1,
        agentId,
        source: "opencode-runner",
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      process.stderr.write(`[opencode-runner] usage report failed: HTTP ${response.status}: ${body.slice(0, 200)}\n`);
    }
  } catch (error) {
    process.stderr.write(`[opencode-runner] usage report failed: ${error.message}\n`);
  }
}

async function main() {
  const prompt = await readStdin();
  if (!prompt.trim()) throw new Error("stdin prompt is empty");

  const taskId = process.env.TIANGONG_TASK_ID || "0";
  const workRoot = process.env.OPENCODE_WORK_DIR || "/opt/tiangong-tasks";
  const workDir = join(workRoot, `task-${taskId}`);
  await mkdir(workDir, { recursive: true });

  const result = await runOpenCode(prompt, workDir);
  await reportUsage(prompt, result);
  process.stdout.write(`${result}\n`);
}

main().catch((error) => {
  process.stderr.write(`[opencode-runner] ${error.message}\n`);
  process.exitCode = 1;
});
