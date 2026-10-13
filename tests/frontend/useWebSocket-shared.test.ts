/**
 * SharedWsConnection（模块级共享单连接 + 多路分发）纯逻辑单测。
 *
 * 背景：useWebSocket 原为「每组件各建一条 WS + 各取一次性 ticket + 各自重连」，
 * 12 个调用点导致多标签事件重复派发与连接浪费。重构后由模块级
 * SharedWsConnection 持有唯一 socket，hook 实例只做 acquire/release 订阅。
 *
 * 本测试跑在 node 环境（无 jsdom）：注入 FakeWebSocket 与 ManualTimers，
 * 所有行为同步可断言，不碰真实网络。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SharedWsConnection,
  type SharedWsConnectionDeps,
  type WsEventLike,
  type WsLike,
} from "../../src/lib/ws-connection";

const WS_OPEN = 1;
const WS_CLOSED = 3;

/** 最小 WebSocket 形状：就绪状态 + 四个事件槽 + send/close */
class FakeWebSocket implements WsLike {
  static instances: FakeWebSocket[] = [];

  readyState = 0; // CONNECTING
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: WsEventLike) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = WS_CLOSED;
    this.onclose?.();
  }

  /* —— 测试侧驱动（模拟服务端行为）—— */
  serverOpen(): void {
    this.readyState = WS_OPEN;
    this.onopen?.();
  }

  serverMessage(data: string): void {
    this.onmessage?.({ data });
  }

  serverClose(): void {
    this.readyState = WS_CLOSED;
    this.onclose?.();
  }

  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }
}

/** 手动定时器队列：记录延迟并可整批触发（模拟时间推进） */
class ManualTimers {
  private seq = 0;
  private pending = new Map<number, () => void>();
  readonly delays: number[] = [];

  set = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.delays.push(ms);
    this.pending.set(id, fn);
    return id;
  };

  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** 触发当前挂起的全部定时器（快照语义：期间新排的定时器等下一轮 advance） */
  advance = (): void => {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  };

  get size(): number {
    return this.pending.size;
  }
}

/** 排空微任务队列：让 ticketProvider 的 await 链走完 */
const flushAsync = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
};

/** 自动发号 ticket 的 provider（ticket-1、ticket-2 …），可断言调用次数 */
function countingTicketProvider() {
  let n = 0;
  const provider = vi.fn(async () => `ticket-${(n += 1)}`);
  return { provider };
}

function buildConn(
  ticketProvider: SharedWsConnectionDeps["ticketProvider"],
  overrides: Partial<SharedWsConnectionDeps> = {}
): { conn: SharedWsConnection; timers: ManualTimers } {
  const timers = new ManualTimers();
  FakeWebSocket.reset();
  const conn = new SharedWsConnection({
    wsFactory: (ticket) => new FakeWebSocket(`/ws/dashboard?ticket=${ticket}`),
    ticketProvider,
    setTimer: timers.set,
    clearTimer: timers.clear,
    ...overrides,
  });
  return { conn, timers };
}

/** 建连并等 ticket→socket 链走完，返回当前唯一 socket */
async function connectAndOpen(conn: SharedWsConnection): Promise<FakeWebSocket> {
  conn.acquire();
  await flushAsync();
  expect(FakeWebSocket.instances).toHaveLength(1);
  const ws = FakeWebSocket.last;
  ws.serverOpen();
  return ws;
}

beforeEach(() => {
  FakeWebSocket.reset();
});

describe("SharedWsConnection（共享单连接 + 引用计数）", () => {
  it("多次 acquire 只建一条连接，ticket 也只取一次", async () => {
    const { provider } = countingTicketProvider();
    const { conn } = buildConn(provider);

    conn.acquire();
    conn.acquire();
    conn.acquire();
    await flushAsync();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(conn.getStatus()).toBe(false); // 还没 open
    FakeWebSocket.last.serverOpen();
    expect(conn.getStatus()).toBe(true);
  });

  it("release 到 0 后过宽限期才关闭，宽限期默认 5s", async () => {
    const { provider } = countingTicketProvider();
    const { conn, timers } = buildConn(provider);
    const ws = await connectAndOpen(conn);

    conn.release();
    // 宽限期内：连接保留
    expect(ws.readyState).toBe(WS_OPEN);
    expect(conn.getStatus()).toBe(true);
    expect(timers.size).toBe(1);

    timers.advance();
    // 宽限期到：关闭，且延迟是默认 5000ms
    expect(ws.readyState).toBe(WS_CLOSED);
    expect(conn.getStatus()).toBe(false);
    expect(timers.delays).toEqual([5000]);
  });

  it("宽限期内重新 acquire 取消断开，不新建连接", async () => {
    const { provider } = countingTicketProvider();
    const { conn, timers } = buildConn(provider);
    const ws = await connectAndOpen(conn);

    conn.release();
    conn.acquire(); // 宽限期内回来
    expect(timers.size).toBe(0); // 断开定时器被取消

    timers.advance();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.readyState).toBe(WS_OPEN);
    expect(conn.getStatus()).toBe(true);

    // 再次 release 后过宽限期才真正关
    conn.release();
    timers.advance();
    expect(ws.readyState).toBe(WS_CLOSED);
  });

  it("ticket 在途时 release→重新 acquire 保持 single-flight，只发一次请求", async () => {
    let ticketCount = 0;
    let resolveTicket!: (ticket: string) => void;
    const ticketPromise = new Promise<string>((resolve) => {
      resolveTicket = resolve;
    });
    const { conn, timers } = buildConn(() => {
      ticketCount += 1;
      return ticketPromise;
    });

    conn.acquire(); // 票在途
    conn.release(); // 挂上宽限期定时器
    conn.acquire(); // 宽限期内重新 acquire：不能第二次取票
    await flushAsync();

    resolveTicket("t1");
    await flushAsync();

    expect(ticketCount).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(timers.size).toBe(0); // 宽限期定时器已被取消
    FakeWebSocket.last.serverOpen();
    expect(conn.getStatus()).toBe(true);
  });

  it("消息 fan-out：所有状态订阅者都收到；类型监听按 msg.type 精准派发且拿到原始 data 字符串", async () => {
    const { provider } = countingTicketProvider();
    const { conn } = buildConn(provider);
    await connectAndOpen(conn);

    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    const unsubA = conn.subscribeMessage((msg) => seenA.push(msg));
    conn.subscribeMessage((msg) => seenB.push(msg));

    const onlineEvents: string[] = [];
    const taskEvents: string[] = [];
    conn.addEventListener("agent.online", (event) => onlineEvents.push(String(event.data)));
    conn.addEventListener("task.update", (event) => taskEvents.push(String(event.data)));

    const raw1 = JSON.stringify({ type: "agent.online", agentId: 7 });
    const raw2 = JSON.stringify({ type: "task.update", taskId: 42 });
    FakeWebSocket.last.serverMessage(raw1);
    FakeWebSocket.last.serverMessage(raw2);

    expect(seenA).toEqual([
      { type: "agent.online", agentId: 7 },
      { type: "task.update", taskId: 42 },
    ]);
    expect(seenB).toEqual(seenA); // 两个订阅者都收到每条消息
    expect(onlineEvents).toEqual([raw1]); // 原始 data 字符串
    expect(taskEvents).toEqual([raw2]);

    unsubA();
    FakeWebSocket.last.serverMessage(JSON.stringify({ type: "agent.online", agentId: 8 }));
    expect(seenA).toHaveLength(2); // A 已退订
    expect(seenB).toHaveLength(3); // B 不受影响
  });

  it("断线且 refs>0：按 3s 退避自动重连（重新取票建新连接）", async () => {
    const { provider } = countingTicketProvider();
    const { conn, timers } = buildConn(provider);
    const ws1 = await connectAndOpen(conn);

    ws1.serverClose();
    expect(conn.getStatus()).toBe(false);
    expect(timers.size).toBe(1); // 重连定时器挂起

    timers.advance();
    await flushAsync();

    expect(provider).toHaveBeenCalledTimes(2); // 重连重新取票
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.last.url).toContain("ticket=ticket-2");
    expect(timers.delays).toEqual([3000]); // 默认退避 3s
    FakeWebSocket.last.serverOpen();
    expect(conn.getStatus()).toBe(true);
  });

  it("断线且 refs=0：不再重连，宽限期到后静默关闭", async () => {
    const { provider } = countingTicketProvider();
    const { conn, timers } = buildConn(provider);
    const ws1 = await connectAndOpen(conn);

    ws1.serverClose(); // 挂起重连定时器
    conn.release(); // refs=0，挂上宽限期定时器
    timers.advance(); // 先跑重连定时器（refs=0 → 不重连），再跑宽限期关闭
    await flushAsync();

    expect(provider).toHaveBeenCalledTimes(1); // 没有第二次取票
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws1.readyState).toBe(WS_CLOSED);
    expect(conn.getStatus()).toBe(false);

    timers.advance(); // 再推进也不应有任何新连接
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(timers.size).toBe(0);
  });

  it("无票（未登录）：不建连，仅挂 30s 低峰重试心跳", async () => {
    const provider = vi.fn(async () => null);
    const { conn, timers } = buildConn(provider);

    conn.acquire();
    await flushAsync();

    expect(FakeWebSocket.instances).toHaveLength(0); // 不建连
    expect(timers.delays).toEqual([30000]); // 低峰心跳 30s（重登成功后无需刷新即可恢复）
    expect(conn.getStatus()).toBe(false);
  });

  it("ticketProvider 瞬时失败：按退避重试，成功后建连", async () => {
    let n = 0;
    const provider = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("ws-ticket 503");
      return `ticket-${n}`;
    });
    const { conn, timers } = buildConn(provider);

    conn.acquire();
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(timers.size).toBe(1); // 失败 → 安排重试

    timers.advance();
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.last.serverOpen();
    expect(conn.getStatus()).toBe(true);
  });

  it("非法 JSON 消息：不炸订阅者，后续合法消息照常派发", async () => {
    const { provider } = countingTicketProvider();
    const { conn } = buildConn(provider);
    await connectAndOpen(conn);

    const seen: unknown[] = [];
    conn.subscribeMessage((msg) => seen.push(msg));
    const events: string[] = [];
    conn.addEventListener("agent.online", (event) => events.push(String(event.data)));

    expect(() => FakeWebSocket.last.serverMessage("<<not-json>>")).not.toThrow();
    expect(seen).toHaveLength(0);
    expect(events).toHaveLength(0);

    FakeWebSocket.last.serverMessage(JSON.stringify({ type: "agent.online" }));
    expect(seen).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it("类型监听抛错被隔离，不影响其他监听与状态订阅", async () => {
    const { provider } = countingTicketProvider();
    const { conn } = buildConn(provider);
    await connectAndOpen(conn);

    const seen: unknown[] = [];
    conn.subscribeMessage((msg) => seen.push(msg));
    const goodEvents: string[] = [];
    conn.addEventListener("boom", () => {
      throw new Error("listener exploded");
    });
    conn.addEventListener("boom", (event) => goodEvents.push(String(event.data)));

    expect(() =>
      FakeWebSocket.last.serverMessage(JSON.stringify({ type: "boom" }))
    ).not.toThrow();
    expect(seen).toHaveLength(1);
    expect(goodEvents).toHaveLength(1);
  });

  it("连接状态变化通知订阅者；send 仅在 OPEN 时发出", async () => {
    const { provider } = countingTicketProvider();
    const { conn } = buildConn(provider);

    const statuses: boolean[] = [];
    const unsub = conn.subscribeStatus(() => statuses.push(conn.getStatus()));

    const ws = await connectAndOpen(conn);
    conn.send('{"ping":1}'); // OPEN → 发出
    expect(ws.sent).toEqual(['{"ping":1}']);

    ws.serverClose();
    conn.send('{"ping":2}'); // 已断 → 丢弃
    expect(ws.sent).toEqual(['{"ping":1}']);

    expect(statuses).toEqual([true, false]); // open → true，close → false
    unsub();
    FakeWebSocket.last.serverOpen();
    expect(statuses).toEqual([true, false]); // 退订后不再通知
  });

  it('"message" 兼容槽：注册其上的监听对每条原始消息必达（两种 wire type 各一次）', async () => {
    const { provider } = countingTicketProvider();
    const { conn } = buildConn(provider);
    await connectAndOpen(conn);

    const raws: string[] = [];
    const typed: WsEventLike[] = [];
    conn.addEventListener("message", (event) => raws.push(String(event.data)));
    conn.addEventListener("online_agents", (event) => typed.push(event));

    const raw1 = JSON.stringify({ type: "online_agents", agents: [] });
    const raw2 = JSON.stringify({ type: "notification_created", id: 1 });
    FakeWebSocket.last.serverMessage(raw1);
    FakeWebSocket.last.serverMessage(raw2);

    expect(raws).toEqual([raw1, raw2]); // 与 wire type 无关，原始 event 必达
    // catch-all 与精准派发收到的是同一原始 event 本体（data 为原始字符串，
    // EventStream/OpsPanel 的 handler 据此自行 JSON.parse）
    expect(typed).toHaveLength(1);
    expect(typed[0].data).toBe(raw1);
  });

  it('"message" 兼容槽防双发：wire 消息自身 type==="message" 时恰好收到一次', async () => {
    const { provider } = countingTicketProvider();
    const { conn } = buildConn(provider);
    await connectAndOpen(conn);

    const raws: string[] = [];
    conn.addEventListener("message", (event) => raws.push(String(event.data)));

    const raw = JSON.stringify({ type: "message", payload: "x" });
    FakeWebSocket.last.serverMessage(raw);

    expect(raws).toEqual([raw]); // catch-all 与 type 查表对同一 listener 去重
  });

  it('"message" 兼容槽对非法 JSON 也必达（对齐旧版原生挂载语义）', async () => {
    const { provider } = countingTicketProvider();
    const { conn } = buildConn(provider);
    await connectAndOpen(conn);

    const raws: string[] = [];
    conn.addEventListener("message", (event) => raws.push(String(event.data)));

    expect(() => FakeWebSocket.last.serverMessage("<<broken>>")).not.toThrow();
    expect(raws).toEqual(["<<broken>>"]); // 解析失败不拦截原始事件投递
  });

  it("无票 30s 低峰重试：拿到票后自动建连（重登后无需刷新）", async () => {
    let n = 0;
    const provider = vi.fn(async () => {
      n += 1;
      return n === 1 ? null : `ticket-${n}`; // 首次未登录，30s 后「已完成重登」
    });
    const { conn, timers } = buildConn(provider);

    conn.acquire();
    await flushAsync();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(timers.delays).toEqual([30000]);

    timers.advance(); // 心跳到期，重走 ticket 流程
    await flushAsync();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    FakeWebSocket.last.serverOpen();
    expect(conn.getStatus()).toBe(true);
  });

  it("无票重试期间 release 到 0：心跳终止，不再取票", async () => {
    const provider = vi.fn(async () => null);
    const { conn, timers } = buildConn(provider);

    conn.acquire();
    await flushAsync();
    expect(provider).toHaveBeenCalledTimes(1);

    conn.release(); // 心跳 + 宽限期定时器并存
    timers.advance(); // 心跳回调遇 refs=0 终止；宽限期满静默关闭
    await flushAsync();

    expect(provider).toHaveBeenCalledTimes(1); // 不再取票
    expect(timers.size).toBe(0);
    timers.advance(); // 再推进也不恢复心跳
    await flushAsync();
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("迟到的旧 socket onclose 不影响新连接的 connected 状态", async () => {
    const { provider } = countingTicketProvider();
    const { conn, timers } = buildConn(provider);

    const wsA = await connectAndOpen(conn); // A 在线
    conn.release();
    timers.advance(); // 宽限期满，A 关闭
    expect(conn.getStatus()).toBe(false);

    conn.acquire(); // 重新订阅，换票建新连接 B
    await flushAsync();
    const wsB = FakeWebSocket.last;
    expect(wsB).not.toBe(wsA);
    wsB.serverOpen();
    expect(conn.getStatus()).toBe(true);

    wsA.onclose?.(); // 模拟真实浏览器里 A 的 close 事件迟到到达
    expect(conn.getStatus()).toBe(true); // 不得错打为断开
    expect(timers.size).toBe(0); // 也不得触发重连
  });
});
