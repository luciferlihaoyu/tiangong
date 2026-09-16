/**
 * mcp.revealKey 授权收紧测试（PR1 / t2-reveal-key-admin-only）。
 *
 * 背景：mcp_api_keys 表（db/schema.ts）没有 owner 字段，无法表达"按归属授权"，
 * 因此 revealKey（返回 MCP Key 完整明文）只能按角色收紧为 adminQuery，
 * 与同路由 createKey 一致。
 *
 * 本测试只覆盖拒绝路径：未授权请求在 middleware 层即抛错，
 * 不会进入 resolver、不会触碰数据库，故无需 mock getDb。
 */
import { describe, it, expect } from "vitest";
import { createCallerFactory } from "../../api/middleware";
import { mcpRouter } from "../../api/mcp/mcp-router";

const createCaller = createCallerFactory(mcpRouter);

// 自造 context：模拟 createContext 的输出形状，绕过真实 token 校验
function makeContext(user: { id: number; role: string } | null) {
  return {
    req: new Request("http://localhost/api/trpc"),
    user,
    apiKeyAgentId: null,
    servicePrincipal: null,
  };
}

describe("mcp.revealKey 仅管理员可用", () => {
  it("非管理员登录用户调用被拒（FORBIDDEN）", async () => {
    const caller = createCaller(makeContext({ id: 1, role: "user" }));
    await expect(caller.revealKey({ id: 1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("匿名调用被拒（UNAUTHORIZED）", async () => {
    const caller = createCaller(makeContext(null));
    await expect(caller.revealKey({ id: 1 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
