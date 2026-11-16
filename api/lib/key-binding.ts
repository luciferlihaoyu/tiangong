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
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { getDb } from "../queries/connection";
import { agents, mcpApiKeys } from "@db/schema";

type DbLike = ReturnType<typeof getDb>;

/** 驱动/适配器不保证整数列回来就是 JS number（本仓确有以 TEXT 形态存 id 的列）。宽容归一，>0 才算数。 */
function toId(v: unknown): number | null {
  if (typeof v === "bigint" || typeof v === "string" || typeof v === "number") {
    const n = Number(typeof v === "string" ? v.trim() : v);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return null;
}

/** 日志里绝不出现 Key 本体；sha1 前 10 位足够与探针侧对账（同一串在两边算得出同样的前缀）。 */
function keyHint(key: string): string {
  return `sha1:${createHash("sha1").update(key).digest("hex").slice(0, 10)}/len${key.length}`;
}

/**
 * @returns `number` 绑定到的 agent id；`undefined` = 解析不出绑定（真管理级 / 孤儿 Key / DB 异常），
 *          由调用方 `?? null` 归成管理级 -1。
 *
 * ⚠️ 有意 **不按 `active` 过滤**：本函数只回答"这把 Key 是谁"，不回答"还能不能用"（那是 F2 的范围）。
 *    若在此加 `active='true'` 过滤，被撤销的 Key 会查不到行 → 落到 -1，**反而比撤销前权限更高**。
 *    要堵撤销面必须在调用方拒绝，别改这里。
 *
 * ⚠️ 有意的 **fail-open**：DB 异常时返回 `undefined`（等价于修复前的行为），不让库抖动把 12 家
 *    connector 的回写流量全打死。代价是"库故障期间身份降级为管理级"，已登记为后续项。
 */
export async function resolveBoundAgentId(db: DbLike, key: string): Promise<number | undefined> {
  try {
    // 第一级：mcp_api_keys.key（connector 注册时发的 Key，带显式绑定）
    const rows = await db.select().from(mcpApiKeys).where(eq(mcpApiKeys.key, key)).limit(1);
    const row = rows[0] as Record<string, unknown> | undefined;
    const fromTable = row ? toId(row.agentId) : null;
    if (fromTable !== null) return fromTable;

    // 第二级：agents.mcp_token（女娲/编程大师即此形状）。
    // **必须无条件走到这里**：早前写成 `if (row) return null;` —— 一级有行但 agentId 不可用
    // （该列为空/映射异常/列名失配）时就当场判定"孤儿 Key"，把整条二级兜底跳过去。
    // 用例"一级命中行但行内没有 agentId 字段时，必须继续走二级兜底"锁的就是这一点。
    // 这里刻意用**全行 select** 而不是投影 select({id: agents.id})：投影在自定义适配器
    // (lib/node-sqlite-adapter) 下返回的键名与类型不保证，而同仓 mcp/auth.ts 的全行写法已在生产验证可用。
    const owned = await db.select().from(agents).where(eq(agents.mcpToken, key)).limit(1);
    const owner = owned[0] as Record<string, unknown> | undefined;
    const fromToken = owner ? toId(owner.id) : null;
    if (fromToken !== null) return fromToken;

    // 到这儿就是"boot 全局集合认识、两张表都问不出主人"。修复后若仍出现，这条日志是唯一能区分
    // 「key 表有行但 agentId 不可用」「token 查不到」「值类型异常」三种形状的证据。
    console.warn(
      `[key-binding] 无法解析绑定 ${keyHint(key)} | key表行=${
        row ? `有(agentId=${typeof row.agentId}:${String(row.agentId)})` : "无"
      } | token行=${owner ? `有(id=${typeof owner.id}:${String(owner.id)},name=${String(owner.name)})` : "无"}`
    );
    return undefined;
  } catch (err) {
    console.warn(`[key-binding] 绑定解析异常，降级为未绑定 ${keyHint(key)}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

