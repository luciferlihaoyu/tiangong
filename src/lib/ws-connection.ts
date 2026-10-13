/**
 * SharedWsConnection — 模块级共享单连接 + 多路分发。
 *
 * 背景：useWebSocket 原为「每组件各建一条 WS + 各取一次性 ticket + 各自重连」，
 * 十余个调用点造成同一事件重复派发、ticket 与连接数随组件数翻倍。
 * 本类把连接收敛为一条：引用计数（acquire/release）驱动建连与延迟断开，
 * 消息统一 JSON 安全解析后按「状态订阅者 fan-out + 类型监听精准派发」分发。
 *
 * 设计约束：
 * - 纯逻辑、可注入依赖（wsFactory / ticketProvider / 定时器），node 环境可测。
 * - 同一时刻至多一条 socket + 一个在途 ticket 请求（single-flight）。
 * - 无票（未登录/会话过期）不连接，refs>0 时每 30s 低峰重试（重登后自愈）；
 *   瞬时失败按 3s 退避重试；断线自动重连仅在 refs>0 时持续。
 * - "message" 类型监听是 DOM 事件名兼容槽（catch-all），每条原始消息必达。
 */

/** 底层 socket 最小结构面（真实 WebSocket 结构兼容；测试注入 FakeWebSocket） */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: WsEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** 消息事件最小形状（真实环境即 MessageEvent，data 为原始字符串） */
export interface WsEventLike {
  data: unknown;
}

/** 可注入定时器句柄（浏览器为 number，node 为 Timeout——本类只透传） */
export type TimerHandle = ReturnType<typeof setTimeout>;

export type WsStatusListener = () => void;
/** 状态订阅者：每条成功解析的消息都会收到（hook 用它更新 lastMessage） */
export type WsMessageListener = (message: unknown) => void;
/** 类型监听者：等价旧 addEventListener(type, listener)，收到原始事件形态 */
export type WsTypeListener = (event: WsEventLike) => void;

export interface SharedWsConnectionDeps {
  /** 由一次性 ticket 建立底层 socket（URL 拼装是浏览器环境细节，归调用方） */
  wsFactory: (ticket: string) => WsLike;
  /**
   * 换取一次性 ticket：
   * - resolve string → 带 ticket 建连；
   * - resolve null   → 无 token / 401（不连接，refs>0 时按低峰间隔重试）；
   * - reject         → 瞬时失败（按退避重试）。
   */
  ticketProvider: () => Promise<string | null>;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** 断线重连退避，默认 3000ms（对齐旧实现） */
  reconnectDelayMs?: number;
  /** 无票（未登录/401）后的低峰重试间隔，默认 30000ms——refs>0 期间持续，重登成功后无需刷新即可恢复 */
  noTicketRetryDelayMs?: number;
  /** 引用归零后的延迟断开宽限期，默认 5000ms（吸收路由切换抖动） */
  gracePeriodMs?: number;
}

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/** 从解析后的消息里只关心 type 的最小形状 */
interface ParsedMessageShape {
  type?: unknown;
}

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_NO_TICKET_RETRY_MS = 30000;
const DEFAULT_GRACE_PERIOD_MS = 5000;

/**
 * "message" 兼容槽：旧实现把 addEventListener 的 listener 原生挂到 WebSocket
 * （"message" 是 DOM 事件名，每条原始消息必达），OpsPanel/EventStream 依赖该语义。
 * 共享连接里由 handleMessage 对该 key 做 catch-all 派发来等价复刻。
 */
export const WS_EVENT_NAME_CATCH_ALL = "message";

export class SharedWsConnection {
  private readonly wsFactory: SharedWsConnectionDeps["wsFactory"];
  private readonly ticketProvider: SharedWsConnectionDeps["ticketProvider"];
  private readonly setTimer: NonNullable<SharedWsConnectionDeps["setTimer"]>;
  private readonly clearTimer: NonNullable<SharedWsConnectionDeps["clearTimer"]>;
  private readonly reconnectDelayMs: number;
  private readonly noTicketRetryDelayMs: number;
  private readonly gracePeriodMs: number;

  /** 引用计数：>0 即有活跃 hook 实例 */
  private refs = 0;
  /** 当前唯一 socket（含 CONNECTING 阶段）；null = 无连接 */
  private socket: WsLike | null = null;
  /** ticket 请求在途标记（single-flight），同步置位/复位 */
  private connectingTicket = false;
  private closeTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private noTicketRetryTimer: TimerHandle | null = null;
  private connected = false;

  private readonly statusListeners = new Set<WsStatusListener>();
  private readonly messageListeners = new Set<WsMessageListener>();
  private readonly typeListeners = new Map<string, Set<WsTypeListener>>();

  constructor(deps: SharedWsConnectionDeps) {
    this.wsFactory = deps.wsFactory;
    this.ticketProvider = deps.ticketProvider;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    this.reconnectDelayMs = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.noTicketRetryDelayMs = deps.noTicketRetryDelayMs ?? DEFAULT_NO_TICKET_RETRY_MS;
    this.gracePeriodMs = deps.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
  }

  /* —— 供 useSyncExternalStore 使用的稳定订阅面（箭头属性保证引用恒定） —— */
  readonly getStatus = (): boolean => this.connected;

  readonly subscribeStatus = (listener: WsStatusListener): (() => void) => {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  };

  /** 引用计数 +1；0→1 时取消宽限断开并确保连接存在 */
  acquire(): void {
    this.refs += 1;
    if (this.refs === 1) {
      this.cancelCloseTimer();
      this.ensureConnected();
    }
  }

  /** 引用计数 -1；归零后进入宽限期，期满才真正断开 */
  release(): void {
    this.refs = Math.max(0, this.refs - 1);
    if (this.refs === 0) {
      this.scheduleClose();
    }
  }

  /**
   * 类型监听注册：按 wire 消息的 msg.type 精准派发；"message"
   * （{@link WS_EVENT_NAME_CATCH_ALL}）为 DOM 事件名兼容槽（catch-all），
   * 每条原始消息必达——listener 收到的是原始 MessageEvent 本体，data 为
   * 原始字符串，**由调用方自行 JSON.parse**（对齐旧实现）。
   *
   * ⚠️ 生命周期契约（相对旧实现的差异）：旧版 listener 挂在组件自己的 socket 上，
   * 随组件实例一起被 GC；本注册表挂在模块级共享连接上、与组件生命周期解耦，
   * **调用点必须配对 removeEventListener**（useEffect cleanup 等），否则监听器
   * 连同其闭包捕获的整棵组件状态将永久泄漏。无运行时防护，靠契约自觉。
   */
  addEventListener(type: string, listener: WsTypeListener): void {
    const listeners = this.typeListeners.get(type) ?? new Set<WsTypeListener>();
    listeners.add(listener);
    this.typeListeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: WsTypeListener): void {
    this.typeListeners.get(type)?.delete(listener);
  }

  /** 状态订阅者注册：每条成功解析的消息 fan-out 一份（hook 据此更新 lastMessage） */
  subscribeMessage(listener: WsMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  /** 仅在 socket OPEN 时发出（等价旧 send 行为） */
  send(data: string): void {
    const ws = this.socket;
    if (ws && ws.readyState === WS_OPEN) {
      ws.send(data);
    }
  }

  /* —— 内部：建连 —— */

  /**
   * 确保存在连接。幂等：已有 socket（含 CONNECTING/CLOSING）或 ticket 在途时直接返回，
   * 因此重连定时器触发、宽限期内重新 acquire 等多入口并发调用都安全。
   */
  private ensureConnected(): void {
    if (this.refs === 0) return; // 无订阅者不连接、不重试
    // 主动建连意图出现（含 30s 心跳到期自唤）：低峰心跳作废——要么立即连上，
    // 要么本次取票仍无票时重新挂心跳（openSocket null 分支负责）。
    this.cancelNoTicketRetry();
    if (this.socket && this.socket.readyState !== WS_CLOSED) return;
    if (this.connectingTicket) return; // single-flight：在途请求复用
    this.cancelReconnectTimer();
    this.connectingTicket = true; // 必须同步置位，挡住同一轮内的并发入口
    void this.openSocket();
  }

  private async openSocket(): Promise<void> {
    let ticket: string | null;
    try {
      ticket = await this.ticketProvider();
    } catch (err) {
      this.connectingTicket = false;
      console.warn("[WS Dashboard] Failed to fetch ws ticket:", err);
      this.scheduleReconnect();
      return;
    }
    this.connectingTicket = false;

    if (ticket == null) {
      // 无 token / 401：立即重试不可能成功，但也不能永久停手——
      // AppLayout 常驻使 refs 恒 ≥1，重登成功（token 更新但组件不重挂载）后
      // 靠 30s 低峰心跳自愈，拿到票即连；refs 归 0 则随 teardown 终止。
      this.warnNoTicket();
      if (this.refs > 0) this.scheduleNoTicketRetry();
      return;
    }
    if (this.refs === 0) return; // 等票期间被 release（宽限期中），不再建连
    if (this.socket) return; // 防御：他处已建连

    try {
      const ws = this.wsFactory(ticket);
      this.socket = ws;

      ws.onopen = () => {
        if (ws === this.socket) this.setConnected(true);
      };
      ws.onmessage = (event) => {
        if (ws === this.socket) this.handleMessage(event);
      };
      ws.onerror = (err) => {
        console.warn("[WS Dashboard] Error:", err);
        // onclose 随后触发，统一走重连路径
      };
      ws.onclose = () => {
        // 早退守卫：非当前 socket 的 close（如宽限期关闭、真实浏览器里迟到的
        // 旧 close 事件）一律忽略——既不动状态，也不触发重连
        if (ws !== this.socket) return;
        this.socket = null;
        this.setConnected(false);
        // 仅仍有订阅者时重连；refs=0（宽限期关闭/已卸载）就此打住
        if (this.refs > 0) this.scheduleReconnect();
      };
    } catch (err) {
      console.warn("[WS Dashboard] Failed to create WebSocket:", err);
      this.scheduleReconnect();
    }
  }

  /* —— 内部：断开与重连 —— */

  private scheduleClose(): void {
    this.cancelCloseTimer();
    this.closeTimer = this.setTimer(() => {
      this.closeTimer = null;
      this.teardown();
    }, this.gracePeriodMs);
  }

  /** 宽限期期满：真正断开。期间重新 acquire 会先取消本定时器。 */
  private teardown(): void {
    this.cancelReconnectTimer();
    this.cancelNoTicketRetry(); // refs=0 期间不再低峰重试
    const ws = this.socket;
    this.socket = null;
    if (ws && ws.readyState !== WS_CLOSED && ws.readyState !== WS_CLOSING) {
      ws.close(); // onclose 里收敛 connected 状态
    }
    this.setConnected(false);
  }

  private scheduleReconnect(): void {
    this.cancelReconnectTimer();
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.ensureConnected(); // 内部校验 refs>0，refs=0 时静默终止
    }, this.reconnectDelayMs);
  }

  /** 无票低峰心跳：refs>0 期间每 30s 重走一次 ticket 流程，拿到票即连 */
  private scheduleNoTicketRetry(): void {
    this.cancelNoTicketRetry();
    this.noTicketRetryTimer = this.setTimer(() => {
      this.noTicketRetryTimer = null;
      this.ensureConnected(); // refs=0 时静默终止
    }, this.noTicketRetryDelayMs);
  }

  private cancelNoTicketRetry(): void {
    if (this.noTicketRetryTimer != null) {
      this.clearTimer(this.noTicketRetryTimer);
      this.noTicketRetryTimer = null;
    }
  }

  private cancelCloseTimer(): void {
    if (this.closeTimer != null) {
      this.clearTimer(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer != null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /* —— 内部：消息分发 —— */

  /**
   * 统一入口。三路分发：
   * ① 状态订阅者 fan-out（仅成功解析的消息，hook 据此更新 lastMessage）；
   * ② "message" 兼容槽 catch-all——每条到达消息（含非法 JSON）必达，复刻旧实现
   *    原生挂到 WebSocket 的 DOM 事件语义；wire 消息自身 type==="message" 时
   *    由下方去重逻辑保证只投递一次（防双发）；
   * ③ 按 wire msg.type 精准派发（等价旧 listenersRef.get(data.type) 语义）。
   */
  private handleMessage(event: WsEventLike): void {
    let parsed: ParsedMessageShape | null = null;
    let parseOk = false;
    try {
      parsed = JSON.parse(event.data as string) as ParsedMessageShape | null;
      parseOk = true;
    } catch {
      console.warn("[WS Dashboard] Failed to parse message:", event.data);
    }

    if (parseOk) {
      for (const listener of [...this.messageListeners]) {
        try {
          listener(parsed);
        } catch (err) {
          console.warn("[WS Dashboard] Message listener threw:", err);
        }
      }
    }

    const type = parseOk && typeof parsed?.type === "string" ? parsed.type : null;
    if (type !== WS_EVENT_NAME_CATCH_ALL) {
      // catch-all：每条原始消息必达；type==="message" 时跳过，由精准派发兜住
      this.dispatchType(WS_EVENT_NAME_CATCH_ALL, event);
    }
    if (type !== null) {
      this.dispatchType(type, event);
    }
  }

  /** 向指定 key 的类型监听派发原始事件；单个监听抛错被隔离 */
  private dispatchType(type: string, event: WsEventLike): void {
    const listeners = this.typeListeners.get(type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (err) {
        console.warn(`[WS Dashboard] Listener for "${type}" threw:`, err);
      }
    }
  }

  /* —— 内部：状态广播 —— */

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    for (const listener of [...this.statusListeners]) {
      try {
        listener();
      } catch (err) {
        console.warn("[WS Dashboard] Status listener threw:", err);
      }
    }
  }

  private warnNoTicket(): void {
    console.warn("[WS Dashboard] No ticket (not authenticated), skip connect");
  }
}
