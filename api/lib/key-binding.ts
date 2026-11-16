/**
 * 把一把**已确认合法**的凭证解析回它绑定的 agent。
 *
 * 为什么需要这个文件（2026-11-16 生产实测，详见璇玑 1000203）：
 * `middleware.ts` 的 `verifyApiKey` 在 `_globalApiKeys`（boot.ts 从 `agents.mcp_token` 填的 12 条）
 * 命中时直接返回 `boundAgentId: null`，而 `createContext` 写的是 `apiKeyAgentId = boundAgentId ?? -1`，
 * 于是每一把 connector 的 agent Key 都以"未绑定管理级"身份进来，任何按 `apiKeyAgentId`
 * 判执行者/验收方的鉴权全部空转。本文件提供缺失的那一步：**这把 Key 到底属于哪个 agent**。
 *
 * 两级解析的必要性（实测数据）：12 个带 `mcp_token` 的 agent 里 **10 个**能在 `mcp_api_keys.key`
 * 命中并拿到 `agent_id`；**女娲(id=1) 与已弃用的编程大师(id=2) 命中 0**——它们的现役凭证只存在于
 * `agents.mcp_token`。所以只查 `mcp_api_keys` 会让这两家的 connector 直接失去身份。
 */
import { eq } from "drizzle-orm";
import type { getDb } from "../queries/connection";
import { agents, mcpApiKeys } from "@db/schema";

type DbLike = ReturnType<typeof getDb>;

/**
 * @returns `number` 绑定到的 agent id；`null` 查到 Key 但库里没写绑定（孤儿 Key，按管理级处理）；
 *          `undefined` 两张表都不认识这把 Key（真·管理级凭证，或 DB 异常）——由调用方决定语义。
 *
 * ⚠️ 有意 **不按 `active` 过滤**：本函数只回答"这把 Key 是谁"，不回答"还能不能用"（那是 F2 的范围）。
 *    若在此处加 `active='true'` 过滤，被撤销的 Key 会查不到行 → 返回 `undefined` → 调用方按
 *    "未绑定管理级 `-1`"处理，**反而比撤销前拿到更高权限**。要堵撤销面必须在调用方拒绝，别改这里。
 *
 * ⚠️ 有意的 **fail-open**：DB 异常时返回 `undefined`（等价于修复前的行为），不让库抖动把
 *    12 家 connector 的回写流量全打死。代价是"库故障期间身份降级为管理级"，已登记为后续项。
 */
export async function resolveBoundAgentId(db: DbLike, key: string): Promise<number | null | undefined> {
  try {
    // 第一级：mcp_api_keys.key（connector 注册时发的 Key，带显式绑定）
    const rows = await db.select().from(mcpApiKeys).where(eq(mcpApiKeys.key, key)).limit(1);
    const row = rows[0] as { agentId?: unknown } | undefined;
    if (row && row.agentId !== null && row.agentId !== undefined) {
      // 列值在本库里可能是文本形态，必须归一为 number：下游一律用 `===` 与 task.agentId 比，
      // 字符串 "14" 与数字 14 永不相等（`?? ` 也不把 0 当空，同类的"看似有值实则类型不对"坑）。
      const id = Number(row.agentId);
      return Number.isInteger(id) ? id : null;
    }
    if (row) return null; // 查到行但 agent_id 为空 = 孤儿 Key

    // 第二级：agents.mcp_token（女娲/编程大师即此形状）
    const owned = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.mcpToken, key))
      .limit(1);
    const owner = owned[0] as { id?: unknown } | undefined;
    if (!owner) return undefined;
    const id = Number(owner.id);
    return Number.isInteger(id) ? id : null;
  } catch (err) {
    // 只记错误与前缀，绝不打印完整 Key（日志会外流；本仓已因探测脚本泄露过一次口令，勿再犯）
    console.warn(`[key-binding] 绑定解析失败，降级为未绑定: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
