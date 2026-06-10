# Spec: 天宫 WebSocket 实时通信

> 将女娲 Agent Hub 的 WebSocket 实时通信能力合并到天宫
> 2026-06-10

## 概述
天宫当前只有 HTTP REST 消息系统（0 条消息），女娲有完整的 WebSocket 实时通信（MAAP 协议 + 离线队列 + 在线状态）。把女娲的核心能力搬到天宫，让 Agent 间能实时通信。

## 🎨 设计品味
- Design Read：管理平台内部功能增强，非前端页面，跳过 taste-skill
- 三 Dial：N/A（后端功能）

## 功能清单

### P0 — 核心 WebSocket
- [ ] **WebSocket 连接管理** — 参考 `ws_manager.py`，用 Hono 原生 WebSocket 实现
  - Agent 连接/断开管理
  - 单 Agent 多连接支持
  - 在线状态自动同步（连接→online，断开→idle）
  - Dashboard 客户端广播通道
- [ ] **WebSocket 端点** — `GET /ws?agentId=X&token=Y`
  - Agent Token 认证（复用 MCP Key 体系）
  - 心跳保活（ping/pong）
- [ ] **消息实时推送** — 发送消息时自动 WebSocket 推送给在线目标
  - 消息送达状态：sent → delivered（WebSocket 推送成功）
  - Dashboard 实时通知

### P1 — 消息增强
- [ ] **消息已读标记** — `PATCH /api/trpc/message.markRead`
- [ ] **对话记录** — 两人之间的双向消息历史
- [ ] **离线消息队列** — Agent 上线时自动推送未读消息
- [ ] **广播消息** — 向所有在线 Agent 广播

### P2 — 前端消息面板
- [ ] **实时消息列表** — WebSocket 连接 Dashboard，新消息实时出现
- [ ] **Agent 在线状态实时更新** — 不用等 30 秒轮询
- [ ] **消息对话视图** — 点击 Agent 查看对话历史

## 技术方案

### 架构变更
```
天宫 v3 后端
├── Hono HTTP (现有)
│   ├── tRPC 路由
│   └── MCP 路由
└── Hono WebSocket (新增)
    ├── /ws — Agent WebSocket 端点
    └── /ws/dashboard — Dashboard 实时推送
```

### WebSocket 连接管理器
新建 `api/ws-manager.ts`：
```typescript
class WSManager {
  private connections: Map<number, WebSocket[]>  // agentId → [ws]
  private dashClients: Set<WebSocket>

  connect(agentId: number, ws: WebSocket): void
  disconnect(agentId: number, ws: WebSocket): void
  sendToAgent(agentId: number, message: object): Promise<void>
  broadcast(message: object): Promise<void>
  broadcastToDashboard(message: object): void
  getOnlineAgents(): number[]
  isOnline(agentId: number): boolean
}
```

### 消息路由增强
修改 `api/message-router.ts`：
- `send` mutation 成功后 → 调用 `wsManager.sendToAgent()` 实时推送
- 新增 `markRead` mutation
- 新增 `conversation` query（两人对话）
- 新增 `broadcast` mutation

### 数据库变更
messages 表新增字段：
- `status` — enum('sent','delivered','read')，默认 'sent'
- `read_at` — timestamp，已读时间

### 前端
- Dashboard 新增 WebSocket 连接（`useWebSocket` hook）
- Agent 卡片在线状态实时更新
- 消息面板 Tab（替换当前空状态）

## 任务拆解
- [ ] Task 1: `api/ws-manager.ts` — WebSocket 连接管理器（参考 ws_manager.py）
- [ ] Task 2: `api/boot.ts` — 注册 WebSocket 路由 `/ws`
- [ ] Task 3: `api/message-router.ts` — 消息发送后 WebSocket 推送 + markRead + conversation
- [ ] Task 4: `db/schema.ts` — messages 表加 status/read_at 字段 + 迁移
- [ ] Task 5: 前端 `useWebSocket` hook + Agent 在线状态实时更新
- [ ] Task 6: 前端消息面板（实时消息列表 + 对话视图）
- [ ] Task 7: 构建验证 + 端到端测试

## 验收标准
- [ ] Agent 通过 WebSocket 连接后，Dashboard 显示 🟢 已连接（实时，不等轮询）
- [ ] 发送消息给在线 Agent → 目标 Agent 实时收到 WebSocket 推送
- [ ] 发送消息给离线 Agent → 消息存入数据库，Agent 上线后自动推送
- [ ] Dashboard 消息面板实时显示新消息
- [ ] `npm run build` 通过

## 风险与 Plan B
- [A2] Hono WebSocket 在 Zeabur 上可能有限制 → Plan B: 降级为 SSE (Server-Sent Events)
- [A1] MySQL 迁移加字段可能失败 → Plan B: 用 ALTER TABLE 手动执行
