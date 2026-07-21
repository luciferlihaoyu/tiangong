# Tiangong P10：Ops / Guard + Fusion 审查模式 + 事件流规范

## 概述

P10 将天宫的运行监控、模型成本管控、多模型审查和实时事件追踪整理为可验证的运维能力。本规范根据现有前端页面、tRPC 路由、数据库 schema、WebSocket 实现和 `TIANGONG_CONNECTOR_GUIDE.md` 编写，不新增代码中无法确认的业务行为。

P10 包含三个模块：

1. **P10.1 Ops / Guard**：Ops 提供 Agent、任务、模型调用和成本概览，Guard 提供高价模型白名单、临时授权和预算守卫。
2. **P10.2 Fusion Review Mode**：系统选择 2 至 5 个可用 Agent 并行审查，再由 Judge 汇总并生成最终裁决。
3. **P10.3 Event Stream**：通过 Dashboard WebSocket 接收事件，支持类型筛选、traceId 串联和事件详情查看。

| 模块 | 责任 | 前端入口 | 后端接口或实现 | 数据来源 |
|------|------|----------|----------------|----------|
| **P10.1 Ops** | Agent 拓扑、任务流、模型调用、近七天成本 | `/ops` | `ops.*` tRPC、`/ws/dashboard` | `agents`、`tasks`、`token_usage` |
| **P10.1 Guard** | 高价模型判定、白名单、授权、预算守卫 | `/guard` | `guard.*` tRPC | `model_allowlist`、`high_cost_model_auth`、`token_usage`、`agents` |
| **P10.2 Fusion** | 多模型并行审查、结果和 Judge 裁决 | `/fusion` | `fusion.*` tRPC、Agent WebSocket | `messages`、`agents` |
| **P10.3 Event Stream** | 事件接收、过滤、详情和链路分组 | `/events` | `/ws/dashboard`、`event-bus.ts` | 浏览器内存缓冲 |

除特别说明外，本文的“路由”指 tRPC procedure，均由 `api/router.ts` 注册到 `appRouter`。

---

## 1. P10.1 Ops / Guard

### 1.1 设计范围

Ops 是只读聚合视图，不直接修改 Agent、任务或用量。Guard 管理白名单和授权，并在用量记录前检查高价模型和预算。页面和三个 P10 router 均不直接读取环境变量，依赖的共享运行变量见第 7 节。

### 1.2 OpsPanel 前端

文件：`src/pages/OpsPanel.tsx`。页面标题为“OPS 作战室”，通过六个查询取得数据，查询默认 `retry: 1`、`staleTime: 10_000`。

#### 1.2.1 今日概览

`ops.todayOverview` 提供 Agent、任务和当天用量摘要。七张卡片及来源如下：

| 卡片 | 值或计算 |
|------|----------|
| 在线 Agent | `agents.online + agents.busy` |
| 今日任务 | `done + running + pending` |
| 今日 Token | `usage.totalTokens` |
| 今日成本 | `usage.costCents` |
| 运行中 | `tasks.running` |
| 排队中 | `queued + pending` |
| 失败 | `tasks.failed` |

用户点击“刷新”时，概览、Agent、任务统计、最近任务、最近模型调用和热力图全部重新请求。

#### 1.2.2 Agent 在线拓扑

`ops.agentStatus` 返回数据库 ID、业务 Agent ID、名称、状态、模型、当前任务、最后心跳、已用金额和预算。后端以五分钟为心跳超时阈值计算 `heartbeatOk`，以 `spentCents / budgetCents * 100` 计算 `budgetUsed`。

卡片展示名称或 Agent ID、`online`、`busy`、`idle` 状态、模型、任务摘要、心跳时间、心跳是否正常及预算比例。心跳异常显示告警标识。该区域没有写操作。

#### 1.2.3 任务流

`ops.taskStats` 按状态统计数量，页面展示 `queued`、`pending`、`running`、`done` 和 `failed`。`ops.recentTasks` 默认请求十条最近任务，显示名称、业务任务 ID、状态、优先级和创建时间。优先级大于零时显示 `P{priority}`。页面没有认领、重试或状态修改操作。

#### 1.2.4 模型调用流

`ops.recentModelCalls` 默认请求二十条 `token_usage` 记录，显示模型、来源、总 Token、成本、traceId 前缀和时间。复选框“仅高价模型”将 `highCostOnly: true` 传给查询，只影响模型调用流，不影响其他卡片。

#### 1.2.5 成本热力图

`ops.costHeatmap` 默认使用 `{ days: 7 }`，后端按日期和模型聚合 Token、调用次数及成本。页面显示总成本、总 Token、调用次数和按日成本柱状图，悬停可看日期、成本、Token 和调用次数。

#### 1.2.6 WebSocket 行为

页面使用 `useWebSocket()` 连接当前页面协议对应的 `/ws/dashboard`，断开后每三秒重连。任意带 `type` 的消息更新页头最近事件标识。以下消息触发查询刷新，五秒内只刷新一次：

```text
agent.online
agent.offline
task.created
task.completed
task.failed
model.high_cost_alert
fusion.completed
```

解析失败的消息被忽略，事件本身不写入 Ops 状态，数据更新依靠 tRPC 重新查询。

### 1.3 Ops router

文件：`api/ops-router.ts`，注册为 `appRouter.ops`。

| Procedure | 权限 | 输入 | 输出或逻辑 |
|-----------|------|------|------------|
| `agentStatus` | `publicQuery` | 无 | Agent 字段加 `heartbeatOk`、`budgetUsed`，按状态排序 |
| `taskStats` | `publicQuery` | 无 | 按任务状态计数，五类状态缺失补零 |
| `recentTasks` | `publicQuery` | 可选 `{ limit: 1..50 }`，默认 10 | 最近任务摘要，按创建时间倒序 |
| `recentModelCalls` | `authedQuery` | 可选 `{ limit: 1..50, highCostOnly?: boolean }`，默认 20 | 最近用量，按创建时间倒序 |
| `costHeatmap` | `authedQuery` | 可选 `{ days: 1..90 }`，默认 7 | 按日、模型聚合的成本对象 |
| `todayOverview` | `publicQuery` | 无 | Agent、任务和当天用量聚合 |

`agentStatus` 查询 `agents` 的状态、模型、心跳和预算字段。`taskStats` 按 `tasks.status` 分组。`recentTasks` 返回 `id`、`taskId`、`name`、`status`、`priority`、`agentId`、`createdAt`、`updatedAt`，按 `createdAt DESC` 排序。

`recentModelCalls` 需要用户登录或有效 API Key。`highCostOnly` 为真时筛选 `token_usage.high_cost_model = 'true'`，返回模型、提供方、Token、成本、来源、session key、traceId、Agent ID 和创建时间。

`costHeatmap` 将当前时间向前 `days * 86400_000` 毫秒，按 `DATE(createdAt)` 和模型聚合：

```typescript
{
  days: Array<{
    date: string;
    totalTokens: number;
    callCount: number;
    costCents: number;
    models: Record<string, { tokens: number; cost: number }>;
  }>;
  totalCostCents: number;
  totalTokens: number;
  totalCalls: number;
}
```

`todayOverview` 将当天边界设为本地时间 00:00:00 到 23:59:59.999，分别聚合 Agent、当日创建任务和当日用量；高价调用数量按高价记录的 `callCount` 累加。

### 1.4 GuardPanel 前端

文件：`src/pages/GuardPanel.tsx`。页面标题为“模型熔断管理”，展示固定的已知高价模型：

```text
4sapi/gpt-5.5-high
4sapi/claude-opus-4-8
zeabur-ai/gpt-5.4-pro
zeabur-ai/claude-opus-4-7
zeabur-ai/claude-opus-4-6
```

Agent ID 输入框同时筛选白名单和授权。白名单由 `guard.listAllowlist` 读取，显示模型、Agent、原因、创建者和时间。用户可打开表单，填写 Agent ID、模型和可选原因，调用 `guard.addAllowlist`；删除按钮调用 `guard.removeAllowlist`。添加时页面固定 `createdBy: "admin"`，Agent ID 和模型必须非空。

活动授权由 `guard.listAuth` 以 `{ active: "true" }` 查询。页面显示模型、Agent、原因、授权人和过期时间，并在客户端判断过期。用户可填写 Agent ID、模型、原因、授权人和可选 `datetime-local`，调用 `guard.createAuth`；未过期记录可调用 `guard.revokeAuth`。成功后相关查询重新执行。

Guard 页面没有直接 WebSocket 监听器，也没有独立的熔断事件查询。mutation 的错误显示依赖 tRPC 客户端行为。

### 1.5 Guard router

文件：`api/guard-router.ts`，注册为 `appRouter.guard`。

| Procedure | 权限 | 输入 | 输出或副作用 |
|-----------|------|------|--------------|
| `check` | `publicQuery` | `model`、可选 `agentId`、`costCents` 默认 0 | `{ allowed, reason, highCost, ... }` |
| `addAllowlist` | `adminQuery` | `agentId`、`model`、可选 `reason`、`createdBy` | 新记录 ID、模型和 Agent |
| `removeAllowlist` | `adminQuery` | `{ id }` | `{ deleted: true }`，直接删除 |
| `listAllowlist` | `publicQuery` | 可选 `agentId`、`model` | 白名单数组，按创建时间倒序 |
| `createAuth` | `adminQuery` | `agentId`、`model`、`reason`、`authorizedBy`、可选 `expiresAt` | `{ id }` |
| `revokeAuth` | `adminQuery` | `{ id }` | `{ revoked: true }`，设置 active 为 false |
| `listAuth` | `publicQuery` | 可选 `agentId`、`model`、`active` | 授权数组，按创建时间倒序 |
| `recordWithGuard` | `authedQuery` | 用量、成本、Agent、来源和 trace 字段 | 通过时写入用量并返回记录 ID |

#### 1.5.1 高价判定和 `check`

`HIGH_COST_THRESHOLD_CENTS` 为 100。成本大于等于 100 分，或模型命中固定名单时，视为高价。低价直接返回：

```json
{"allowed":true,"reason":"low_cost_model","highCost":false}
```

高价且有 Agent ID 时，先查同 Agent、同模型的 `model_allowlist`，再查 `active = 'true'` 且 `expiresAt` 为空或不早于当前时间的授权。白名单优先。两者都没有时返回 `high_cost_not_authorized`。`check` 为公开查询，创建、删除和授权写操作仍由 `adminQuery` 保护。

#### 1.5.2 `recordWithGuard`

该 mutation 需要用户登录或有效 API Key。输入包括模型、提供方、prompt 和 completion Token、总 Token、调用次数、成本、任务 ID、Agent ID、session key、来源、traceId 和开始时间。来源枚举为 `manual`、`cron`、`connector`、`runner`、`system`、`subagent`。总 Token 未提供时由输入和输出 Token相加。

处理顺序为：

1. 有 Agent 正预算时，检查新成本是否超过 `budgetCents`。
2. 高价且有 Agent 时，检查白名单或未过期授权。
3. 通过后写入 `token_usage` 并保存 `highCostModel`。
4. Agent ID 存在且成本大于零时，累加 `agents.spentCents`。

预算超限返回 `budget_exceeded`，高价未授权返回 `high_cost_not_authorized`，两种拒绝均不写入用量。

---

## 2. P10.2 Fusion Review Mode

### 2.1 目标和流程

连接器指南定义的流程是：在 `/fusion` 提交主题、内容和数量；系统选 2 至 5 个不同模型的 Agent 并行审查；每个审查者返回共识、分歧、风险、建议和置信度；Judge 汇总生成最终裁决。

`api/fusion-router.ts` 选择状态为 `online`、`busy` 或 `idle` 且模型非空的 Agent。算法先选择不同模型的 Agent，再补选其他候选，直到达到请求数或候选耗尽。

### 2.2 FusionPanel 前端

文件：`src/pages/FusionPanel.tsx`。页面包含提交表单、审查历史和详情。浏览器页面只使用 tRPC，不直接监听 WebSocket；审查 Agent 接收 `fusion_review` 属于后端到 Agent 的连接器通道。

表单字段为非空主题、非空内容和 2、3、4、5 之一的审查者数量，默认 3。按钮在字段为空或 mutation 进行时禁用。`fusion.submit` 成功后保存 `traceId`、关闭表单、清空字段并刷新历史。

`fusion.list` 的历史项显示主题、状态和创建时间。点击后启用 `fusion.status`。详情头显示 traceId、审查者数量、已完成数量和 Judge 状态。审查卡片可展开查看共识、分歧、风险、建议和完成时间。Judge 卡片显示最终裁决、风险评估、建议行动、共识、分歧、覆盖盲区、独特洞见、盲点、置信度和生成时间。待处理状态显示刷新按钮。

### 2.3 Fusion 数据模型

```typescript
interface ReviewResult {
  reviewerId: number;
  reviewerName: string;
  reviewerModel: string;
  consensus: string[];
  conflicts: string[];
  risks: string[];
  suggestions: string[];
  confidence: number;
  rawOutput: string;
  completedAt: string;
}

interface JudgeResult {
  consensus: string[];
  conflicts: string[];
  coverageGaps: string[];
  uniqueInsights: string[];
  blindSpots: string[];
  riskAssessment: string;
  recommendedActions: string[];
  finalVerdict: string;
  confidence: number;
  generatedAt: string;
}
```

`FusionStatus` 还包含 `traceId`、`status`、`reviewerCount`、`reviewCompleted`、`judgeCompleted`、`reviews` 和可空 `judge`。

### 2.4 Fusion router procedure

| Procedure | 权限 | 输入重点 | 主要逻辑 |
|-----------|------|----------|----------|
| `submit` | `authedQuery` | `subject`、`content`、可选任务和 Agent、`reviewerCount` 2 至 5、可选 traceId | 选审查者，写 command 消息并向在线 Agent 推送 |
| `submitReview` | `authedQuery` | traceId、reviewerId、四类数组、confidence、可选 rawOutput | 写 response 审查结果并广播完成消息 |
| `submitJudge` | `authedQuery` | traceId、Judge 各维度、riskAssessment、finalVerdict、confidence | 写 response Judge 结果并广播完成消息 |
| `status` | `publicQuery` | `{ traceId }` | 解析关联消息，计算审查状态 |
| `list` | `publicQuery` | 可选 `limit` 1 至 100、状态过滤 | 从 `fusion-*` command 消息聚合历史 |

#### 2.4.1 `submit`

没有 traceId 时生成 `fusion-{时间}-{随机串}`。可用审查者少于 2 个时返回 `success: false` 和不足错误。每个审查者收到一条 `type: command` 消息，`correlationId` 为 traceId，幂等键为 `fusion:{traceId}:{reviewerId}`，优先级为 10。消息在线时通过 `wsManager.sendToAgent` 推送并标记为 `delivered`。

发送给 Agent 的消息结构为：

```json
{"type":"fusion_review","message":{},"traceId":"fusion-xxx","subject":"审查主题"}
```

完成写入后向 Dashboard 广播包含 traceId、主题、审查者摘要和时间戳的消息，当前直接使用 `fusion_submitted`。

#### 2.4.2 `submitReview`

先按 reviewerId 查询 Agent。不存在时返回失败。存在时把审查字段序列化为 `fusion_review_result` JSON，写入 `messages` 的 response，发送方为审查者、接收方为协调者 Agent 1，关联 ID为 traceId，幂等键为 `fusion-review:{traceId}:{reviewerId}`。随后广播 `fusion_review_completed`，包含审查者和置信度。

#### 2.4.3 `submitJudge`

将 Judge 字段序列化为 `fusion_judge_result` JSON 写入 response 消息。当前发送方和接收方均为 Agent 1，幂等键为 `fusion-judge:{traceId}`。随后广播 `fusion_completed`，携带最终裁决、置信度、共识数量和分歧数量。

#### 2.4.4 `status` 和 `list`

`status` 查询 `messages.correlationId = traceId`，解析含 `fusion_review_result` 的 response 和含 `fusion_judge_result` 的 response。状态规则为：有 Judge 为 `completed`，否则有审查结果为 `reviewing`，否则为 `pending`。`reviewerCount` 为 command 数量，`reviewCompleted` 为解析成功的审查数。

`list` 查询 `correlationId LIKE 'fusion-%'` 且类型为 command 的消息，按 traceId 去重，从 prompt 的 `## 审查主题` 后一行提取主题，再检查审查和 Judge 消息以计算状态。

### 2.5 Fusion WebSocket 事件

发给审查 Agent 的事件为 `fusion_review`。发给 Dashboard 的当前 router 消息为 `fusion_submitted`、`fusion_review_completed` 和 `fusion_completed`。`api/lib/event-bus.ts` 同时定义规范点号类型 `fusion.submitted`、`fusion.review_completed`、`fusion.judge_completed` 和 `fusion.completed`。当前两种命名并存，消费者不得假设生产端已经完全统一。

---

## 3. P10.3 Event Stream

### 3.1 标准事件格式

文件：`api/lib/event-bus.ts`。事件通过 `wsManager.broadcastToDashboard` 广播，不写入事件表。

```typescript
interface EventEnvelope {
  type: EventType;
  eventId: string;
  traceId?: string;
  sourceAgentId?: number;
  targetAgentId?: number;
  taskId?: number;
  messageId?: number;
  modelCallId?: number;
  sourceSystem?: "openclaw" | "arkclaw" | "hermes-agent" | "manual" | "system";
  timestamp: string;
  payload?: Record<string, unknown>;
}
```

`eventId` 由 `evt-{时间}-{随机串}` 生成，`timestamp` 为 ISO 字符串，`payload` 承载事件专属数据。事件类型如下：

| 分类 | 类型 |
|------|------|
| Agent | `agent.online`、`agent.offline`、`agent.busy`、`agent.idle`、`agent.heartbeat` |
| 任务 | `task.created`、`task.queued`、`task.started`、`task.progress`、`task.completed`、`task.failed`、`task.unblocked` |
| 消息 | `message.sent`、`message.delivered`、`message.read`、`message.acked`、`message.expired` |
| 模型 | `model.call.started`、`model.call.completed`、`model.call.failed`、`model.high_cost_alert`、`model.budget_exceeded` |
| Fusion | `fusion.submitted`、`fusion.review_completed`、`fusion.judge_completed`、`fusion.completed` |
| 协作 | `collab.delegated`、`collab.unblocked`、`collab.summary` |
| 系统 | `system.startup`、`system.shutdown`、`system.error`、`system.migration` |

`EventStream.tsx` 为主要类型提供标签和图标，未知类型使用通用图标并显示原始 type。连接器指南列出的分类与 event-bus 基本一致，验收以代码中的类型和实际发送消息为准。

### 3.2 Dashboard WebSocket

`src/hooks/useWebSocket.ts` 根据页面协议连接：

```text
HTTPS: wss://当前主机/ws/dashboard
HTTP:  ws://当前主机/ws/dashboard
```

`GET /ws/dashboard` 当前无需认证。连接建立后注册 Dashboard 客户端并立即发送：

```json
{"type":"online_agents","agentIds":[1,2],"timestamp":"2026-06-15T..."}
```

Dashboard 通常只接收消息。发送 `{"type":"ping"}` 返回 `pong`。断开时移除客户端，广播失败时清理死连接。hook 暴露 `connected`、`lastMessage`、`send`、`addEventListener` 和 `removeEventListener`，断线或创建失败后三秒重试。

### 3.3 EventStream 页面

文件：`src/pages/EventStream.tsx`。页面最多保留 500 条事件，新事件插入头部，超限丢弃尾部。事件仅在浏览器内存中存在，没有历史查询。

接收规则：标准 JSON 必须同时有 `type` 和 `eventId`；只有 `type` 的旧消息会被包装，生成 `legacy-{时间}-{随机串}` 的 eventId 并把原消息放入 payload；无 type 或解析失败时忽略；暂停时不加入列表。

用户操作包括暂停或继续、清空、按 type 包含匹配、按 traceId 包含匹配、清除筛选、点击查看详情、展开 payload，以及点击 Trace 分组将 traceId 设为筛选条件。页面显示总事件、筛选后事件、Trace 分组数和接收状态，右侧最多显示 20 个分组。

### 3.4 Event Stream 边界

仓库中没有 `api/event-router.ts` 或 `eventRouter`。P10.3 的后端表面是 Dashboard WebSocket 和事件总线广播，不是 tRPC 查询。事件总线定义点号格式，但现有直接广播仍有 `agent_status`、`fusion_submitted` 和 `fusion_completed` 等旧格式。EventStream 能显示未知 type，但旧格式不会自动获得规范分类样式。

---

## 4. 数据模型和 schema 参考

### 4.1 `agents`

定义：`db/schema.ts`。P10 使用 `id`、`agentId`、`name`、`status`、`model`、`role`、`currentTask`、`lastHeartbeat`、`budgetCents` 和 `spentCents`。状态用于 Ops 和 Fusion 选人，心跳用于在线判断，预算字段用于展示和 Guard 检查。

### 4.2 `tasks`

P10 使用 `id`、`taskId`、`name`、`agentId`、`status`、`priority`、`createdAt` 和 `updatedAt`。Ops 按 status 聚合，按 createdAt 查询最近任务。任务输入、输出、错误和生命周期字段存在，但当前 Ops router 不返回。

### 4.3 `token_usage`

P10 使用或写入以下字段：

```text
id, model, provider, prompt_tokens, completion_tokens, total_tokens,
call_count, cost_cents, task_id, agent_id, session_key, source,
trace_id, started_at, high_cost_model, created_at
```

表还包含缓存 Token、货币、汇率和展示成本字段。Ops 聚合 Token、调用次数和成本，Guard 写入高价标记并更新 Agent 已用预算。表不保存 API Key、完整 prompt 或完整 response。

### 4.4 Guard 表

`model_allowlist` 字段为 `id`、`agentId`、`model`、`reason`、`createdBy`、`createdAt`，按 Agent 和模型匹配，删除即移除。

`high_cost_model_auth` 字段为 `id`、`agentId`、`model`、`reason`、`authorizedBy`、`expiresAt`、`active`、`createdAt`。撤销将 active 设置为字符串 `"false"`，检查只接受活动且未过期记录。

### 4.5 Fusion 和事件存储

Fusion 没有专用表。命令、审查 response 和 Judge response 均存于 `messages`，以 `correlationId` 保存 traceId，以幂等键防止重复写入，正文类型分别为 `fusion_review_result` 和 `fusion_judge_result`。

事件总线和 EventStream 均不持久化事件。没有 `events` 表、事件查询 API 或跨重启恢复机制，500 条上限只适用于当前浏览器实例。

---

## 5. API Surface

### 5.1 tRPC procedure

```text
ops.agentStatus          ops.taskStats          ops.recentTasks
ops.recentModelCalls     ops.costHeatmap        ops.todayOverview

guard.check              guard.addAllowlist     guard.removeAllowlist
guard.listAllowlist      guard.createAuth       guard.revokeAuth
guard.listAuth           guard.recordWithGuard

fusion.submit            fusion.submitReview    fusion.submitJudge
fusion.status            fusion.list
```

实际 HTTP 地址为 `/api/trpc/{namespace}.{procedure}`，连接器指南中的调用使用 HTTP POST 和认证 header。

### 5.2 权限矩阵

| 接口 | 权限 |
|------|------|
| Ops `agentStatus`、`taskStats`、`recentTasks`、`todayOverview` | `publicQuery` |
| Ops `recentModelCalls`、`costHeatmap` | `authedQuery` |
| Guard `check`、`listAllowlist`、`listAuth` | `publicQuery` |
| Guard 添加、删除、创建授权、撤销授权 | `adminQuery` |
| Guard `recordWithGuard` | `authedQuery` |
| Fusion submit、submitReview、submitJudge | `authedQuery` |
| Fusion status、list | `publicQuery` |
| Agent `/ws` | `agentId` 和匹配的 MCP token |
| Dashboard `/ws/dashboard` | 当前实现无需认证 |

### 5.3 WebSocket 消息面

| 方向 | type | 用途 |
|------|------|------|
| 服务端到审查 Agent | `fusion_review` | 投递审查任务 |
| 服务端到 Dashboard | `online_agents` | 连接时发送在线 Agent |
| 服务端到 Dashboard | 标准点号事件 | 事件总线广播 |
| 服务端到 Dashboard | `agent_status` | Agent 连接和断开旧格式消息 |
| Dashboard 到服务端 | `ping` | 保活并返回 `pong` |

---

## 6. Frontend Pages

### 6.1 路由和保护

`src/App.tsx` 将四个页面放入 `ProtectedLayout` 和 `AppLayout`：

| 路径 | 页面 | 行为 |
|------|------|------|
| `/ops` | `OpsPanel` | 未认证跳转 `/login` |
| `/guard` | `GuardPanel` | 未认证跳转 `/login` |
| `/fusion` | `FusionPanel` | 未认证跳转 `/login` |
| `/events` | `EventStream` | 未认证跳转 `/login` |

页面本身没有独立角色检查，Guard 写权限由后端 `adminQuery` 决定。

### 6.2 Navigation 入口

`src/sections/Navigation.tsx` 注册：监控分组的“事件流” `/events`，系统分组的“熔断” `/guard` 和 “Ops” `/ops`，工具分组的“审查” `/fusion`。侧栏底部系统状态使用同一 WebSocket hook，桌面和移动布局不改变 P10 协议。

### 6.3 交互边界

Ops 是查询加事件触发刷新，Fusion 是提交和按 traceId 查询，EventStream 是实时内存列表。三者使用现有 tRPC provider、主题变量和 WebSocket hook，不增加独立客户端或图表依赖。

---

## 7. Environment Variables

### 7.1 P10 直接读取情况

`OpsPanel.tsx`、`GuardPanel.tsx`、`FusionPanel.tsx`、`EventStream.tsx`、三个 P10 router、`event-bus.ts` 均没有直接读取 `process.env`。浏览器 WebSocket 地址由当前页面协议和 host 组成。

### 7.2 共享运行依赖

| 变量 | 读取位置和用途 | P10 影响 |
|------|----------------|----------|
| `DATABASE_URL` | `getDb()` 的 MySQL 连接 | Ops、Guard、Fusion 查询和 mutation |
| `APP_SECRET` | 登录 JWT 签名和验证 | 受保护页面和 `authedQuery` 用户认证 |
| `ADMIN_USER` | 管理员默认登录用户名 | Guard 管理入口 |
| `ADMIN_PASSWORD` | 管理员默认登录密码 | Guard 管理入口 |
| `NODE_ENV` | 生产模式和错误堆栈展示 | 共享 boot 和错误响应 |
| `TIANGONG_API_KEY` | 固定 API Key 认证 | `authedQuery`、`adminQuery` |
| `TIANGONG_<NAME>_MCP_KEY` | 扫描每个 Agent 的 MCP Key | 连接器提交审查或用量记录 |
| `PORT` | HTTP 和 WebSocket 监听端口 | tRPC 和 `/ws/dashboard` 服务端口 |

`TIANGONG_<NAME>_MCP_KEY` 是名称模式，不是单一变量。认证中间件扫描以 `TIANGONG_` 开头、以 `_MCP_KEY` 结尾的变量。OpenClaw Gateway 变量由任务执行器读取，不是 P10 直接依赖。生产环境应显式设置 `APP_SECRET`，不依赖默认值。

---

## 8. Security Notes

1. Guard 写操作使用 `adminQuery`，后端检查管理员角色或有效 API Key，不能以隐藏前端按钮代替鉴权。
2. `guard.check`、`listAllowlist`、`listAuth`、Fusion `list` 和 `status` 当前是公开 procedure，部署时应确认返回的授权原因、授权人和审查内容符合公开范围。
3. Fusion 三个写 procedure 需要登录或 API Key。连接器提交结果应使用绑定 Agent 的 MCP Key，不打印完整 token。
4. Agent `/ws` 校验 token 与 Agent ID 一致；Dashboard `/ws/dashboard` 当前无认证，任何可访问端点的客户端都可能接收实时事件。
5. 高价模型按每次至少 100 分或固定名单判断。Guard 要求白名单或未过期授权，预算超限也拒绝 `recordWithGuard`。
6. `token_usage` 只存用量元数据。Fusion 的内容和可选 `rawOutput` 存入 `messages`，应按敏感输入处理。
7. Fusion 使用 traceId 和幂等键，但没有独立 report 表或全局事务；调用方应管理 traceId。
8. 事件只在浏览器内存中保留 500 条，刷新、关闭页面或断线期间不会恢复历史。
9. EventStream 会显示旧格式 payload。广播消息不得携带密钥、完整凭证或未脱敏个人数据。
10. 点号事件与下划线旧消息并存。消费者必须把未知 type 当作不可信文本，不将其用于 HTML 或命令执行。
11. 事件、模型名称、错误信息和审查内容均可能来自外部输入，前端应继续使用 React 文本渲染和 JSON 展示。
12. 验证使用隔离测试数据，不执行生产数据清理、强制迁移或不受信任命令。

---

## 9. Verification Plan

### 9.1 静态检查

接受实现变更后运行：

```bash
npm run check
npm run build
node --check scripts/openclaw-connector/connector.mjs
```

本文件是 Markdown，不执行 `node --check`。使用以下命令检查代码围栏成对闭合：

```bash
node -e "const fs=require('fs'); const p='TIANGONG_P10_OPS_GUARD_FUSION_EVENT_STREAM_SPEC.md'; const s=fs.readFileSync(p,'utf8'); const n=(s.match(/^```/gm)||[]).length; if(n%2) throw new Error('unclosed markdown fence'); console.log('markdown fences:', n);"
```

### 9.2 API 和单元 smoke

若新增 P10 smoke 脚本，至少覆盖：

1. Ops Agent 心跳、预算比例、任务缺省状态、limit 边界、用量高价筛选和热力图聚合。
2. Guard 低价、白名单、有效授权、过期授权、未授权和预算超限路径；确认拒绝时不插入用量，撤销只将 active 置为 false。
3. Fusion 2 至 5 个审查者、少于 2 个候选、审查结果、Judge 结果、status 三状态和 list 去重。

### 9.3 WebSocket 和页面 smoke

在隔离环境执行：

1. 登录并打开 `/ops`、`/guard`、`/fusion`、`/events`。
2. 连接 `/ws/dashboard`，确认 `online_agents` 和后续状态事件到达。
3. Ops 点击刷新并切换高价筛选，确认查询和列表变化正确。
4. Guard 添加和删除白名单，创建带过期时间的授权并撤销未过期授权。
5. Fusion 提交审查，确认在线 Agent 收到 `fusion_review`，提交审查和 Judge 后页面显示详情。
6. EventStream 接收标准事件和无 eventId 的旧消息，确认包装、type 筛选、trace 分组和详情展开。
7. 暂停后确认事件计数不增加，清空后确认列表为空，超过 500 条后确认上限有效。
8. 断开 WebSocket，确认三秒重连尝试且页面不崩溃。
9. 非管理员调用 Guard 管理 mutation 应被拒绝，管理员会话或有效 API Key 应可执行。

### 9.4 规范一致性

验收时检查：

- `event-bus.ts` 的点号事件和 `fusion-router.ts` 的下划线广播是否统一；未统一时 EventStream 仍应显示未知 type。
- `/ws/dashboard` 是否继续无认证，或是否有明确的认证变更记录。
- P10 是否仍不需要事件持久化；如需历史，必须增加独立 schema 和 API。
- 页面是否只调用本文列出的 procedure 和消息，不引入未验证接口。

### 9.5 本文件验证记录

写入后在 `/opt/tiangong` 执行 `npm run check` 并记录退出码。Markdown 使用围栏检查，不执行 Node 语法检查。备份成功后记录 TOS 目标 `outputs/specs/`。

---

## 10. Changed-file List

### 10.1 本次交付

| 文件 | 状态 | 说明 |
|------|------|------|
| `TIANGONG_P10_OPS_GUARD_FUSION_EVENT_STREAM_SPEC.md` | 新增 | P10.1 Ops / Guard、P10.2 Fusion、P10.3 Event Stream 正式规范 |

### 10.2 实现参考文件，未修改

| 文件 | 作用 |
|------|------|
| `src/pages/OpsPanel.tsx` | Ops 查询、刷新、展示和事件监听 |
| `src/pages/GuardPanel.tsx` | 白名单和高价模型授权页面 |
| `src/pages/FusionPanel.tsx` | Fusion 提交、历史和结果展示 |
| `src/pages/EventStream.tsx` | WebSocket 事件接收、过滤和 Trace 展示 |
| `src/App.tsx` | 四个 P10 路由 |
| `src/sections/Navigation.tsx` | P10 侧边栏入口 |
| `src/hooks/useWebSocket.ts` | Dashboard WebSocket 和自动重连 |
| `api/ops-router.ts` | Ops procedure |
| `api/guard-router.ts` | Guard procedure、高价和预算检查 |
| `api/fusion-router.ts` | Fusion 审查、结果、Judge 和历史 procedure |
| `api/lib/event-bus.ts` | 标准事件类型、信封和广播函数 |
| `api/ws-manager.ts` | Agent 和 Dashboard WebSocket 管理 |
| `api/boot.ts` | `/ws` 和 `/ws/dashboard` 端点 |
| `api/router.ts` | 注册 Ops、Guard、Fusion router |
| `db/schema.ts` | P10 使用的表和字段定义 |
| `TIANGONG_CONNECTOR_GUIDE.md` | Fusion 和事件流接入说明 |
| `TIANGONG_P9_OPENCLAW_CONNECTOR_PRIORITY_USAGE_SPEC.md` | 规范风格和验证章节参考 |

本任务不修改实现文件，不新增依赖，不提交或推送 Git 变更。
