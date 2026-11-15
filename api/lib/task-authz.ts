/**
 * 任务写操作鉴权 / 产物可插入性共享校验（单一事实源）
 *
 * 抽出动机（2.1+2.2 评审 minor）：submit_artifact（api/mcp/server.ts）与
 * reportTaskProgress（api/lib/task-writeback.ts）原本各持一份越权判断 + 任务
 * 终态判断 + beidou 拒绝逻辑——与本仓库 P0 修复过的"钩子复制漂移"教训同源。
 * 任何"再加一层拒绝"的需求改这一处即可，杜绝两份拷贝漂移。
 *
 * 设计约束：
 *   - 函数全部纯函数（不触达 DB），调用方各自按既有风格返回 error 形状
 *     （MCP 面用 errorResult，tRPC 面抛 TRPCError / 返回 { success: false, error }）。
 *   - 不承担 zod 入参校验（输入边界已在 router / tool 入参侧完成）。
 *   - apiKeyAgentId 语义与 tRPC 现有 ctx.apiKeyAgentId 对齐：
 *       null = 登录用户；-1 = 管理型 Key；> 0 = Key 绑定的 agent。
 *     越权规则只拦截 "Key 绑定的 agent 与任务认领人不符" 这一种（> 0 分支），
 *     null / -1 一律放行（管理位语义，与 reportTaskProgress 现有实现一致）。
 */

import { TRPCError } from "@trpc/server";

/** 写操作需要看到的最小任务视图（不必是完整 TaskRow，足够做终态/beidou 判定） */
export interface TaskForWriteAuth {
  id: number;
  status: string;
  agentId: number | null;
  /** beidou 等外系统任务的来源标记（任务 1.4 引入）；非 beidou 任务可缺省/为 null */
  originSystem?: string | null;
}

/**
 * 越权检查：MCP Key 绑定的 agent 与任务认领人不符时拒绝。
 * 返回 { ok: true } 表示放行；{ ok: false, error } 给调用方作为错误文案。
 *
 * ⚠️ 与 canWriteTaskStatus（同文件）的**有意不对称**：admin 角色的 agent Key 且非执行者时，
 *   canWriteTaskStatus 放行状态写入、本函数拒绝 usage/artifacts 提交（本函数只认执行者，
 *   **不含 admin agent**）。这是刻意设计——产物/用量假账面比状态回写更需收紧，差异由
 *   tests/task-authz-review.test.ts「admin agent 非执行者」契约用例锁定，勿"顺手统一"。
 *
 * 命名说明（评审 minor ⑧）：返回"检查结果"而非抛错，故用 check 前缀而非 assert
 * （assert 语义应直接 throw）。真正要抛错的封装见 assertTaskWriteAuthorizedOrThrow /
 * assertTaskWriteAuthorizedOrMcp。
 *
 * 调用方业务决策：
 *   - tRPC 面（reportTaskProgress）抛 TRPCError({ code: "FORBIDDEN", message })
 *   - MCP 工具面（submit_artifact）直接转 errorResult（isError=true）
 */
export function checkTaskWriteAuthorized(
  apiKeyAgentId: number | null,
  task: Pick<TaskForWriteAuth, "agentId">
): { ok: true } | { ok: false; error: string } {
  // 管理位（null 登录用户、-1 管理型 Key）放行；只有 "> 0 绑定具体 agent 的 Key" 才参与越权判定
  if (apiKeyAgentId !== null && apiKeyAgentId > 0 && apiKeyAgentId !== task.agentId) {
    return {
      ok: false,
      error: "FORBIDDEN：此 MCP Key 绑定的 Agent 与任务认领人不匹配",
    };
  }
  return { ok: true };
}

/** 越权检查的结果类型（checkTaskWriteAuthorized 的返回） */
export type TaskWriteAuthzResult = { ok: true } | { ok: false; error: string };

// ─── 验收 / 状态写入身份判定（2026-11 缺陷修复，纯函数、可单测） ───

/**
 * 调用者身份视图（从 tRPC ctx 提炼：ctx.user?.role / ctx.user?.id / ctx.apiKeyAgentId）。
 * apiKeyAgentId 口径与本文件头部注释一致：null=登录用户；-1=管理型 Key；>0=绑定 agent。
 */
export interface ReviewActor {
  /** 登录用户角色；无登录用户为 null */
  userRole: string | null;
  /** 登录用户 id（可选，仅用于 actorLabel 审计标注） */
  userId?: number | null;
  apiKeyAgentId: number | null;
}

/**
 * 任务最小视图。
 * - agentId：执行者（认领人），canReviewTask / canWriteTaskStatus 共用；
 * - reviewerId：**仅 canReviewTask 使用**的可选字段（2026-11 A2A 编排闭环补全）——
 *   taskboard.submit 时按「父任务 agentId > dispatcherAgentId > null」落库的验收方
 *   （db/schema.ts tasks.reviewer_id）。canWriteTaskStatus 对该字段零引用，
 *   **状态写入面不因它扩大**（契约见该函数注释与 tests/task-authz-review.test.ts）。
 *   显式防 null/undefined 混淆：判定处只认 `typeof === "number"`，缺省/undefined 一律不放行。
 */
export interface TaskForReviewAuth {
  agentId: number | null;
  /** 被指派的验收方 agent id；null/缺省 = 无验收方（不得误放行） */
  reviewerId?: number | null;
}

/** 判定结果：ok 时带 actorLabel（写进审计事件，标明"谁验收的"） */
export type ReviewAuthzResult = { ok: true; actorLabel: string } | { ok: false; reason: string };

/**
 * 验收（a2a.review）身份判定。核心决策矩阵：
 *   - 登录用户：**仅 role === "admin"**。绝不放宽到普通登录用户——否则等于把
 *     "任何注册用户可批准任务" 这个洞打开（与 adminQuery 原意一致，只是改为
 *     API Key 也能进过程体后在判定层拦住，而非中间件一刀切 401）。
 *   - 管理型 Key（-1）：放行（与 checkTaskWriteAuthorized 现有管理位口径一致）。
 *   - 绑定 agent 的 Key（>0）三支任一命中即放行（顺序：admin 角色 → executor → reviewer）：
 *       1. 该 agent role === "admin"；
 *       2. 该 agent 是此任务的**执行者**（task.agentId === apiKeyAgentId）→ (executor)，
 *          connector 自动收尾通道；
 *       3. 该 agent 是此任务的**验收方**（task.reviewerId === apiKeyAgentId）→ (reviewer)。
 *          A2A 编排正解"执行者交付、验收方接受"（2026-11 补全）：派发方（父任务
 *          agentId 或 dispatcherAgentId，submit 时已落 tasks.reviewer_id）验收子任务
 *          交付。actorLabel 用 `agent:<id>(reviewer)`，审计上与 (executor) 严格区分
 *          ——一眼看出是"验收方接受"而非"自批"。
 * ⚠️ 越权面不扩：非执行者且非验收方的 agent Key 仍拒绝。reviewerId 为 null/缺省时
 *    reviewer 支必不成立（只认 number 相等），不存在"任何 agent 验收任何任务"。
 * ⚠️ 分层：本函数只回答"谁有资格按下验收按钮"。高风险任务的 self-approve 防线在
 *    调用方的 checkCompletionGate + parkTaskForApproval（review 过程体内），
 *    执行者对自己高风险任务在这里拿到 ok:true 也完不成——闸门必拦；
 *    reviewer 验收高风险任务同样过闸门，不因新增 reviewer 支开出后门。
 * @param actorAgentRole apiKeyAgentId>0 时该 Key 绑定 agent 的 role（调用方查库后传入；缺省视为非 admin）
 */
export function canReviewTask(
  actor: ReviewActor,
  task: TaskForReviewAuth,
  actorAgentRole?: string | null
): ReviewAuthzResult {
  // 完全匿名（无登录用户又无有效 Key）：拒绝。authedQuery 正常挡在前面，
  // 这里是判定层的纵深防御——绝不把"身份不明"当管理位放行。
  if (actor.apiKeyAgentId === null && (actor.userRole === null || actor.userRole === undefined)) {
    return { ok: false, reason: "FORBIDDEN：无法识别的调用者身份" };
  }
  // 登录用户优先按人判定（审计标注为人；与 Key 并存时以人为准）
  if (actor.userRole !== null && actor.userRole !== undefined) {
    if (actor.userRole === "admin") {
      return { ok: true, actorLabel: `user:${actor.userId ?? "?"}(admin)` };
    }
    return { ok: false, reason: "FORBIDDEN：验收任务需要 admin 角色的登录用户" };
  }
  // 管理型 Key（未绑定具体 agent）：与 checkTaskWriteAuthorized 的 -1 口径一致
  if (actor.apiKeyAgentId === -1) {
    return { ok: true, actorLabel: "key:unbound" };
  }
  // 绑定 agent 的 Key
  if (actor.apiKeyAgentId !== null && actor.apiKeyAgentId > 0) {
    if (actorAgentRole === "admin") {
      return { ok: true, actorLabel: `agent:${actor.apiKeyAgentId}(admin)` };
    }
    if (task.agentId !== null && task.agentId === actor.apiKeyAgentId) {
      return { ok: true, actorLabel: `agent:${actor.apiKeyAgentId}(executor)` };
    }
    // 验收方（A2A 编排闭环，2026-11 补全）：被指派为 task.reviewerId 的 agent 接受交付。
    // 显式只认 number——null/undefined/缺省一律不成立，防 null 混淆误放行。
    if (typeof task.reviewerId === "number" && task.reviewerId === actor.apiKeyAgentId) {
      return { ok: true, actorLabel: `agent:${actor.apiKeyAgentId}(reviewer)` };
    }
    return { ok: false, reason: "FORBIDDEN：此 MCP Key 绑定的 Agent 既不是该任务的认领人也不是指派的验收方，无权验收" };
  }
  return { ok: false, reason: "FORBIDDEN：无法识别的调用者身份" };
}

/**
 * 状态写入（reportTaskProgress 的 status/lifecycleStatus 回写）身份判定。
 * 放行面刻意保持宽松以免打死 connector 正常回写：
 *   登录用户（任意角色）、管理型 Key（-1）、任务执行者本人（apiKeyAgentId === task.agentId）、
 *   admin 角色的 agent Key —— 其余拒绝。
 * 堵住的洞：此前只有 usage/artifacts 做授权，任意合法 Agent Key 可把**别人**的任务写成 done/failed。
 * ⚠️ 契约（2026-11 reviewer 扩权时明确）：**验收（review）与改状态（progress）是两种权限**。
 *   canReviewTask 认 task.reviewerId（验收方），本函数**零引用 reviewerId**——被指派为
 *   验收方的 agent 不因该身份获得改写他人任务状态的权力。状态写入面不随 reviewer 扩大，
 *   由 tests/task-authz-review.test.ts「reviewer 无 canWriteTaskStatus 权限」用例锁定。
 * ⚠️ 与 checkTaskWriteAuthorized（usage/artifacts 通道）的**有意不对称**：admin 角色的 agent
 *   Key 且非执行者时，本函数放行、checkTaskWriteAuthorized 拒绝（后者只认执行者，不含
 *   admin agent）。差异由测试锁定（见同名用例），改动任一函数前先确认该契约仍成立。
 */
export function canWriteTaskStatus(
  actor: ReviewActor,
  task: TaskForReviewAuth,
  actorAgentRole?: string | null
): { ok: true } | { ok: false; reason: string } {
  // 完全匿名（无登录用户又无有效 Key）：拒绝——绝不把"身份不明"当管理位放行
  if (actor.apiKeyAgentId === null && (actor.userRole === null || actor.userRole === undefined)) {
    return { ok: false, reason: "FORBIDDEN：无法识别的调用者身份" };
  }
  if (actor.apiKeyAgentId === null) return { ok: true }; // 登录用户（含内建 Runner 的系统通道）
  if (actor.apiKeyAgentId === -1) return { ok: true }; // 管理型 Key
  if (actor.apiKeyAgentId > 0) {
    if (actorAgentRole === "admin") return { ok: true };
    if (task.agentId !== null && task.agentId === actor.apiKeyAgentId) return { ok: true };
    return { ok: false, reason: "FORBIDDEN：此 MCP Key 绑定的 Agent 不是该任务的认领人，无权改写任务状态" };
  }
  return { ok: false, reason: "FORBIDDEN：无法识别的调用者身份" };
}

/**
 * MCP 工具面的错误结果形状（与 api/mcp/server.ts 的 errorResult 同构：
 * isError=true 让调用方 dsh 机器能机器判别失败并走重试/上报分支）。
 * content 用可变数组以匹配 MCP SDK 的 CallToolResult 要求（readonly 不可赋值）。
 */
export interface McpToolErrorResult {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
}

/**
 * tRPC 端封装（评审 minor ⑥）：authz 拒绝时抛 TRPCError FORBIDDEN。
 * 把 task-writeback 与 MCP 工具面原本各写一份的 "if (!authz.ok) ..." 收敛到本 helper，
 * 消除两份实现漂移（本仓库 P0 修复过的"钩子复制漂移"教训）。
 */
export function assertTaskWriteAuthorizedOrThrow(authz: TaskWriteAuthzResult): void {
  if (!authz.ok) {
    throw new TRPCError({ code: "FORBIDDEN", message: authz.error });
  }
}

/**
 * MCP 工具面封装（评审 minor ⑥）：authz 拒绝时返回机器可判别的 errorResult；
 * 放行时返回 null，调用方 `const denied = ...; if (denied) return denied;` 即可。
 */
export function assertTaskWriteAuthorizedOrMcp(authz: TaskWriteAuthzResult): McpToolErrorResult | null {
  if (!authz.ok) {
    return mcpErrorResult(authz.error);
  }
  return null;
}

function mcpErrorResult(error: string): McpToolErrorResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error }, null, 2) }],
    isError: true,
  };
}

/**
 * 产物可插入性检查：任务存在 / 非终态 / 非 beidou origin。
 * 返回 null 表示可插入；返回 string 表示拒绝原因（同时作为错误文案）。
 *
 * 命名说明（评审 minor ⑧）：返回 string | null（错误文案或可插入），
 * 不是布尔谓词，故命名 get...Error 而非 is...able。
 *
 * beidou 拒绝说明（2.1+2.2 评审 minor 补漏）：beidou 外系统任务的产物应当走 a2a
 * 通道，而不应通过 MCP submit_artifact 工具直接灌入——后者会绕过 beidou 自身的
 * 鉴权与归档链路。reportTaskProgress 也有同款 beidou 拒绝（在 task-writeback.ts），
 * 语义保持一致。
 */
export function getArtifactInsertabilityError(
  task: TaskForWriteAuth | null | undefined
): string | null {
  if (!task) return "任务不存在";
  if (task.originSystem === "beidou") {
    return "External tasks reject submit_artifact mutations";
  }
  // submit_artifact 只在 running/pending/queued 时允许提交（与既有实现一致）
  if (task.status !== "running" && task.status !== "pending" && task.status !== "queued") {
    return `任务已处于终态 ${task.status}，不可再提交产物`;
  }
  return null;
}

/**
 * 产物内容的字节上限（MySQL TEXT 字段 64KB 字节；保守留 4KB 余量）。
 * contract 的 z.string().max(50_000) 只限字符数、不限字节——UTF-8 中文 3 字节/字，
 * 2.1 万字符即满 64KB，必须按字节校验（评审 minor ③）。
 */
export const MAX_ARTIFACT_CONTENT_BYTES = 60_000;

/**
 * 产物内容字节校验：超过 MAX_ARTIFACT_CONTENT_BYTES 字节返回拒绝原因（作为错误文案），
 * 否则返回 null。**不截断**——超限直接拒绝，让调用方（dsh 机器）看到失败而非静默数据丢失。
 * submit_artifact 与 reportTaskProgress 的长产物通道共用同一份判定。
 */
export function getArtifactContentTooLargeError(content: string): string | null {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_ARTIFACT_CONTENT_BYTES) {
    return `产物内容 ${bytes} 字节超过 MySQL TEXT 字段上限（${MAX_ARTIFACT_CONTENT_BYTES} 字节），请截断或分片提交`;
  }
  return null;
}
