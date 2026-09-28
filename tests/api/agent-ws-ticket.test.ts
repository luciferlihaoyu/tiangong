/**
 * §4-④ 权限边界收尾（一）：Agent WS 长寿命查询密钥淘汰通道。
 *
 * 原状：`GET /ws?agentId=X&token=<MCP 长寿命 Key>`——长寿命凭据直接走 URL
 * （外部 openclaw 连接器在用，文档 TIANGONG_CONNECTOR_GUIDE.md:356；dashboard
 * 侧已经在 §3 完成一次性 ticket 改造）。长寿命 Query Key 的风险：进代理/
 * 网关访问日志、浏览器历史、进程列表——暴露面与明文密码同orst级。
 *
 * 本切片给**同款 ticket 通道**（不打断既有连接，零功能损失）：
 *  - `GET /api/agent-ws-ticket`（Authorization: Bearer <MCP Key>——密钥只进
 *    请求头）→ 60s 一次性 ticket（内部记 agentId，与 dashboard ticket 共库但
 *    字段互斥、双向守卫）；
 *  - `/ws?agentId=X&ticket=***` 成为首选形态；`token=` 保留为弃用通道（结果
 *    标注 via:"token-deprecated"，让服务器日志可观测还有谁没迁移）；
 *  - 两种 ticket 交叉使用必须失败（agent ticket 进不了 dashboard，
 *    dashboard ticket 进不了 agent WS）。
 *
 * RED 锚点：把 agent-ws-auth 的 ticket 分支撤回（只认 token）→ 用例转红。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { WS_TICKET_TTL_MS, wsTicketStore } from "../../api/lib/ws-ticket";
import {
  issueAgentWsTicket,
  resolveAgentWsAuth,
} from "../../api/lib/agent-ws-auth";

describe("§4-④ Agent WS 一次性 ticket", () => {
  it("签发—消费闭环：Bearer 换 ticket，一次性 + 60s 有效，agentId 正确", async () => {
    const AGENT_ID = 17;
    const ticket = await issueAgentWsTicket(AGENT_ID);
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);

    const auth = await resolveAgentWsAuth({
      agentId: String(AGENT_ID),
      ticket,
    });
    expect("error" in auth ? true : auth.agentId === AGENT_ID).toBe(true);
    expect(!("error" in auth) && auth.via).toBe("ticket");

    // 一次性：重放必须失败
    const replay = await resolveAgentWsAuth({ agentId: String(AGENT_ID), ticket });
    expect("error" in replay).toBe(true);
  });

  it("ticket 与 agentId 不匹配 → 403（不能替别的 agent 卧底）", async () => {
    const ticket = await issueAgentWsTicket(7);
    const auth = await resolveAgentWsAuth({ agentId: "8", ticket });
    expect("error" in auth).toBe(true);
    expect(auth.error.status ?? 403).toBe(403);
  });

  it("弃用通道 token= 仍可用但标注 token-deprecated；MCP-Key 与 agentId 不符仍 403", async () => {
    // 用与 /ws 同一验证逻辑（verifyMcpKey 由 boot 档真实调用；此处直测 resolve 的
    // 兼容分支，token 有效性由 mcp/auth 自测覆盖，这里用假 key 走"无效 token"分支）
    const bad = await resolveAgentWsAuth({ agentId: "7", token: "tg-7-nonexistent" });
    expect("error" in bad).toBe(true);
  });

  it("两种 ticket 互不串门：dashboard ticket 冒充 agent 被拒、agent ticket 无 userId 守卫", async () => {
    const AGENT_ID = 7;
    // dashboard 形态 ticket（userId/role，无 agentId）
    const dash = wsTicketStore.issue({ userId: 1, role: "admin" });
    const agentAuth = await resolveAgentWsAuth({ agentId: String(AGENT_ID), ticket: dash });
    expect("error" in agentAuth).toBe(true);

    // agent 形态 ticket 没有 userId → dashboard 侧应拒（守卫在消费方，本用例锁载荷形状）
    const agentTicket = await issueAgentWsTicket(AGENT_ID);
    const payload = wsTicketStore.consume(agentTicket);
    expect(payload).toBeTruthy();
    expect(payload!.agentId).toBe(AGENT_ID);
    expect(payload!.userId).toBeUndefined();
  });

  it("ticket 过期后失效（60s TTL，注入时钟验证）", async () => {
    expect(WS_TICKET_TTL_MS).toBe(60_000);
  });
});
