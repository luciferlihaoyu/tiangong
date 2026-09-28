/**
 * Agent WS 握手鉴权（§4-④ 长寿命查询密钥淘汰通道）。
 *
 * 首选：`/api/agent-ws-ticket`（Authorization: Bearer <MCP Key>，密钥只进请求头）
 * 换 60s 一次性 ticket → `/ws?agentId=X&ticket=***`。
 * 兼容：`token=`（长寿命 MCP Key 直挂 URL）保留但结果标注 via:"token-deprecated"，
 * 让服务器侧可观测尚未迁移的外部 openclaw 连接器（TIANGONG_CONNECTOR_GUIDE.md）。
 *
 * 安全形状：
 *  - ticket 与 dashboard ticket 共用 store 但字段互斥：本模块只认 payload.agentId
 *    存在的 ticket；dashboard 侧（boot.ts）守卫 payload.userId 必须存在——互不串门；
 *  - ticket 一次性（consume 即删），重放必失败；
 *  - ticket 绑定 agentId，替别的 agent 握手一律 403。
 */
import { verifyMcpKey } from "../mcp/auth";
import { wsTicketStore } from "./ws-ticket";

export interface AgentWsAuthOk {
  agentId: number;
  via: "ticket" | "token-deprecated";
}
export interface AgentWsAuthError {
  error: string;
  status: 400 | 401 | 403;
}

/** 用**已验证的** MCP Key（Bearer 头在 /api/agent-ws-ticket 端点验证）换一次性 agent ticket */
export function issueAgentWsTicket(agentId: number): string {
  return wsTicketStore.issue({ agentId: agentId });
}

type VerifyOk = { valid: true; agent?: { id: number } | null };
function authResult_ok(r: unknown): r is VerifyOk {
  return typeof r === "object" && r !== null && (r as { valid?: boolean }).valid === true;
}

export async function resolveAgentWsAuth(query: {
  agentId?: string;
  token?: string;
  ticket?: string;
}): Promise<AgentWsAuthOk | AgentWsAuthError> {
  const agentIdStr = query.agentId;
  const agentId = agentIdStr ? Number.parseInt(agentIdStr, 10) : NaN;
  if (!agentIdStr || Number.isNaN(agentId)) {
    return { error: "agentId 必须是数字", status: 400 };
  }

  // 首选：一次性 ticket
  if (query.ticket) {
    const payload = wsTicketStore.consume(query.ticket);
    if (!payload) return { error: "缺少或失效的 ticket", status: 401 };
    if (payload.agentId == null) return { error: "ticket 类型不符", status: 401 };
    if (payload.agentId !== agentId) return { error: "ticket 与 agentId 不匹配", status: 403 };
    return { agentId, via: "ticket" };
  }

  // 兼容：长寿命 MCP Key 直挂 query（弃用中——日志可观测迁移进度）
  if (query.token) {
    const auth = await verifyMcpKey(query.token);
    if (!auth.valid) {
      return { error: auth.error || "认证失败", status: (auth.statusCode || 401) as 401 };
    }
    if (auth.agent && auth.agent.id !== agentId) {
      return { error: "Token 与 Agent 不匹配", status: 403 };
    }
    return { agentId, via: "token-deprecated" };
  }

  return { error: "缺少 agentId/ticket/token 参数", status: 400 };
}
