import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(REPO_ROOT, "scripts/openclaw-connector/runner-opencode.mjs");

// ─── Stubbed opencode binary ────────────────────────────────────────────────
const STUB = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.STUB_CONFIG_OUT || "/tmp/stub-config.json", process.env.OPENCODE_CONFIG_CONTENT || "");
const sid = "ses_integration";
const lines = [
  JSON.stringify({ type: "step_start", timestamp: 1, sessionID: sid, part: { id: "prt_s", messageID: "msg_1", sessionID: sid, type: "step-start" } }),
  JSON.stringify({ type: "text", timestamp: 2, sessionID: sid, part: { id: "prt_t", messageID: "msg_1", sessionID: sid, type: "text", text: "Integration result", time: { start: 1, end: 2 } } }),
  JSON.stringify({ type: "step_finish", timestamp: 3, sessionID: sid, part: { id: "prt_f", messageID: "msg_1", sessionID: sid, type: "step-finish", reason: "stop", tokens: { total: 1000, input: 600, output: 250, reasoning: 30, cache: { read: 100, write: 20 } }, cost: 0 } }),
  JSON.stringify({ type: "error", timestamp: 4, sessionID: sid, error: { name: "Error", message: "stub failure" } }),
];
process.stdout.write(lines.join("\\n") + "\\n");
process.exit(process.env.STUB_EXIT_CODE ? Number(process.env.STUB_EXIT_CODE) : 0);
`;

let tmpDir: string;
let stubBin: string;
let configOut: string;
let workDir: string;
let server: Server;
let port: number;
let captured: Array<{ body: unknown; headers: Record<string, string | string[] | undefined> }> = [];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "runner-opencode-it-"));
  stubBin = join(tmpDir, "stub-opencode.mjs");
  writeFileSync(stubBin, STUB, { mode: 0o755 });
  configOut = join(tmpDir, "config-content.json");
  workDir = join(tmpDir, "work");
  mkdirSync(workDir, { recursive: true });

  captured = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push({
        body: JSON.parse(body || "{}"),
        headers: req.headers,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: { id: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server port");
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  rmSync(tmpDir, { recursive: true, force: true });
});

function runRunner(prompt: string, extraEnv: Record<string, string>) {
  const env = {
    ...process.env,
    OPENCODE_BIN: stubBin,
    OPENCODE_WORK_DIR: workDir,
    OPENCODE_TIMEOUT_MS: "30000",
    TIANGONG_REPORT_USAGE: "true",
    TIANGONG_MCP_KEY: "tg-test-key",
    TIANGONG_AGENT_ID: "16",
    TIANGONG_TASK_ID: "42",
    TIANGONG_HTTP_BASE: `http://127.0.0.1:${port}`,
    NEW_API_BASE_URL: "https://woppis1.zeabur.app",
    NEW_API_API_KEY: "sk-test",
    NEW_API_MODEL: "deepseek-v4-flash",
    STUB_CONFIG_OUT: configOut,
    ...extraEnv,
  };
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

describe("runner-opencode integration (stubbed opencode)", () => {
  it("reports REAL aggregated token usage to usage.record with source opencode-runner", async () => {
    const { code, stdout } = await runRunner("do the thing", {});

    expect(code).toBe(0);
    expect(stdout.trim()).toBe("Integration result");

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const usage = captured[0].body as Record<string, unknown>;

    expect(usage.model).toBe("newapi/deepseek-v4-flash");
    expect(usage.provider).toBe("opencode");
    expect(usage.source).toBe("opencode-runner");
    expect(usage.agentId).toBe(16);
    expect(usage.taskId).toBe(42);
    expect(usage.callCount).toBe(1);
    // Real tokens from the stub step_finish, NOT a length estimate.
    expect(usage.promptTokens).toBe(600);
    expect(usage.completionTokens).toBe(250);
    expect(usage.cachedPromptTokens).toBe(100);
    expect(usage.uncachedPromptTokens).toBe(500);
    expect(usage.totalTokens).toBe(1000);

    // The provider definition must have been passed to the spawned opencode.
    const config = JSON.parse(require("node:fs").readFileSync(configOut, "utf8")) as {
      model: string;
      provider: Record<string, { options: { baseURL: string; apiKey: string }; npm: string }>;
    };
    expect(config.model).toBe("newapi/deepseek-v4-flash");
    expect(config.provider.newapi.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.provider.newapi.options.baseURL).toBe("https://woppis1.zeabur.app/v1");
    expect(config.provider.newapi.options.apiKey).toBe("sk-test");
  });

  it("still reports real usage and exits non-zero when opencode fails after a model step", async () => {
    captured = [];
    const { code } = await runRunner("failing prompt", { STUB_EXIT_CODE: "1" });

    expect(code).toBe(1);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const usage = captured[0].body as Record<string, unknown>;
    // The stub emitted a step_finish before exiting 1 → real usage still lands.
    expect(usage.promptTokens).toBe(600);
    expect(usage.completionTokens).toBe(250);
    expect(usage.source).toBe("opencode-runner");
  });

  it("reports usage even when the event stream has no step_finish (estimate fallback)", async () => {
    captured = [];
    const minimalStub = join(tmpDir, "stub-no-tokens.mjs");
    writeFileSync(
      minimalStub,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:"text",sessionID:"s",part:{id:"t",type:"text",text:"no tokens"}})+"\\n");\n`,
      { mode: 0o755 }
    );
    const { code } = await runRunner("whatever", { OPENCODE_BIN: minimalStub });

    expect(code).toBe(0);
    expect(captured.length).toBeGreaterThanOrEqual(1);
    const usage = captured[0].body as Record<string, unknown>;
    expect(usage.source).toBe("opencode-runner");
    // Fallback: real usage unavailable → estimate (prompt/completion > 0, cache 0).
    expect(usage.cachedPromptTokens).toBe(0);
    expect(Number(usage.promptTokens)).toBeGreaterThan(0);
    expect(Number(usage.completionTokens)).toBeGreaterThan(0);
  });

  it("falls back to source=runner when usage.record rejects source=opencode-runner", async () => {
    // A second server that mimics the deployed Tiangong schema: 400 on
    // "opencode-runner", 200 on the accepted "runner" enum value.
    const capturedStrict: Array<{ body: unknown }> = [];
    const strict = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as { source?: string };
        capturedStrict.push({ body: parsed });
        if (parsed.source === "opencode-runner") {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                code: -32600,
                message:
                  '[{"code":"invalid_value","values":["manual","cron","connector","runner","system","subagent"],"path":["source"],"message":"Invalid option: expected one of \\"manual\\"|\\"cron\\"|\\"connector\\"|\\"runner\\"|\\"system\\"|\\"subagent\\""}]',
                data: { code: -32600, httpStatus: 400, path: "usage.record" },
              },
            })
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ result: { id: 1 } }));
      });
    });
    await new Promise<void>((resolve) => strict.listen(0, "127.0.0.1", () => resolve()));
    const strictPort = (strict.address() as { port: number }).port;

    const { code } = await runRunner("retry me", { TIANGONG_HTTP_BASE: `http://127.0.0.1:${strictPort}` });

    expect(code).toBe(0);
    expect(capturedStrict).toHaveLength(2);
    expect(capturedStrict[0].body).toMatchObject({ source: "opencode-runner" });
    expect(capturedStrict[1].body).toMatchObject({ source: "runner" });
    expect((capturedStrict[1].body as Record<string, unknown>).promptTokens).toBe(600);

    await new Promise<void>((resolve, reject) => strict.close((e) => (e ? reject(e) : resolve())));
  });
});
