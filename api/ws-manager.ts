/**
 * 天宫 WebSocket 连接管理器
 *
 * 参考女娲 Agent Hub ws_manager.py 的 ConnectionManager 类。
 * 管理 Agent 的 WebSocket 连接，支持单 Agent 多连接（多设备），
 * 提供点对点推送和广播功能。
 */

import type { WSContext } from "hono/ws";

/**
 * WebSocket 连接管理器。
 *
 * 维护 agentId → [WebSocket] 的映射，支持：
 * - connect: 注册连接
 * - disconnect: 移除连接
 * - sendToAgent: 推送给指定 Agent 的所有连接
 * - broadcast: 广播给所有在线 Agent
 * - broadcastToDashboard: 广播给所有 Dashboard 客户端
 * - getOnlineAgents: 获取在线 Agent ID 列表
 * - isOnline: 检查 Agent 是否在线
 */
class WSManager {
  private connections: Map<number, WSContext[]> = new Map();
  private dashClients: Set<WSContext> = new Set();

  /**
   * 注册 Agent WebSocket 连接。
   * 单 Agent 支持多连接（多设备）。
   */
  connect(agentId: number, ws: WSContext): void {
    const existing = this.connections.get(agentId);
    if (existing) {
      existing.push(ws);
    } else {
      this.connections.set(agentId, [ws]);
    }
  }

  /**
   * 移除 Agent WebSocket 连接。
   * 当该 Agent 的所有连接都断开时，从 Map 中删除。
   */
  disconnect(agentId: number, ws: WSContext): void {
    const existing = this.connections.get(agentId);
    if (!existing) return;

    const idx = existing.indexOf(ws);
    if (idx !== -1) {
      existing.splice(idx, 1);
    }

    if (existing.length === 0) {
      this.connections.delete(agentId);
    }
  }

  /**
   * 推送 JSON 消息给指定 Agent 的所有连接。
   * 发送失败时自动清理死连接。
   */
  async sendToAgent(agentId: number, message: object): Promise<void> {
    const connections = this.connections.get(agentId);
    if (!connections || connections.length === 0) return;

    const dead: WSContext[] = [];
    const payload = JSON.stringify(message);

    for (const ws of connections) {
      try {
        ws.send(payload);
      } catch {
        dead.push(ws);
      }
    }

    // 清理死连接
    if (dead.length > 0) {
      const remaining = this.connections.get(agentId);
      if (remaining) {
        for (const ws of dead) {
          const idx = remaining.indexOf(ws);
          if (idx !== -1) remaining.splice(idx, 1);
        }
        if (remaining.length === 0) {
          this.connections.delete(agentId);
        }
      }
    }
  }

  /**
   * 广播 JSON 消息给所有在线 Agent。
   */
  async broadcast(message: object): Promise<void> {
    const agentIds = Array.from(this.connections.keys());
    for (const agentId of agentIds) {
      await this.sendToAgent(agentId, message);
    }
  }

  /**
   * 广播 JSON 消息给所有 Dashboard 客户端。
   * 发送失败时自动清理死连接。
   */
  broadcastToDashboard(message: object): void {
    const payload = JSON.stringify(message);
    const dead: WSContext[] = [];

    for (const ws of this.dashClients) {
      try {
        ws.send(payload);
      } catch {
        dead.push(ws);
      }
    }

    for (const ws of dead) {
      this.dashClients.delete(ws);
    }
  }

  /**
   * 注册 Dashboard 客户端。
   */
  registerDashboard(ws: WSContext): void {
    this.dashClients.add(ws);
  }

  /**
   * 移除 Dashboard 客户端。
   */
  unregisterDashboard(ws: WSContext): void {
    this.dashClients.delete(ws);
  }

  /**
   * 返回当前在线 Agent ID 列表。
   */
  getOnlineAgents(): number[] {
    return Array.from(this.connections.keys());
  }

  /**
   * 检查 Agent 是否在线（有活跃 WebSocket 连接）。
   */
  isOnline(agentId: number): boolean {
    const conns = this.connections.get(agentId);
    return conns !== undefined && conns.length > 0;
  }
}

// 全局连接管理器单例
export const wsManager = new WSManager();
