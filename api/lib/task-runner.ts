/**
 * 天宫 P5：服务端 Task Runner
 *
 * 周期性扫描 queued 任务 → 领取 → 执行（mock / command）→ 回写结果 → 广播 task_update。
 *
 * 配置（环境变量，默认安全）：
 *   TIANGONG_TASK_RUNNER_ENABLED      默认 true
 *   TIANGONG_TASK_RUNNER_MODE         mock | command，默认 mock
 *   TIANGONG_TASK_RUNNER_INTERVAL_MS  默认 5000
 *   TIANGONG_TASK_RUNNER_BATCH_SIZE   默认 1，最大 5
 *   TIANGONG_TASK_RUNNER_COMMAND      command 模式的可信命令
 *   TIANGONG_TASK_RUNNER_TIMEOUT_MS   默认 300000
 *   TIANGONG_TASK_RUNNER_RESULT_MAX_CHARS 默认 12000
 */

import { getDb } from "../queries/connection";
import { tasks, agents } from "@db/schema";
import { eq, and, asc, desc } from "drizzle-orm";
import { wsManager } from "../ws-manager";
import { exec } from "node:child_process";

// ─── Config ───

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v !== "0" && v.toLowerCase() !== "false";
}

function envStr(name: string, def: string): string {
  return process.env[name] ?? def;
}

function envInt(name: string, def: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : def;
}

const CONFIG = {
  enabled: envBool("TIANGONG_TASK_RUNNER_ENABLED", true),
  mode: envStr("TIANGONG_TASK_RUNNER_MODE", "mock") as "mock" | "command",
  intervalMs: envInt("TIANGONG_TASK_RUNNER_INTERVAL_MS", 5000, 500),
  batchSize: envInt("TIANGONG_TASK_RUNNER_BATCH_SIZE", 1, 1, 5),
  command: envStr("TIANGONG_TASK_RUNNER_COMMAND", ""),
  timeoutMs: envInt("TIANGONG_TASK_RUNNER_TIMEOUT_MS", 300000, 1000),
  resultMaxChars: envInt("TIANGONG_TASK_RUNNER_RESULT_MAX_CHARS", 12000, 100),
};

// ─── TaskRunner ───

class TaskRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private consecutiveErrors = 0;

  get status() {
    return {
      enabled: CONFIG.enabled,
      mode: CONFIG.mode,
      intervalMs: CONFIG.intervalMs,
      batchSize: CONFIG.batchSize,
      running: this.timer !== null,
      commandConfigured: CONFIG.command.length > 0,
      consecutiveErrors: this.consecutiveErrors,
    };
  }

  /** 启动周期性扫描 */
  start(): void {
    if (!CONFIG.enabled) {
      console.log("[TaskRunner] Disabled by config, not starting.");
      return;
    }
    if (this.timer) return;

    console.log(
      `[TaskRunner] Starting (mode=${CONFIG.mode}, interval=${CONFIG.intervalMs}ms, batch=${CONFIG.batchSize})`
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

  /** 安全领取任务（防止重复领取）并执行 */
  private async claimAndExecute(task: typeof tasks.$inferSelect): Promise<void> {
    const db = getDb();
    const startedAt = new Date();

    // 安全领取：UPDATE tasks SET status='running', progress=10 WHERE id=X AND status='queued'
    // drizzle ORM 的 update 返回结果不直接给出 affected rows，这里用两步：
    // 先 select ... for update 然后 update，或直接用两个查询。
    // 为简单起见：先update再检查是否成功（检查当前status）。
    // 更好的方式：直接 update + where status=queued，然后再读。
    try {
      // 安全领取：只有 status 仍是 queued 才更新
      await db
        .update(tasks)
        .set({ status: "running", progress: 10, updatedAt: new Date() as any })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, "queued")));

      // 重新读取确认领取成功：只有成功执行本次 update 的 runner 才会看到 running + progress=10。
      // 若其他 runner 已经推进到 25/100，这里会退出，避免重复执行。
      const claimed = await db
        .select({ status: tasks.status, progress: tasks.progress })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .then((r) => r[0]);

      if (!claimed || claimed.status !== "running" || claimed.progress !== 10) {
        // 已被其他 Runner 领取
        return;
      }

      // 广播状态变更
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "updated",
        id: task.id,
        taskId: task.taskId,
        name: task.name,
        status: "running",
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

      // 4. 更新进度到 25
      await db
        .update(tasks)
        .set({ progress: 25 })
        .where(eq(tasks.id, task.id));
      wsManager.broadcastToDashboard({
        type: "task_update",
        action: "updated",
        id: task.id,
        taskId: task.taskId,
        name: task.name,
        status: "running",
        progress: 25,
        agentId: task.agentId,
        timestamp: new Date().toISOString(),
      });

      // 5. 执行任务
      const effectiveTimeout = task.timeoutMs ?? CONFIG.timeoutMs;
      let result: { output: string; error: string | null; success: boolean };

      if (CONFIG.mode === "command") {
        result = await this.executeCommand(prompt, effectiveTimeout);
      } else {
        result = await this.executeMock(task, agent, effectiveTimeout);
      }

      // 6. 回写结果
      const outputText = this.truncate(result.output, CONFIG.resultMaxChars);
      const errorText = result.error ? this.truncate(result.error, CONFIG.resultMaxChars) : null;

      if (result.success) {
        await db
          .update(tasks)
          .set({
            status: "done",
            progress: 100,
            output: outputText,
            error: errorText ?? null,
            updatedAt: new Date() as any,
          })
          .where(eq(tasks.id, task.id));

        wsManager.broadcastToDashboard({
          type: "task_update",
          action: "updated",
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          status: "done",
          progress: 100,
          agentId: task.agentId,
          timestamp: new Date().toISOString(),
        });

        console.log(
          `[TaskRunner] Task ${task.taskId} (id=${task.id}) completed in ${Date.now() - startedAt.getTime()}ms`
        );
      } else {
        await db
          .update(tasks)
          .set({
            status: "failed",
            progress: task.progress, // 保留当前进度
            output: outputText || null,
            error: errorText,
            updatedAt: new Date() as any,
          })
          .where(eq(tasks.id, task.id));

        wsManager.broadcastToDashboard({
          type: "task_update",
          action: "updated",
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          status: "failed",
          progress: task.progress,
          agentId: task.agentId,
          timestamp: new Date().toISOString(),
        });

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
            error: `Runner internal error: ${e.message}`.slice(0, CONFIG.resultMaxChars),
            updatedAt: new Date() as any,
          })
          .where(eq(tasks.id, task.id));

        wsManager.broadcastToDashboard({
          type: "task_update",
          action: "updated",
          id: task.id,
          taskId: task.taskId,
          name: task.name,
          status: "failed",
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
  ): Promise<{ output: string; error: string | null; success: boolean }> {
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
      `Generated by Tiangong P5 Task Runner at ${now}`,
    ].join("\n");

    return {
      output: structuredOutput,
      error: null,
      success: true,
    };
  }

  /** Command 模式执行 */
  private executeCommand(
    prompt: string,
    timeoutMs: number
  ): Promise<{ output: string; error: string | null; success: boolean }> {
    return new Promise((resolve) => {
      if (!CONFIG.command) {
        resolve({
          output: "",
          error: "TIANGONG_TASK_RUNNER_COMMAND not configured",
          success: false,
        });
        return;
      }

      // prompt 通过 stdin 传入，不拼进 shell command
      const child = exec(CONFIG.command, {
        timeout: timeoutMs,
        maxBuffer: CONFIG.resultMaxChars * 4,
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: string) => {
        if (stdout.length < CONFIG.resultMaxChars) {
          stdout += chunk;
        }
      });

      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < CONFIG.resultMaxChars) {
          stderr += chunk;
        }
      });

      // 写入 prompt 到 stdin
      if (child.stdin) {
        child.stdin.write(prompt);
        child.stdin.end();
      }

      child.on("close", (code) => {
        const out = this.truncate(stdout, CONFIG.resultMaxChars);
        const err = this.truncate(stderr, CONFIG.resultMaxChars);
        const success = code === 0;

        resolve({
          output: out,
          error: success ? null : (err || `Command exited with code ${code}`),
          success,
        });
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        resolve({
          output: this.truncate(stdout, CONFIG.resultMaxChars),
          error: err.message,
          success: false,
        });
      });
    });
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
