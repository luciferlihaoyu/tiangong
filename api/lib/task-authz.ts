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
 * 调用方业务决策：
 *   - tRPC 面（reportTaskProgress）抛 TRPCError({ code: "FORBIDDEN", message })
 *   - MCP 工具面（submit_artifact）直接转 errorResult（isError=true）
 */
export function assertTaskWriteAuthorized(
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

/**
 * 产物可插入性检查：任务存在 / 非终态 / 非 beidou origin。
 * 返回 null 表示可插入；返回 string 表示拒绝原因（同时作为错误文案）。
 *
 * beidou 拒绝说明（2.1+2.2 评审 minor 补漏）：beidou 外系统任务的产物应当走 a2a
 * 通道，而不应通过 MCP submit_artifact 工具直接灌入——后者会绕过 beidou 自身的
 * 鉴权与归档链路。reportTaskProgress 也有同款 beidou 拒绝（在 task-writeback.ts），
 * 语义保持一致。
 */
export function isTaskArtifactInsertable(
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
