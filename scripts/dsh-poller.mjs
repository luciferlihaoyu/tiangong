#!/usr/bin/env node
/**
 * dsh ↔ 天宫 轮询认领器（dsh-poller）
 *
 * 让部署在外部的 DeepSeek Harness (dsh) 实例自动认领并执行天宫任务：
 *   心跳（顺带自动认领 queued 任务）→ dsh 执行 → 结果回写天宫 → 天宫侧自动
 *   记账/传 AList/写璇玑记忆（完成路径统一走 finalizeCompletedTask）。
 *
 * 用法（在 dsh 所在机器/容器运行，Node ≥ 20，无第三方依赖）：
 *   TIANGONG_BASE_URL=https://tiangg.zeabur.app \
 *   TIANGONG_MCP_KEY=<dsh 助手的 MCP Key> \
 *   TIANGONG_AGENT_ID=17 \
 *   DSH_CMD='dsh -p "$(cat {file})"' \
 *   node dsh-poller.mjs
 *
 * 环境变量：
 *   TIANGONG_BASE_URL   天宫地址（必填）
 *   TIANGONG_MCP_KEY    天宫里 dsh 助手的 MCP Key（必填；认领/心跳/回写都靠它鉴权）
 *   TIANGONG_AGENT_ID   dsh 助手在天宫的数字 id（必填，如 17）
 *   DSH_CMD             执行命令模板，{file} 会被替换为任务提示词文件路径（必填，否则只心跳不认领）。
 *                       按你部署的 dsh 版本调整，例如：
 *                         dsh -p "$(cat {file})"
 *                         npx -y @deepseek-ai/dsh -p "$(cat {file})"
 *                       模型端点建议在 dsh 侧配置为天枢的 OpenAI 兼容地址，用量继续走天枢记账。
 *   DSH_MODEL           dsh 实际使用的模型名（可选）。设置后，若 dsh 标准输出的最后一行是
 *                       可解析 JSON 且含 prompt_tokens/completion_tokens（OpenAI 风格 usage），
 *                       会提取为 usage 随任务回写上报天宫记账（尽力而为，解析不到就跳过）。
 *   POLL_INTERVAL_MS    轮询间隔，默认 5000
 *   DSH_TIMEOUT_MS      单次执行超时，默认 600000
 *
 * 结果回写（usage / artifacts）：
 *   - 长 output（>10K 字符）：inline 只保留前 10K + 截断说明，全文拆分为
 *     full-output(-part-N).md 产物随 updateProgress 的 artifacts 通道提交（单条 ≤50K
 *     字符、最多 5 条，与服务端 zod 上限一致）。产物写入天宫 task_artifacts 表后，
 *     由天宫侧 alist-sync 的完成钩子自动归档上网盘（tasks/{taskId}/artifacts/...），
 *     璇玑记忆同步同理——本脚本无需关心上传细节。
 *   - usage：见 DSH_MODEL 说明；天宫侧按 model-pricing 折算成本写 token_usage 并
 *     递增 agent 预算消耗（spentCents），预算耗尽后天宫将不再向本 agent 派发新任务。
 *   注意：由本脚本认领的任务完成时需通过天宫的完成闸门（高风险任务除外）。
 *
 * MCP 协作模式（任务 2.1/2.2，轮询的进阶替代）：
 *   本脚本走的是"心跳顺带认领"的轮询模式；除此之外，也可以把天宫直接配置为
 *   dsh 的 MCP server（同一把 TIANGONG_MCP_KEY），让 dsh 在执行循环内主动回调：
 *     - claim_task        主动认领下一个可执行任务（不必等下一轮心跳）
 *     - report_progress   回写进度/结果（usage 记账 + artifacts 长产物 + 完成归档）
 *     - submit_artifact   执行中途先交中间产物（完成时随 AList 归档一并带走）
 *     - read_alist        读天宫 AList 网盘（仅限配置 basePath 内，防路径穿越）
 *     - search_xuanji     检索璇玑长期记忆（执行前反查同类任务经验/失败教训）
 *   执行循环内即取即用（认领 → 检索经验 → 执行 → 回写），替代纯轮询的被动等待；
 *   轮询模式仍保留兼容，两者可并用（本脚本不依赖 MCP 工具面）。
 */

const BASE = (process.env.TIANGONG_BASE_URL || "").replace(/\/+$/, "");
const MCP_KEY = process.env.TIANGONG_MCP_KEY || "";
const AGENT_ID = Number(process.env.TIANGONG_AGENT_ID || "0");
const DSH_CMD = process.env.DSH_CMD || "";
const POLL_INTERVAL_MS = Math.max(1000, Number(process.env.POLL_INTERVAL_MS || "5000"));
const DSH_TIMEOUT_MS = Math.max(10_000, Number(process.env.DSH_TIMEOUT_MS || "600000"));

import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!BASE || !MCP_KEY || !AGENT_ID) {
  console.error("[dsh-poller] 缺少必填环境变量：TIANGONG_BASE_URL / TIANGONG_MCP_KEY / TIANGONG_AGENT_ID");
  process.exit(1);
}
if (!DSH_CMD) {
  console.warn("[dsh-poller] 未设置 DSH_CMD：只发送心跳，不认领任务。设置后才会执行认领到的任务。");
}

async function trpc(proc, body) {
  const res = await fetch(`${BASE}/api/trpc/${proc}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MCP_KEY}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    throw new Error(`${proc} 失败: HTTP ${res.status} ${data?.error?.message ?? ""}`.trim());
  }
  return data?.result?.data;
}

/** 从任务 input（可能是 JSON envelope）提取纯文本提示词 */
function extractPrompt(task) {
  const parts = [`# 任务：${task.name}`];
  const raw = task.input ?? task.description ?? "";
  let payload = raw;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      payload = parsed.payload ?? parsed.input ?? parsed.prompt ?? raw;
    } catch {
      /* 非 JSON，按原文处理 */
    }
  }
  if (payload) parts.push(String(payload));
  if (task.description) parts.push(`\n# 描述\n${task.description}`);
  return parts.join("\n\n");
}

function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

// ─── 结果回写：长输出产物通道 + usage 透传（任务 1.4/1.5） ───

/** inline output 截断阈值：超过则只保留前 10K + 截断说明，全文走 artifacts 通道 */
const INLINE_OUTPUT_LIMIT = 10_000;
/** 单条产物 content 上限（与服务端 updateProgress artifacts zod 上限一致，超出会被拒） */
const ARTIFACT_CONTENT_LIMIT = 50_000;
/** 最多分段条数（服务端 artifacts 单次 ≤5 条） */
const MAX_OUTPUT_PARTS = 5;

/** 把超长全文拆成 ≤5 条、每条 ≤50K 的 markdown 产物 */
function splitOutputArtifacts(output) {
  if (output.length <= ARTIFACT_CONTENT_LIMIT) {
    return [{ name: "full-output.md", content: output, mimeType: "text/markdown" }];
  }
  const parts = [];
  for (let i = 0; i < output.length && parts.length < MAX_OUTPUT_PARTS; i += ARTIFACT_CONTENT_LIMIT) {
    parts.push({
      name: `full-output-part-${parts.length + 1}.md`,
      content: output.slice(i, i + ARTIFACT_CONTENT_LIMIT),
      mimeType: "text/markdown",
    });
  }
  if (output.length > MAX_OUTPUT_PARTS * ARTIFACT_CONTENT_LIMIT) {
    console.warn(
      `[dsh-poller] 输出 ${output.length} 字符超出产物通道容量（${MAX_OUTPUT_PARTS * ARTIFACT_CONTENT_LIMIT}），尾部已丢弃`
    );
  }
  return parts;
}

/**
 * 尽力而为解析 usage：设置 DSH_MODEL 且 dsh stdout 最后一行是可解析 JSON
 * （OpenAI 风格，usage 可能在顶层或 usage 字段下）时提取 token 数；
 * 解析不到返回 null（天宫侧不记账，不阻塞回写）。
 */
function extractUsage(output) {
  const model = process.env.DSH_MODEL;
  if (!model) return null;
  const lines = output.trimEnd().split("\n");
  const last = (lines[lines.length - 1] ?? "").trim();
  if (!last.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(last);
    const u = parsed?.usage ?? parsed;
    const promptTokens = Number(u?.prompt_tokens);
    const completionTokens = Number(u?.completion_tokens);
    if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) return null;
    if (promptTokens < 0 || completionTokens < 0) return null;
    if (promptTokens === 0 && completionTokens === 0) return null;
    return { model, promptTokens, completionTokens };
  } catch {
    return null;
  }
}

/** 组装完成回写 payload：长输出截断 + 产物分段 + usage 透传 */
function buildCompletionPayload(id, output, usage) {
  const payload = { id, progress: 100, status: "done", lifecycleStatus: "completed" };
  if (output.length > INLINE_OUTPUT_LIMIT) {
    payload.output = output.slice(0, INLINE_OUTPUT_LIMIT) + "\n\n(输出超长已截断，全文见 full-output.md 产物)";
    payload.artifacts = splitOutputArtifacts(output);
  } else {
    payload.output = output;
  }
  if (usage) payload.usage = usage;
  return payload;
}

async function runDsh(prompt) {
  const file = join(tmpdir(), `dsh-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  await writeFile(file, prompt, "utf8");
  const cmd = DSH_CMD.replaceAll("{file}", shellQuote(file));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`dsh 执行超时（${DSH_TIMEOUT_MS}ms）`));
      }, DSH_TIMEOUT_MS);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim() || "(dsh 无标准输出)");
        else reject(new Error(`dsh 退出码 ${code}: ${err.slice(-500)}`));
      });
    });
  } finally {
    await unlink(file).catch(() => {});
  }
}

let warnedNoCmd = false;

async function loop() {
  try {
    // 心跳：天宫会在心跳时自动认领最优先的可执行任务返回
    const hb = await trpc("agent.updateHeartbeat", { id: AGENT_ID });
    const claimed = hb?.claimedTask;
    if (!claimed) return;
    if (!DSH_CMD) {
      if (!warnedNoCmd) {
        console.warn(`[dsh-poller] 有任务可认领（${claimed.taskId}），但 DSH_CMD 未设置，跳过执行`);
        warnedNoCmd = true;
      }
      return;
    }
    console.log(`[dsh-poller] 认领任务 ${claimed.taskId} (id=${claimed.id})：${claimed.name}`);
    try {
      await trpc("task.updateProgress", { id: claimed.id, progress: 30, status: "running" });
      const output = await runDsh(extractPrompt(claimed));
      await trpc("task.updateProgress", buildCompletionPayload(claimed.id, output, extractUsage(output)));
      console.log(`[dsh-poller] 任务 ${claimed.taskId} 完成`);
    } catch (e) {
      await trpc("task.updateProgress", {
        id: claimed.id,
        progress: 100,
        status: "failed",
        lifecycleStatus: "failed",
        error: e instanceof Error ? e.message : String(e),
      }).catch(() => {});
      console.error(`[dsh-poller] 任务 ${claimed.taskId} 失败:`, e instanceof Error ? e.message : e);
    }
  } catch (e) {
    console.error("[dsh-poller] 轮询异常:", e instanceof Error ? e.message : e);
  }
}

console.log(`[dsh-poller] 启动：agent=${AGENT_ID} base=${BASE} interval=${POLL_INTERVAL_MS}ms`);
setInterval(loop, POLL_INTERVAL_MS);
loop();
