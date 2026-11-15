/**
 * t2-2：建单入口的「执行人闸门」与「幂等键」——tRPC 面与 MCP 面共用同一事实源。
 *
 * 为什么必须有这道闸（历史 #61/#62/#198）：`agent_id IS NULL` 且没有任何归属声明的
 * "通用任务"不被内建 Runner 的任何跳过条件命中 → 天宫自己下场用 mode=tianshu 执行，
 * 而天枢没有对应模型渠道 → 必然 HTTP 503 ×重试后 failed。全库曾 23/68 个任务是这个
 * 形状。认领侧的路由保护（isAgentAllowedByRouting）只能挡住"别的 agent 抢单"，
 * 挡不住"没人被指派、内建 Runner 兜底接单"——所以必须在**建单入口**拒绝。
 *
 * 幂等键复用既有列 `tasks.idempotency_key` + 复合唯一索引
 * `uq_tasks_origin_idempotency_key (origin_system, idempotency_key)`（北斗外部建单
 * 链路早已在用，本次不新建任何列/索引）。⚠️ 必须同时写 origin_system：SQLite 唯一
 * 索引里 NULL 互不冲突，只写 key 不写 origin 的话约束形同虚设。
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { tasks } from "../../db/schema";
import type { Db } from "./execution-gate";

/** 天宫内部建单（orch.createTask / MCP create_task）的来源系统标识 */
export const ORIGIN_SYSTEM_TIANGONG = "tiangong";

/** 拒绝文案的唯一事实源：两处调用点（tRPC / MCP）必须逐字一致，防止漂移 */
export const EXECUTOR_REQUIRED_MESSAGE =
  "通用任务（无执行人）已被 t2-2 拒绝：派单必须带 requestedAgentId，否则内建 Runner 会以 agent_id=NULL 抢单（历史 #61/#62/#198 教训）";

export interface CreateTaskExecutorInput {
  /** 数字 agents.id：直派 */
  agentId?: number | null;
  /** agents.agentId 字符串：期望执行者（写入 input metadata routing.selectedAgentId） */
  requestedAgentId?: string | null;
}

/**
 * 判定是否指定了执行人。
 * `requestedAgentId` 只有非空白才算数——空白串不会写进 routing metadata，
 * 于是任务仍然落回"无人认领 + Runner 抢单"的形状，不能当放行凭据。
 */
export function hasDeclaredExecutor(input: CreateTaskExecutorInput): boolean {
  if (typeof input.agentId === "number" && Number.isFinite(input.agentId)) return true;
  return typeof input.requestedAgentId === "string" && input.requestedAgentId.trim().length > 0;
}

/** tRPC 面：违规抛 BAD_REQUEST（HTTP 400），错误码与文案都由本函数给出 */
export function assertDeclaredExecutor(input: CreateTaskExecutorInput): void {
  if (!hasDeclaredExecutor(input)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: EXECUTOR_REQUIRED_MESSAGE });
  }
}

/** 幂等重放命中已有任务时的返回形状（与正常建单同形 + reused 标记） */
export interface ReusedTaskResult {
  success: true;
  id: number;
  taskId: string;
  name: string;
  status: string;
  reused: true;
}

/**
 * 按 (origin_system, idempotency_key) 查已存在的任务。
 * 只在两列都非空时查询——NULL 参与不了这个唯一索引。
 */
export async function findTaskByIdempotencyKey(
  db: Db,
  idempotencyKey: string | null | undefined,
): Promise<typeof tasks.$inferSelect | undefined> {
  if (!idempotencyKey || !idempotencyKey.trim()) return undefined;
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.originSystem, ORIGIN_SYSTEM_TIANGONG),
        eq(tasks.idempotencyKey, idempotencyKey.trim()),
      ),
    )
    .limit(1);
  return rows[0];
}

/** 把命中的任务行转成建单返回值（与正常返回同形状，附 reused:true） */
export function toReusedTaskResult(row: typeof tasks.$inferSelect): ReusedTaskResult {
  return {
    success: true,
    id: row.id,
    taskId: row.taskId,
    name: row.name,
    status: row.status,
    reused: true,
  };
}
