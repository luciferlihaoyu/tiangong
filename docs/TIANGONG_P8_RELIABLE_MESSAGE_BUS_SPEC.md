# TIANGONG P8.1 — 可靠消息总线 (Reliable Message Bus)

> **状态**: 实现完成 ✅  
> **日期**: 2026-06-14  
> **依赖**: P1 (天宫 Core), P2 (Connector)

## 1. 概述

P8.1 为天宫多 Agent 协作提供**可靠消息总线**基础设施：幂等发送、消息关联、Inbox 队列、ACK 确认、过期回收、离线补偿。后续 P8.2+ 将在此基础上实现协作任务拆解和分布式执行。

### 核心能力

| 能力 | 说明 |
|------|------|
| **幂等发送** | `fromAgent + idempotencyKey` 唯一约束，重复发送返回已有 messageId |
| **消息关联** | `correlationId` 串联对话，`parentMessageId` 构建回复链，`taskId` 关联任务 |
| **Inbox 队列** | `message.inbox` 获取待处理消息（按优先级降序、时间升序） |
| **ACK 确认** | `message.ack` 幂等确认，已 ack 重复调用无副作用 |
| **过期回收** | `expiresAt` 超时标记 `status=expired`，inbox 自动过滤 |
| **离线补偿** | `replayUndelivered` 重推未投递消息，记录 `retryCount` |
| **WebSocket 推送** | 推送时写 `deliveredAt`，离线消息全部推送 |

## 2. 数据模型

### messages 表新增字段

```sql
ALTER TABLE messages
  ADD COLUMN correlation_id VARCHAR(64) NULL,
  ADD COLUMN idempotency_key VARCHAR(128) NULL,
  ADD COLUMN task_id BIGINT UNSIGNED NULL,
  ADD COLUMN parent_message_id BIGINT UNSIGNED NULL,
  ADD COLUMN expires_at TIMESTAMP NULL,
  ADD COLUMN acked_at TIMESTAMP NULL,
  ADD COLUMN delivered_at TIMESTAMP NULL,
  ADD COLUMN retry_count INT DEFAULT 0 NOT NULL,
  ADD COLUMN priority INT DEFAULT 0 NOT NULL;

-- 幂等唯一索引
CREATE UNIQUE INDEX uq_messages_idempotency ON messages (from_agent, idempotency_key);

-- type ENUM 扩展
ALTER TABLE messages MODIFY COLUMN type
  ENUM('command','response','broadcast','system','ack') DEFAULT 'command' NOT NULL;

-- status ENUM 扩展
ALTER TABLE messages MODIFY COLUMN status
  ENUM('sent','delivered','read','acked','expired') DEFAULT 'sent' NOT NULL;
```

### 字段语义

| 字段 | 类型 | 说明 |
|------|------|------|
| `correlationId` | VARCHAR(64) | 逻辑事务/对话关联标识，同一次交互共享 |
| `idempotencyKey` | VARCHAR(128) | 发送方定义的幂等键，同一 fromAgent 唯一 |
| `taskId` | BIGINT | 关联的任务 ID（nullable） |
| `parentMessageId` | BIGINT | 回复链中的父消息 ID |
| `expiresAt` | TIMESTAMP | 消息过期时间，超期不再投递 |
| `ackedAt` | TIMESTAMP | 接收方确认时间 |
| `deliveredAt` | TIMESTAMP | 首次成功推送给接收方的时间 |
| `retryCount` | INT | 投递重试次数 |
| `priority` | INT | 优先级（越大越优先），默认 0 |

### 状态机

```
sent ──(WS push)──> delivered ──(read)──> read
  │                    │
  │                    └──(ack)──> acked
  │
  └──(expire)──> expired
```

## 3. API

### 3.1 message.send（增强）

**幂等发送**：同 `fromAgent + idempotencyKey` 返回已有 `messageId`。

```ts
input: {
  fromAgent: number;
  toAgent: number;
  content: string;           // 1-5000 chars
  type: "command"|"response"|"broadcast"|"system"|"ack";  // default "command"
  // P8.1 新字段
  correlationId?: string;     // max 64
  idempotencyKey?: string;    // max 128
  taskId?: number;
  parentMessageId?: number;
  priority?: number;          // default 0
  expiresAt?: string;         // ISO timestamp
  conversationId?: number;
}

// 返回
{ success: true, messageId: number, idempotent: boolean }
```

### 3.2 message.inbox（新增）

获取指定 Agent 的待处理消息（status = sent/delivered，未过期）。

```ts
input: {
  agentId: number;
  limit?: number;        // 1-200, default 50
  includeAcked?: boolean; // default false
}

// 返回 Message[]（按 priority DESC, created_at ASC）
```

### 3.3 message.ack（新增）

幂等确认。已 ack 的消息重复调用返回 `idempotent: true`。

```ts
input: {
  messageId: number;
  agentId?: number;
}

// 返回
{
  success: boolean;
  messageId: number;
  idempotent: boolean;
  ackedAt?: string;
  status: "acked"|"expired";
}
```

### 3.4 message.replayUndelivered（新增）

获取并选择性重推未投递消息。

```ts
input: {
  agentId: number;
  limit?: number;         // 1-200, default 100
  triggerReplay?: boolean; // default false
}

// 返回
{
  undelivered: Message[];
  count: number;
  replayed: number;          // 成功重推数
  expiredDuringReplay: number; // 重推期间过期数
}
```

### 3.5 message.stats（增强）

```ts
// 返回新增 byStatus 分组
{
  total: number;
  byStatus: {
    sent: number;
    delivered: number;
    read: number;
    acked: number;
    expired: number;
  }
}
```

## 4. WebSocket 推送增强

### 离线消息推送
- Agent 上线时推送 `offline_messages`，同时设置 `status=delivered` + `deliveredAt=now()`
- 每条消息包含完整字段（包括 P8.1 新字段）

### 实时消息推送
- `message.send` 调用后立即推送完整消息
- 推送成功更新 `status=delivered` + `deliveredAt`
- Dashboard 推送 `new_message` 事件

### 新事件类型
- `message_acked`：消息被确认时通知发送方和 Dashboard

## 5. Connector 增强

### 5.1 InboxProcessor（新增）
- `DedupTracker`：在内存中跟踪已处理消息，5 分钟过期清理
- `InboxProcessor.processBatch()`：批量处理消息管道
  1. 过滤已处理（dedup by messageId）→ skip
  2. 标记已处理
  3. 发送 ACK（message.ack，幂等）
  4. 对于 command 消息：自动回复 ACK（mock 模式安全）

### 5.2 离线消息处理
- 收到 `offline_messages` WS 事件时通过 inbox 统一处理
- 只 ACK，不自动处理 command（防止离线积压消息自动调用 OpenClaw）

### 5.3 实时消息处理
- 收到 `message` WS 事件时通过 inbox 去重 + ACK
- 跳过自己的消息（fromAgent === agentId）

### 5.4 心跳集成
- 每次心跳同时触发 inbox 拉取（`message.inbox`）

## 6. 向后兼容

- 所有 P8.1 新增字段均为 `NULL` 或默认值，不影响现有消息
- `type` 和 `status` ENUM 扩展向后兼容（新增值）
- `message.send` 的 `idempotencyKey` 为可选，不提供时行为与 P7 一致
- `message.list/listByAgent/conversation/broadcast/markRead` 保持不变

## 7. 验证

```bash
npm run check          # TypeScript 类型检查
npm run build          # 构建
node --check scripts/openclaw-connector/connector.mjs  # Connector 语法检查
```

## 8. 限制与下一步

### P8.1 已知限制
- `DedupTracker` 在内存中，connector 重启后丢失；重复消息会被服务器侧幂等 ACK 阻止
- `retryCount` 递增但未实现自动定期重推调度
- `expiresAt` 过期消息需定期清理或依赖查询过滤
- `correlationId` 语义未在查询层暴露（待 P8.2）

### P8.2 展望
- 基于消息总线的任务拆解与分发
- `correlationId` 追踪完整任务链
- `parentMessageId` 树形查询
- 死信队列（DLQ）

## 9. 变更文件

| 文件 | 变更 |
|------|------|
| `db/schema.ts` | 新增 P8.1 字段 + uniqueIndex |
| `api/lib/auto-migrate.ts` | messages 表完整 DDL（含新字段） |
| `api/lib/migrate-v2.ts` | ALTER TABLE + ENUM 修改 + unique index |
| `api/message-router.ts` | 增强 send（幂等）/ 新增 inbox/ack/replayUndelivered/stats 增强 |
| `api/boot.ts` | WS 推送时写 deliveredAt |
| `scripts/openclaw-connector/connector.mjs` | InboxProcessor + DedupTracker + 统一消息处理 |
