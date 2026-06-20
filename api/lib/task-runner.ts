/**
 * 天宫 P6：服务端 Task Runner（安全 argv 执行 + OpenClaw runner 集成）
 *
 * 周期性扫描 queued 任务 → 领取 → 执行（mock / command）→ 回写结果 → 广播 task_update。
 *
 * 配置（环境变量，默认安全）：
 *   TIANGONG_TASK_RUNNER_ENABLED          默认 true
 *   TIANGONG_TASK_RUNNER_MODE             mock | command | gateway，默认 mock
 *   TIANGONG_TASK_RUNNER_INTERVAL_MS      默认 5000
 *   TIANGONG_TASK_RUNNER_BATCH_SIZE       默认 1，最大 5
 *   TIANGONG_TASK_RUNNER_EXEC_FILE        command 模式执行文件（推荐 argv 模式）
 *   TIANGONG_TASK_RUNNER_EXEC_ARGS_JSON   command 模式执行参数 JSON 数组
 *   TIANGONG_TASK_RUNNER_COMMAND          legacy command 字符串（fallback）
 *   TIANGONG_TASK_RUNNER_TIMEOUT_MS       默认 300000
 *   TIANGONG_TASK_RUNNER_RESULT_MAX_CHARS 默认 12000
 *
 * P7 Gateway 模式（远程 OpenClaw Gateway HTTP，不要求生产容器安装 openclaw CLI）：
 *   TIANGONG_OPENCLAW_GATEWAY_URL          OpenClaw Gateway URL，如 https://gw.example.com
 *   TIANGONG_OPENCLAW_GATEWAY_TOKEN        Gateway bearer token/password（status/log 不泄露）
 *   TIANGONG_OPENCLAW_GATEWAY_AGENT        目标 Agent，默认 codemaster
 *   TIANGONG_OPENCLAW_GATEWAY_MODEL        可选 backend model override
 *   TIANGONG_OPENCLAW_GATEWAY_SESSION_PREFIX  默认 tiangong
 */

import { getDb } from "../queries/connection";
import { tasks, agents, taskMessages, taskArtifacts } from "@db/schema";
import { eq, and, asc, desc } from "drizzle-orm";
import { wsManager } from "../ws-manager";
import { emitCollabSummaryForTask } from "./collaboration-events";
import { spawn } from "node:child_process";

// ─── Config ───

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v !== "0" && v.toLowerCase() !== "false";
}

function envStr(name: string, def: string): string {
  return (process.env[name] ?? def).trim();
}

function envInt(name: string, def: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
}

function envJsonArray(name: string): { value: string[] | null; configured: boolean; valid: boolean } {
  const raw = process.env[name];
  if (!raw) return { value: null, configured: false, valid: false };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return { value: parsed as string[], configured: true, valid: true };
    }
    return { value: null, configured: true, valid: false };
  } catch {
    return { value: null, configured: true, valid: false };
  }
}

const execArgsConfig = envJsonArray("TIANGONG_TASK_RUNNER_EXEC_ARGS_JSON");

const CONFIG = {
  enabled: envBool("TIANGONG_TASK_RUNNER_ENABLED", true),
  mode: envStr("TIANGONG_TASK_RUNNER_MODE", "mock") as "mock" | "command" | "gateway" | "none",
  intervalMs: envInt("TIANGONG_TASK_RUNNER_INTERVAL_MS", 5000, 500),
  batchSize: envInt("TIANGONG_TASK_RUNNER_BATCH_SIZE", 1, 1, 5),
  // P6: argv-mode (recommended)
  execFile: envStr("TIANGONG_TASK_RUNNER_EXEC_FILE", ""),
  execArgs: execArgsConfig.value,
  execArgsConfigured: execArgsConfig.configured,
  execArgsValid: execArgsConfig.valid,
  // P5 legacy fallback
  command: envStr("TIANGONG_TASK_RUNNER_COMMAND", ""),
  timeoutMs: envInt("TIANGONG_TASK_RUNNER_TIMEOUT_MS", 300000, 1000),
  resultMaxChars: envInt("TIANGONG_TASK_RUNNER_RESULT_MAX_CHARS", 12000, 100),
  // P7: remote OpenClaw Gateway mode
  gatewayUrl: envStr("TIANGONG_OPENCLAW_GATEWAY_URL", ""),
  gatewayToken: envStr("TIANGONG_OPENCLAW_GATEWAY_TOKEN", ""),
  gatewayAgent: envStr("TIANGONG_OPENCLAW_GATEWAY_AGENT", "codemaster"),
  gatewayModel: envStr("TIANGONG_OPENCLAW_GATEWAY_MODEL", ""),
  gatewaySessionPrefix: envStr("TIANGONG_OPENCLAW_GATEWAY_SESSION_PREFIX", "tiangong"),
};

// ─── Helpers ───

function hasValidArgvCommand(): boolean {
  return CONFIG.execFile.length > 0 && CONFIG.execArgs !== null && CONFIG.execArgsValid;
}

/** Compute execMode from resolved config */
function computeExecMode(): "argv" | "legacy" | "none" {
  if (CONFIG.mode !== "command") return "none";
  if (hasValidArgvCommand()) return "argv";
  if (CONFIG.command) return "legacy";
  return "none";
}

/** Whether any command config is present (for status reporting) */
function isCommandConfigured(): boolean {
  return hasValidArgvCommand() || CONFIG.command.length > 0;
}

function isGatewayConfigured(): boolean {
  return CONFIG.gatewayUrl.length > 0 && CONFIG.gatewayAgent.length > 0;
}

function safeGatewayHost(): string | null {
  if (!CONFIG.gatewayUrl) return null;
  try {
    const u = new URL(CONFIG.gatewayUrl);
    return u.host;
  } catch {
    return "invalid-url";
  }
}

function safeSessionPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 96);
}

// ─── TaskRunner ───

class TaskRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private consecutiveErrors = 0;

  get status() {
    const execMode = computeExecMode();
    return {
      enabled: CONFIG.enabled,
      mode: CONFIG.mode,
      intervalMs: CONFIG.intervalMs,
      batchSize: CONFIG.batchSize,
      running: this.timer !== null,
      // P5: legacy field — kept for backwards compat
      commandConfigured: isCommandConfigured(),
      // P6: new fields
      execMode,
      execFileConfigured: CONFIG.execFile.length > 0,
      execArgsConfigured: CONFIG.execArgsConfigured,
      execArgsValid: CONFIG.execArgsValid,
      execArgsCount: CONFIG.execArgs?.length ?? 0,
      legacyCommandConfigured: CONFIG.command.length > 0,
      // P7: remote Gateway diagnostics (safe; no token/full URL)
      gatewayConfigured: isGatewayConfigured(),
      gatewayUrlConfigured: CONFIG.gatewayUrl.length > 0,
      gatewayUrlHost: safeGatewayHost(),
      gatewayTokenConfigured: CONFIG.gatewayToken.length > 0,
      gatewayAgent: CONFIG.gatewayAgent || null,
      gatewayModelConfigured: CONFIG.gatewayModel.length > 0,
      gatewaySessionPrefixConfigured: CONFIG.gatewaySessionPrefix.length > 0,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  /** 启动周期性扫描 */
  start(): void {
    if (!CONFIG.enabled) {
      console.log("[TaskRunner] Disabled by config, not starting.");
      return;
    }
    if (CONFIG.mode === "none") {
      console.log("[TaskRunner] Mode is 'none', not starting periodic scan.");
      return;
    }
    if (this.timer) return;

    console.log(
      `[TaskRunner] Starting (mode=${CONFIG.mode}, execMode=${computeExecMode()}, interval=${CONFIG.intervalMs}ms, batch=${CONFIG.batchSize})`
    );
    this.timer = setInterval(() => this.tick(), CONFIG.intervalMs);
    // 立即执行一次
    setImmediate(() => this.tick());
  }

  /** 停止 Runner */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[TaskRunner] Stopped.");
    }
  }

  /** 每隔 intervalMs 执行一次扫描 */
  private async tick(): Promise<void> {
    if (CONFIG.mode === "none") return;
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      const db = getDb();
      // 1. 扫描 queued 任务（按优先级降序，时间升序）
      const queued = await db
        .select()
        .from(tasks)
        .where(eq(tasks.status, "queued"))
        .orderBy(desc(tasks.priority), asc(tasks.createdAt))
        .limit(CONFIG.batchSize);

      for (const task of queued) {
        await this.claimAndExecute(task);
      }
      this.consecutiveErrors = 0;
    } catch (e: any) {
      this.consecutiveErrors++;
      console.error(`[TaskRunner] Tick error (${this.consecutiveErrors}):`, e.message);
    } finally {
      this.tickRunning = false;
    }
  }

  /** A2A-lite v0.1: record task event directly via DB */
  private async recordEvent(taskId: number, eventType: string, content?: string, metadata?: Record<string, unknown>, agentId?: number) {
    const db = getDb();
    await db.insert(taskMessages).values({
      taskId,
      fromAgentId: agentId ?? null,
      eventType: eventType as any,
      content: content ?? null,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
  }

  /** A2A-lite v0.1: record artifact directly via DB */
  private async recordArtifact(taskId: number, type: string, content: string, agentId?: number) {
    const db = getDb();
    await db.insert(taskArtifacts).values({
      taskId,
      agentId: agentId ?? null,
      type,
      name: `${type}-${taskId}`,
      content,
    });
  }

  /** 安全领取任务（防止重复领取）并执行 */
  private async claimAndExecute(task: typeof tasks.$inferSelect): Promise<void> {
    const db = getDb();
    const startedAt = new Date();

    try {
      // 安全领取：只有 status 仍是 queued 才更新
      await db
        .update(tasks)
        .set({ status: "running", lifecycleStatus: "claimed", progress: 10, claimedAt: new Date(), updatedAt: new Date() as any })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, "queued")));

      // 重新读取确认领取成功
      const claimed = await db
        .select({ status: tasks.status, progress: tasks.progress, lifecycleStatus: tasks.lifecycleStatus })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .then((r) => r[0]);

      if (!claimed || claimed.status !== "running" || claimed.progress !== 10) {
        // 已被其他 Runner 领取
        return;
      }

      await this.recordEvent(task.id, "system", `TaskRunner claimed task ${task.taskId}`, undefined, task.agentId ?? undefined);

      // 广播状态变更
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "updated",
        id: task.id,
        taskId: task.taskId,
        name: task.name,
        status: "running",
        lifecycleStatus: "claimed",
        progress: 10,
        agentId: task.agentId,
        timestamp: startedAt.toISOString(),
      });

      // 2. 查找 Agent（如果有 agentId）
      let agent: typeof agents.$inferSelect | null = null;
      if (task.agentId) {
        agent =
          (await db
            .select()
            .from(agents)
            .where(eq(agents.id, task.agentId))
            .then((r) => r[0])) ?? null;
      }

      // 3. 构造执行 prompt
      const prompt = this.buildPrompt(task, agent);

      // 4. 更新进度到 25，标记 working
      await db
        .update(tasks)
        .set({ progress: 25, lifecycleStatus: "working" })
        .where(eq(tasks.id, task.id));
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "updated",
        id: task.id,
        taskId: task.taskId,
        name: task.name,
        status: "running",
        lifecycleStatus: "working",
        progress: 25,
        agentId: task.agentId,
        timestamp: new Date().toISOString(),
      });

      // 5. 执行任务
      const effectiveTimeout = task.timeoutMs ?? CONFIG.timeoutMs;
      let result: { output: string; error: string | null; success: boolean; awaitingResult?: boolean };

      if (CONFIG.mode === "command") {
        result = await this.executeCommand(prompt, effectiveTimeout);
      } else if (CONFIG.mode === "gateway") {
        result = await this.executeGateway(prompt, task, effectiveTimeout);
      } else {
        result = await this.executeMock(task, agent, effectiveTimeout);
      }

      // 6. 回写结果（A2A-lite 语义）
      const outputText = this.truncate(result.output, CONFIG.resultMaxChars);
      const errorText = result.error ? this.truncate(result.error, CONFIG.resultMaxChars) : null;

      if (result.awaitingResult) {
        // A2A-lite: gateway 只返回 started，进入 awaiting_result
        await db
          .update(tasks)
          .set({
            lifecycleStatus: "awaiting_result",
            output: outputText || null,
            updatedAt: new Date() as any,
          })
          .where(eq(tasks.id, task.id));

        await this.recordEvent(task.id, "system", "Gateway returned 'started' only. Task is awaiting final result.", { mode: CONFIG.mode }, task.agentId ?? undefined);

        wsManager.broadcastToDashboard({
          type: "task_update",
          action: "updated",
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          status: "running",
          lifecycleStatus: "awaiting_result",
          progress: task.progress,
          agentId: task.agentId,
          timestamp: new Date().toISOString(),
        });

        console.log(
          `[TaskRunner] Task ${task.taskId} (id=${task.id}) awaiting final result (gateway returned started only)`
        );
      } else if (result.success) {
        // A2A-lite: submit result first; completion happens only after explicit review/auto-review
        await db
          .update(tasks)
          .set({
            status: "running",
            lifecycleStatus: "submitted",
            progress: 95,
            output: outputText,
            error: errorText ?? null,
            updatedAt: new Date() as any,
          })
          .where(eq(tasks.id, task.id));

        await this.recordEvent(task.id, "result", outputText, { artifactType: "task_result", lifecycleStatus: "submitted" }, task.agentId ?? undefined);
        await this.recordArtifact(task.id, "task_result", outputText, task.agentId ?? undefined);

        // Auto-review: since this is an automated runner, complete the task immediately after submitted is recorded
        await db
          .update(tasks)
          .set({
            status: "done",
            lifecycleStatus: "completed",
            progress: 100,
            completedAt: new Date(),
            updatedAt: new Date() as any,
          })
          .where(eq(tasks.id, task.id));

        await this.recordEvent(task.id, "system", "Task auto-reviewed and completed by runner", { previousStatus: "submitted", lifecycleStatus: "completed" }, task.agentId ?? undefined);

        wsManager.broadcastToDashboard({
          type: "task_update",
          action: "updated",
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          status: "done",
          lifecycleStatus: "completed",
          progress: 100,
          agentId: task.agentId,
          timestamp: new Date().toISOString(),
        });

        await emitCollabSummaryForTask(task.id);

        console.log(
          `[TaskRunner] Task ${task.taskId} (id=${task.id}) completed in ${Date.now() - startedAt.getTime()}ms`
        );
      } else {
        await db
          .update(tasks)
          .set({
            status: "failed",
            lifecycleStatus: "failed",
            progress: task.progress,
            output: outputText || null,
            error: errorText,
            failedAt: new Date(),
            updatedAt: new Date() as any,
          })
          .where(eq(tasks.id, task.id));

        await this.recordEvent(task.id, "error", errorText || "Task execution failed", undefined, task.agentId ?? undefined);

        wsManager.broadcastToDashboard({
          type: "task_update",
          action: "updated",
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          status: "failed",
          lifecycleStatus: "failed",
          progress: task.progress,
          agentId: task.agentId,
          timestamp: new Date().toISOString(),
        });

        await emitCollabSummaryForTask(task.id);

        console.error(
          `[TaskRunner] Task ${task.taskId} (id=${task.id}) failed: ${errorText?.slice(0, 200)}`
        );
      }
    } catch (e: any) {
      console.error(`[TaskRunner] Fatal error executing task ${task.taskId}:`, e.message);
      // 尝试回写失败状态
      try {
        await db
          .update(tasks)
          .set({
            status: "failed",
            lifecycleStatus: "failed",
            error: `Runner internal error: ${e.message}`.slice(0, CONFIG.resultMaxChars),
            failedAt: new Date(),
            updatedAt: new Date() as any,
          })
          .where(eq(tasks.id, task.id));

        await this.recordEvent(task.id, "error", `Runner internal error: ${e.message}`, undefined, task.agentId ?? undefined);

        wsManager.broadcastToDashboard({
          type: "task_update",
          action: "updated",
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          status: "failed",
          lifecycleStatus: "failed",
          agentId: task.agentId,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // 回写失败也忽略，避免 Runner 崩溃
      }
    }
  }

  /** 构造执行 prompt */
  private buildPrompt(
    task: typeof tasks.$inferSelect,
    agent: typeof agents.$inferSelect | null
  ): string {
    const parts: string[] = [];
    parts.push(`[TASK] ${task.taskId}: ${task.name}`);
    if (task.description) parts.push(`[DESCRIPTION] ${task.description}`);
    if (task.input) parts.push(`[INPUT] ${task.input}`);
    if (agent) {
      parts.push(`[AGENT] ${agent.name} (${agent.agentId})`);
      if (agent.role) parts.push(`[ROLE] ${agent.role}`);
    }
    parts.push(`[PRIORITY] P${task.priority ?? 0}`);
    parts.push(`[RETRY] ${task.retryCount ?? 0}/${task.maxRetries ?? 3}`);
    return parts.join("\n");
  }

  /** Mock 模式执行 */
  private async executeMock(
    task: typeof tasks.$inferSelect,
    agent: typeof agents.$inferSelect | null,
    _timeoutMs: number
  ): Promise<{ output: string; error: string | null; success: boolean; awaitingResult?: boolean }> {
    // 模拟执行耗时
    const simMs = 500;
    await new Promise((r) => setTimeout(r, simMs));

    const now = new Date().toISOString();
    const agentName = agent?.name ?? "system-runner";
    const agentId = agent?.agentId ?? "GENERIC";

    const structuredOutput = [
      `[EXECUTION REPORT]`,
      `task_id: ${task.taskId}`,
      `task_name: ${task.name}`,
      `executor: ${agentName} (${agentId})`,
      `mode: mock`,
      `started_at: ${new Date(Date.now() - simMs).toISOString()}`,
      `finished_at: ${now}`,
      `duration_ms: ${simMs}`,
      `status: SUCCESS`,
      ``,
      `[SUMMARY]`,
      `Mock execution completed successfully for task "${task.name}".`,
      ``,
      `[DETAILS]`,
      `This is a mock execution. The task was processed by the Tiangong Task Runner.`,
      `Agent: ${agentName}, Priority: P${task.priority ?? 0}`,
      task.input
        ? `Input preview: ${task.input.slice(0, 200)}${task.input.length > 200 ? "..." : ""}`
        : `No input provided.`,
      ``,
      `[TASK RUNNER INFO]`,
      `runner_mode: ${CONFIG.mode}`,
      `runner_interval_ms: ${CONFIG.intervalMs}`,
      `runner_batch_size: ${CONFIG.batchSize}`,
      ``,
      `Generated by Tiangong P6 Task Runner at ${now}`,
    ].join("\n");

    return {
      output: structuredOutput,
      error: null,
      success: true,
    };
  }

  /**
   * P6: Command 模式 — 安全 argv 执行
   *
   * 优先使用 execFile + execArgs（spawn(file, args, {shell:false})），
   * prompt 通过 stdin 传入。保留 legacy COMMAND 为 fallback。
   *
   * Timeout: SIGTERM → 5s grace → SIGKILL
   */
  private executeCommand(
    prompt: string,
    timeoutMs: number
  ): Promise<{ output: string; error: string | null; success: boolean; awaitingResult?: boolean }> {
    return new Promise((resolve) => {
      let child;
      let diagExecMode: string;

      // P6: argv mode (recommended)
      if (hasValidArgvCommand()) {
        diagExecMode = "argv";
        const execArgs = CONFIG.execArgs ?? [];
        child = spawn(CONFIG.execFile, execArgs, {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        // Log safe diagnostic (no full args)
        console.log(
          `[TaskRunner] command mode (argv): execFile=${CONFIG.execFile}, argsCount=${execArgs.length}, timeout=${timeoutMs}ms`
        );
      } else if (CONFIG.command) {
        // P5 legacy fallback: shell command
        diagExecMode = "legacy";
        child = spawn(CONFIG.command, [], {
          shell: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        console.log(
          `[TaskRunner] command mode (legacy shell): timeout=${timeoutMs}ms`
        );
      } else {
        resolve({
          output: "",
          error: "TIANGONG_TASK_RUNNER_EXEC_FILE/EXEC_ARGS_JSON or COMMAND not configured",
          success: false,
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | null = null;

      const done = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);

        const out = this.truncate(stdout, CONFIG.resultMaxChars);
        const err = this.truncate(stderr, CONFIG.resultMaxChars);

        if (timedOut) {
          resolve({
            output: out || "",
            error: `Command timed out after ${timeoutMs}ms`,
            success: false,
          });
          return;
        }

        if (code === 2) {
          resolve({
            output: out,
            error: err || "Command is awaiting final result",
            success: false,
            awaitingResult: true,
          });
          return;
        }

        const success = code === 0;
        resolve({
          output: out,
          error: success ? null : (err || `Command exited with code ${code}${signal ? ` (signal=${signal})` : ""}`),
          success,
        });
      };

      // Timeout: SIGTERM → 5s grace → SIGKILL
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }, 5000);
      }, timeoutMs);

      // Collect stdout/stderr with truncation
      const maxBuffer = CONFIG.resultMaxChars * 2;

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxBuffer) {
          stdout += chunk.toString();
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxBuffer) {
          stderr += chunk.toString();
        }
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        done(code, signal);
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve({
            output: this.truncate(stdout, CONFIG.resultMaxChars),
            error: `spawn error: ${err.message}`,
            success: false,
          });
        }
      });

      // Write prompt to stdin, then close
      if (child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }
    });
  }


  /**
   * P7: Gateway 模式 — 通过远程 OpenClaw Gateway HTTP agent endpoint 执行。
   *
   * 使用 /v1/chat/completions（需 OpenClaw Gateway 开启 chatCompletions endpoint），
   * 目标 agent 通过 model=openclaw/<agent> 与 x-openclaw-agent-id 指定。
   * 不要求 Tiangong 生产容器安装 openclaw CLI。
   */
  private async executeGateway(
    prompt: string,
    task: typeof tasks.$inferSelect,
    timeoutMs: number
  ): Promise<{ output: string; error: string | null; success: boolean }> {
    if (!isGatewayConfigured()) {
      return {
        output: "",
        error: "Gateway runner not configured: set TIANGONG_OPENCLAW_GATEWAY_URL and TIANGONG_OPENCLAW_GATEWAY_AGENT",
        success: false,
      };
    }

    let endpoint: URL;
    try {
      endpoint = new URL("/v1/chat/completions", CONFIG.gatewayUrl);
    } catch {
      return { output: "", error: "Invalid TIANGONG_OPENCLAW_GATEWAY_URL", success: false };
    }

    const sessionKey = `${CONFIG.gatewaySessionPrefix}-${safeSessionPart(CONFIG.gatewayAgent)}-${safeSessionPart(task.taskId)}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-openclaw-agent-id": CONFIG.gatewayAgent,
      "x-openclaw-session-key": sessionKey,
      "x-openclaw-message-channel": "tiangong-task-runner",
    };
    if (CONFIG.gatewayToken) headers.authorization = `Bearer ${CONFIG.gatewayToken}`;
    if (CONFIG.gatewayModel) headers["x-openclaw-model"] = CONFIG.gatewayModel;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    console.log(
      `[TaskRunner] gateway mode: host=${safeGatewayHost()}, agent=${CONFIG.gatewayAgent}, modelConfigured=${CONFIG.gatewayModel.length > 0}, timeout=${timeoutMs}ms`
    );

    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: `openclaw/${CONFIG.gatewayAgent}`,
          messages: [{ role: "user", content: prompt }],
          user: sessionKey,
          stream: false,
        }),
        signal: controller.signal,
      });

      const raw = await resp.text();
      if (!resp.ok) {
        return {
          output: "",
          error: `Gateway HTTP ${resp.status}: ${this.summarizeGatewayError(raw)}`,
          success: false,
        };
      }

      const text = this.extractChatCompletionText(raw);
      if (!text.trim()) {
        return {
          output: "",
          error: "Gateway returned empty chat completion text",
          success: false,
        };
      }

      return { output: text, error: null, success: true };
    } catch (e: any) {
      if (e?.name === "AbortError") {
        return { output: "", error: `Gateway request timed out after ${timeoutMs}ms`, success: false };
      }
      return { output: "", error: `Gateway request failed: ${e?.message ?? String(e)}`, success: false };
    } finally {
      clearTimeout(timer);
    }
  }

  private extractChatCompletionText(raw: string): string {
    try {
      const parsed = JSON.parse(raw);
      const choices = parsed?.choices;
      if (Array.isArray(choices)) {
        const texts = choices
          .map((c) => c?.message?.content ?? c?.delta?.content ?? "")
          .filter((t) => typeof t === "string" && t.trim());
        if (texts.length > 0) return texts.join("\n");
      }
      if (typeof parsed?.text === "string") return parsed.text;
      if (typeof parsed?.reply === "string") return parsed.reply;
      if (Array.isArray(parsed?.payloads)) {
        const texts = parsed.payloads
          .map((p: any) => p?.text)
          .filter((t: any) => typeof t === "string" && t.trim());
        if (texts.length > 0) return texts.join("\n");
      }
    } catch {
      return raw.trim();
    }
    return "";
  }

  private summarizeGatewayError(raw: string): string {
    if (!raw) return "(empty response)";
    try {
      const parsed = JSON.parse(raw);
      const message = parsed?.error?.message ?? parsed?.message ?? parsed?.error;
      if (typeof message === "string") return this.truncate(message, 500);
    } catch {
      // fall through
    }
    return this.truncate(raw.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer ***"), 500);
  }

  /** 截断文本 */
  private truncate(text: string, maxChars: number): string {
    if (!text) return "";
    if (text.length <= maxChars) return text;
    const truncated = text.slice(0, maxChars);
    const suffix = `\n\n[... truncated at ${maxChars} chars, original length ${text.length}]`;
    return truncated + suffix;
  }
}

// ─── 单例 & 导出 ───

export const taskRunner = new TaskRunner();
