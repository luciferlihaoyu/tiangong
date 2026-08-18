#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVIDER_ID,
  buildProviderConfig,
  parseEventStream,
  aggregateUsage,
  estimateUsage,
  buildUsagePayload,
} from "./lib/opencode-usage.mjs";

const OPENCODE_BIN = process.env.OPENCODE_BIN || "/usr/local/bin/opencode";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_BASE_URL = "https://woppis1.zeabur.app";

/**
 * Load runner-scoped secrets from a git-ignored .env.local next to this file.
 * Only sets variables that are not already present in the environment, so real
 * env vars always win. Never commit the .env.local file.
 */
function loadLocalEnv() {
  try {
    const raw = readFileSync(join(import.meta.dirname, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      let value = rawValue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // no .env.local — rely on the process environment
  }
}

function readStdin() {
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

/** Resolve the New API model id. OPENCODE_MODEL (legacy provider/model) wins if it matches our provider. */
function resolveModel() {
  const legacy = process.env.OPENCODE_MODEL;
  if (legacy && legacy.startsWith(`${PROVIDER_ID}/`)) {
    return legacy.slice(PROVIDER_ID.length + 1);
  }
  return process.env.NEW_API_MODEL || process.env.TIANSHU_MODEL || DEFAULT_MODEL;
}

/**
 * Run opencode as a New API-backed provider via OPENCODE_CONFIG_CONTENT and
 * parse its `--format json` event stream to aggregate REAL token usage.
 * Resolves with { result, usage, errorMessage }.
 */
function runOpenCode(prompt, workDir) {
  return new Promise((resolve, reject) => {
    // TIANSHU_* 是 NEW_API_* 的别名兜底：天枢 (Tianshu) 即 New API 兼容网关
    const baseURL = (process.env.NEW_API_BASE_URL || process.env.TIANSHU_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    const apiKey = process.env.NEW_API_API_KEY || process.env.TIANSHU_API_KEY || "";
    const modelId = resolveModel();
    if (!apiKey) {
      reject(Object.assign(new Error("NEW_API_API_KEY or TIANSHU_API_KEY is required (New API / Tianshu gateway API key)"), { usage: null }));
      return;
    }
    const configContent = JSON.stringify(buildProviderConfig({ baseURL, apiKey, modelId }));

    const args = [
      "run",
      prompt,
      "--dir",
      workDir,
      "--format",
      "json",
      "--print-logs",
      "-m",
      `${PROVIDER_ID}/${modelId}`,
    ];
    if (process.env.OPENCODE_AUTO !== "false") args.push("--auto");

    const configuredTimeout = Number.parseInt(process.env.OPENCODE_TIMEOUT_MS || "900000", 10);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? configuredTimeout
      : 900000;

    const child = spawn(OPENCODE_BIN, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: configContent },
    });

    let stdout = "";
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);

    const settle = (error) => {
      const parsed = parseEventStream(stdout);
      const usage = aggregateUsage(parsed.stepFinishes);
      const errorMessage = parsed.errors
        .map((entry) => (entry && (entry.message || entry.data?.message)) || JSON.stringify(entry))
        .filter(Boolean)
        .join("\n");
      if (error) {
        reject(Object.assign(error, { usage, eventError: errorMessage }));
        return;
      }
      const text = parsed.textParts.join("\n").trim();
      resolve({ result: text || stdout.trim() || "[无输出]", usage, errorMessage });
    };

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { process.stderr.write(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(Object.assign(new Error(`Failed to spawn OpenCode: ${error.message}`), { usage: null }));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut) {
        settle(new Error(`OpenCode timed out after ${timeoutMs}ms`));
      } else if (code !== 0) {
        settle(new Error(`OpenCode exited with code ${code}`));
      } else {
        settle(null);
      }
    });
  });
}

async function reportUsage(prompt, result, usage) {
  const mcpKey = process.env.TIANGONG_MCP_KEY;
  if (process.env.TIANGONG_REPORT_USAGE !== "true" || !mcpKey) return;

  const agentId = Number.parseInt(process.env.TIANGONG_AGENT_ID || "0", 10);
  if (!agentId) return;

  const modelId = resolveModel();
  const model = `${PROVIDER_ID}/${modelId}`;

  let effectiveUsage = usage && usage.hasRealUsage ? usage : null;
  if (!effectiveUsage) {
    process.stderr.write(
      "[opencode-runner] ⚠ no real token usage in event stream; falling back to length estimate\n"
    );
    effectiveUsage = estimateUsage(prompt, result);
  }

  const taskIdRaw = Number.parseInt(process.env.TIANGONG_TASK_ID || "0", 10);
  const payload = buildUsagePayload({
    usage: effectiveUsage,
    model,
    agentId,
    taskId: Number.isFinite(taskIdRaw) ? taskIdRaw : undefined,
  });

  const httpBase = (process.env.TIANGONG_HTTP_BASE || "https://tiangg.zeabur.app").replace(/\/$/, "");

  const post = (body) =>
    fetch(`${httpBase}/api/trpc/usage.record`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcp-key": mcpKey,
      },
      body: JSON.stringify(body),
    });

  try {
    let response = await post(payload);
    // The deployed usage.record schema only accepts source in a fixed enum that
    // does not include "opencode-runner". If the report is rejected specifically
    // for the source value, retry once with the accepted "runner" value so real
    // usage still lands in Tiangong.
    if (!response.ok) {
      const rejectionBody = await response.text();
      if (isSourceRejection(response.status, rejectionBody)) {
        response = await post({ ...payload, source: "runner" });
      }
    }
    if (!response.ok) {
      let body = "";
      try { body = await response.text(); } catch { /* body already consumed */ }
      process.stderr.write(
        `[opencode-runner] usage report failed: HTTP ${response.status}: ${body.slice(0, 200)}\n`
      );
      return;
    }
    process.stderr.write(
      `[opencode-runner] 📊 usage recorded: ${effectiveUsage.totalTokens} tokens (input=${effectiveUsage.promptTokens}, output=${effectiveUsage.completionTokens}, cached=${effectiveUsage.cachedPromptTokens}), model=${model}\n`
    );
  } catch (error) {
    process.stderr.write(`[opencode-runner] usage report failed: ${error.message}\n`);
  }
}

function isSourceRejection(status, body) {
  return status === 400 && /source/i.test(body) && /invalid|enum|input/i.test(body);
}

async function main() {
  loadLocalEnv();
  const prompt = await readStdin();
  if (!prompt.trim()) throw new Error("stdin prompt is empty");

  const taskId = process.env.TIANGONG_TASK_ID || "0";
  const workRoot = process.env.OPENCODE_WORK_DIR || "/opt/tiangong-tasks";
  const workDir = join(workRoot, `task-${taskId}`);
  await mkdir(workDir, { recursive: true });

  try {
    const outcome = await runOpenCode(prompt, workDir);
    await reportUsage(prompt, outcome.result, outcome.usage);
    process.stdout.write(`${outcome.result}\n`);
  } catch (error) {
    await reportUsage(prompt, error.message, error.usage);
    process.stderr.write(`[opencode-runner] ${error.message}\n`);
    if (error.eventError) process.stderr.write(`[opencode-runner] opencode error: ${error.eventError}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[opencode-runner] ${error.message}\n`);
  process.exitCode = 1;
});
