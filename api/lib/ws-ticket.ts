/**
 * /ws/dashboard 握手用的一次性短期 ticket。
 *
 * 为什么需要它：浏览器原生 WebSocket 构造器不能设置自定义请求头，
 * 而前端 JWT 只存在 localStorage、登录又不下发 cookie，所以
 * dashboard WS 握手无法带 Authorization 头。解决方案是先用 JWT 调
 * GET /api/ws-ticket 换一个短期一次性 ticket，再放进 WS 的 query。
 * ticket 一次性 + 60s TTL，把"明文凭据出现在 URL"的暴露窗口压到最小。
 */
import { randomBytes } from "node:crypto";

export interface WsTicketPayload {
  userId: number;
  role: string;
}

interface TicketEntry extends WsTicketPayload {
  expiresAt: number;
}

export interface WsTicketStoreOptions {
  /** ticket 有效期，默认 60 秒 */
  ttlMs?: number;
  /** 时钟可注入，便于测试推进时间验证过期 */
  now?: () => number;
}

/** ticket 有效期（毫秒）。签发接口返回的 expiresIn 秒数由它派生，避免两处字面量各写一份 */
export const WS_TICKET_TTL_MS = 60_000;

export class WsTicketStore {
  private readonly tickets = new Map<string, TicketEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: WsTicketStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? WS_TICKET_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  issue(payload: WsTicketPayload): string {
    // 签发前顺手清理过期项：进程里没有任何定时任务会调用 pending()，
    // 用户签票后直接关页面就会留下永不消费的条目，长跑容器里会慢慢堆积。
    this.prune();
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, { ...payload, expiresAt: this.now() + this.ttlMs });
    return ticket;
  }

  /** 清理过期 ticket，返回清理条数（供 issue/pending 复用，也可单测） */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [ticket, entry] of this.tickets) {
      if (entry.expiresAt <= now) {
        this.tickets.delete(ticket);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * 消费 ticket：命中即删除（一次性，无论是否过期），
   * 未知 / 过期返回 null。重放旧 ticket 必须失败，
   * 否则 ticket 就退化成了长期有效的明文凭据。
   */
  consume(ticket: string): WsTicketPayload | null {
    if (!ticket) return null;
    const entry = this.tickets.get(ticket);
    if (!entry) return null;
    this.tickets.delete(ticket);
    if (entry.expiresAt <= this.now()) return null;
    return { userId: entry.userId, role: entry.role };
  }

  /** 未消费 ticket 数量；顺手清理过期项，避免 Map 只增不减 */
  pending(): number {
    this.prune();
    return this.tickets.size;
  }
}

/**
 * Dashboard WS 握手的 Origin 校验（防 CSWSH）。
 *
 * origin 为空时放行是有意的：非浏览器客户端（curl/脚本）不发送 Origin，
 * 而跨站 WebSocket 劫持（CSWSH）只会发生在浏览器里——浏览器握手中
 * Origin 由浏览器强制带上且页面无法伪造，因此"无 Origin"不构成浏览器攻击面。
 */
export function isAllowedWsOrigin(
  origin: string | null,
  host: string | null,
  allowList: readonly string[]
): boolean {
  if (!origin) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  if (host && originHost === host) return true;
  return allowList.includes(origin) || allowList.includes(originHost);
}

/** 进程内单例：/api/ws-ticket 签发、/ws/dashboard 消费 */
export const wsTicketStore = new WsTicketStore();
