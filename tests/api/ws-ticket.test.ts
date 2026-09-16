/**
 * /ws/dashboard 一次性 WS ticket 与 Origin 校验的单元测试。
 *
 * 只测纯逻辑（ws-ticket 库），不触 DB、不起 HTTP 服务；
 * ticket 过期用注入时钟推进，避免真实 sleep。
 */
import { describe, it, expect } from "vitest";
import { WsTicketStore, isAllowedWsOrigin } from "../../api/lib/ws-ticket";

describe("WsTicketStore", () => {
  it("issue 后 consume 返回签发时的身份", () => {
    const store = new WsTicketStore();
    const ticket = store.issue({ userId: 7, role: "admin" });
    expect(typeof ticket).toBe("string");
    expect(ticket.length).toBeGreaterThanOrEqual(32);
    expect(store.consume(ticket)).toEqual({ userId: 7, role: "admin" });
  });

  it("ticket 是一次性的：第二次 consume 返回 null", () => {
    const store = new WsTicketStore();
    const ticket = store.issue({ userId: 1, role: "user" });
    expect(store.consume(ticket)).not.toBeNull();
    // 重放同一 ticket 必须失败，否则等于一个长期有效的明文凭据
    expect(store.consume(ticket)).toBeNull();
  });

  it("未知 ticket 返回 null", () => {
    const store = new WsTicketStore();
    expect(store.consume("does-not-exist")).toBeNull();
    expect(store.consume("")).toBeNull();
  });

  it("过期 ticket 返回 null（注入时钟推进）", () => {
    let now = 1_000_000;
    const store = new WsTicketStore({ ttlMs: 60_000, now: () => now });
    const ticket = store.issue({ userId: 1, role: "user" });

    now += 59_999;
    expect(store.consume(ticket)).not.toBeNull();

    const ticket2 = store.issue({ userId: 1, role: "user" });
    now += 60_001; // 距 ticket2 签发刚好超过 ttl
    expect(store.consume(ticket2)).toBeNull();
  });

  it("过期 ticket 即使已被 consume 一次也依然返回 null", () => {
    let now = 0;
    const store = new WsTicketStore({ ttlMs: 1000, now: () => now });
    const ticket = store.issue({ userId: 2, role: "user" });
    store.consume(ticket);
    now += 10_000;
    expect(store.consume(ticket)).toBeNull();
  });

  it("pending() 反映未消费数量，读取时清理过期项", () => {
    let now = 0;
    const store = new WsTicketStore({ ttlMs: 1000, now: () => now });
    store.issue({ userId: 1, role: "user" });
    store.issue({ userId: 2, role: "admin" });
    expect(store.pending()).toBe(2);

    now += 2000;
    // 过期项应在 pending/consume 时被清理，避免 Map 无限增长
    expect(store.pending()).toBe(0);
  });

  it("issue() 会顺手清理过期项，避免长跑容器里 Map 只增不减", () => {
    let now = 0;
    const store = new WsTicketStore({ ttlMs: 1000, now: () => now });
    store.issue({ userId: 1, role: "user" });

    now += 5000; // 上面那张已过期
    store.issue({ userId: 2, role: "admin" }); // 签发时应顺手清理过期项

    // 关键：此处不能用 pending() 判定——pending() 自己也会清理，
    // 那样即使 issue() 完全没有清理也会是绿的。用 prune() 的返回值才测得准：
    // 若 issue() 没清理，这里会返回 1（那条过期旧票）。
    expect(store.prune()).toBe(0);
    expect(store.pending()).toBe(1);
  });
});

describe("isAllowedWsOrigin", () => {
  const allowList = ["https://admin.example.com", "tools.internal:8443"];

  it("无 Origin 放行（非浏览器客户端；CSWSH 只针对浏览器）", () => {
    expect(isAllowedWsOrigin(null, "tiangong.example.com", [])).toBe(true);
  });

  it("同源放行：origin 的 host 与请求 host 一致", () => {
    expect(
      isAllowedWsOrigin("https://tiangong.example.com", "tiangong.example.com", [])
    ).toBe(true);
  });

  it("跨站拒绝：origin 的 host 与请求 host 不一致且不在允许清单", () => {
    expect(
      isAllowedWsOrigin("https://evil.example.com", "tiangong.example.com", [])
    ).toBe(false);
  });

  it("允许清单命中完整 origin 放行", () => {
    expect(
      isAllowedWsOrigin("https://admin.example.com", "tiangong.example.com", allowList)
    ).toBe(true);
  });

  it("允许清单命中 origin 的 host 放行", () => {
    expect(
      isAllowedWsOrigin("https://tools.internal:8443", "tiangong.example.com", allowList)
    ).toBe(true);
  });

  it("非法 origin（无法解析为 URL）拒绝", () => {
    expect(
      isAllowedWsOrigin("not a url at all", "tiangong.example.com", [])
    ).toBe(false);
  });

  it("host 缺失时跨站拒绝", () => {
    expect(
      isAllowedWsOrigin("https://tiangong.example.com", null, [])
    ).toBe(false);
  });
});
