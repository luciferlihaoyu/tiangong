# Tiangong P9: OpenClaw Connector Worker + Task Priority + Token Usage Monitoring

## 概述

P9 推进三大能力：OpenClaw 侧主动 Connector Worker、任务优先级系统、Token 用量监测面板。

| 模块 | 说明 | 接口/文件 |
|------|------|-----------|
| **OpenClaw Connector Worker** | 外部 worker 主动轮询 inbox/claim task → 执行 → 回写结果 | `scripts/openclaw-connector/connector.mjs` |
| **Task Priority** | 可视化优先级排序、提升操作 | `task.promote` API, `TaskCenter.tsx` UI |
| **Token Usage Monitoring** | 模型粒度用量统计、时间范围查询、前端面板 | `usage.*` API, `UsagePanel.tsx`, `token_usage` 表 |

---

## 1. OpenClaw Connector Worker（增强）

### 1.1 设计原则

- **不依赖 Gateway 配置变更**：worker 通过 Tiangong tRPC API 与 WebSocket 双通道工作
- **主动轮询**：周期性检查 inbox + claim task
- **任务生命周期**：claim → updateProgress(running) → 执行(mock/command) → updateProgress(done/failed)
- **幂等安全**：复用已有 InboxProcessor + DedupTracker；claim 使用 safe-claim 模式

### 1.2 新增能力

现有 `connector.mjs` 已支持：
- WebSocket 长连接 + 自动重连
- 心跳 + inbox 处理
- `executeMock` / `executeCommand` 执行模式
- `processTask` 完整任务处理 pipeline

P9 增强：

```
P9 新增 Worker Loop（独立于 WebSocket 的心跳循环）:

┌────────────────────────────────┬───────────────────────────────┐
│  Worker Tick (每 10s)          │  已有 Heartbeat (每 30s)      │
│                                 │                                │
│  1. fetch inbox (未处理消息)    │  1. agent.updateHeartbeat     │
│  2. process task-like messages  │  2. inbox.fetchAndProcess     │
│  3. claim task (agent.claim)    │  3. 主动认领                   │
│  4. execute task                │                                │
│  5. updateProgress              │                                │
└────────────────────────────────┴───────────────────────────────┘
```

新增函数：
- `pollAndClaimTask(cfg)` — 轮询 inbox 并尝试 claim 任务
- `executeTaskWithProgress(cfg, task)` — 带进度上报的任务执行 pipeline
- `initiateResultUpload(cfg, taskId, result)` — 将结果回写到 Tiangong

已有 `processTask` 和 `executeTask` 可复用，新增的是独立于 WebSocket 的 claim 轮询 cycle。

### 1.3 executorAdapter 抽象

`connector.mjs` 已有 `executeMock` / `executeCommand`。P9 新增一个 executor adapter 接口：

```js
// 执行器适配器
// { mode: 'mock' | 'command', exec: (cfg, task, prompt) => Promise<string> }
const executorAdapters = {
  mock: executeMock,
  command: executeCommand,
};

// 获取适配器
function getExecutor(cfg) {
  return executorAdapters[cfg.execMode] || executorAdapters.mock;
}
```

这个抽象使得未来可以无缝添加 gateway 或其他执行器。

### 1.4 安全性

- 不在日志或 status endpoint 中暴露 token/key
- exec mode 的 command 注入风险由信任边界控制（只执行预配置的 trusted binary）
- 所有 tRPC 调用通过 HTTP POST，token 通过 MCP API Key 传递

---

## 2. Task Priority 系统

### 2.1 现有基础

- `tasks.priority` (INT, default 0) 已存在于 schema
- TaskCenter UI 已展示 `P{priority}` badge
- `task.create` 已支持 `priority` 参数
- `collab.delegate` 已支持子任务 `priority`

### 2.2 新增

#### 2.2.1 排序规则变更

`task.list` 查询排序从 `createdAt DESC` 改为 `priority DESC, createdAt ASC`：

- 高优先级任务排在最前
- 同优先级内先创建的先执行

#### 2.2.2 `task.promote` API

```typescript
// 提升任务优先级
input: { id: number, delta?: number }   // delta default +1
output: { success: boolean, oldPriority: number, newPriority: number }
```

实现：`UPDATE tasks SET priority = priority + delta WHERE id = ?`

#### 2.2.3 UI 增强

TaskCenter 每个任务卡片增加优先级操作按钮：
- ↑ 提升优先级 (P{n} → P{n+1})
- ↓ 降低优先级 (P{n} → P{max(n-1, 0)})
- 创建任务时可选优先级（已有）
- 详情抽屉中可修改优先级

---

## 3. Token Usage Monitoring

### 3.1 数据模型

新表 `token_usage`：

```sql
CREATE TABLE token_usage (
  id SERIAL PRIMARY KEY,
  model VARCHAR(100) NOT NULL,           -- 模型名称
  provider VARCHAR(50) DEFAULT 'unknown', -- 提供方
  prompt_tokens INT DEFAULT 0,            -- 输入 token
  completion_tokens INT DEFAULT 0,        -- 输出 token
  total_tokens INT DEFAULT 0,             -- 总 token
  call_count INT DEFAULT 1,               -- 调用次数
  cost_cents INT DEFAULT 0,               -- 成本（分）
  task_id BIGINT,                         -- 关联任务
  agent_id BIGINT,                        -- 关联 Agent
  started_at TIMESTAMP,                   -- 调用开始时间
  created_at TIMESTAMP DEFAULT NOW()      -- 记录时间
);
```

**重要**：此表不存储 API key、完整 prompt、完整 response。仅存储用量元数据。

### 3.2 API

#### `usage.record` (mutation)

```typescript
input: {
  model: string,
  provider?: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens?: number,     // auto-calc if not provided
  taskId?: number,
  agentId?: number,
  startedAt?: string
}
output: { id: number, totalTokens: number }
```

#### `usage.list` (query)

```typescript
input: {
  model?: string,
  agentId?: number,
  from?: string,           // ISO date start
  to?: string,             // ISO date end
  provider?: string
}
output: UsageRecord[]
```

#### `usage.byModel` (query) — 按模型聚合

```typescript
input: { from?: string, to?: string }
output: Array<{
  model: string,
  provider: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  callCount: number,
  costCents: number
}>
```

#### `usage.byDay` (query) — 按日聚合

```typescript
input: { model?: string, from?: string, to?: string }
output: Array<{
  date: string,
  promptTokens: number,
  completionTokens: number,
  totalTokens: number,
  callCount: number
}>
```

### 3.3 前端页面

新页面 `UsagePanel` (`/usage`):
- 顶部统计卡片：总 token、总调用、今日 token
- 按模型分组统计表
- 按日趋势图（纯 CSS/CSS3 实现，无需图表库）
- 详细记录列表
- 时间范围选择器

### 3.4 数据来源

初期通过以下方式上报：
- **Mock Runner**: 模拟上报（每次任务执行完写入一条模拟 usage）
- **Connector Worker**: 每次 executeMock/executeCommand 后写入一条
- **tRPC API**: 外部可通过 `usage.record` 直接上报
- **未来**: 对接真实 provider（如 OpenClaw Gateway 返回的 usage 字段）

---

## 4. 改动文件清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `TIANGONG_P9_..._SPEC.md` | 新增 | 本 spec 文档 |
| `db/schema.ts` | 修改 | 新增 `token_usage` 表 |
| `api/usage-router.ts` | 新增 | Token usage API 路由 |
| `api/router.ts` | 修改 | 注册 `usage` router |
| `api/task-router.ts` | 修改 | 排序改为 `priority DESC, createdAt ASC`；新增 `promote` mutation |
| `scripts/openclaw-connector/connector.mjs` | 修改 | 新增 claim 轮询 cycle、executorAdapter、usage 上报、**P9.1 成本守卫** |
| `scripts/openclaw-connector/start-openclaw-agents.sh` | 修改 | **P9.1 默认安全配置** |
| `scripts/openclaw-connector/README.md` | 修改 | **P9.1 文档** |
| `src/pages/UsagePanel.tsx` | 新增 | Token 用量监测前端页面 |
| `src/pages/TaskCenter.tsx` | 修改 | 优先级提升/降低按钮 |
| `src/App.tsx` | 修改 | `/usage` 路由 |
| `src/sections/Navigation.tsx` | 修改 | 用量监测导航入口 |
| `scripts/smoke/p9_smoke.mjs` | 修改 | P9 smoke 验证脚本 + **P9.1 成本守卫验证** |

---

## 5. 验证计划

### 5.1 静态检查

```bash
npm run check          # TypeScript 编译检查
npm run build          # 前端 + 后端构建
node --check scripts/openclaw-connector/connector.mjs
node --check scripts/openclaw-connector/examples/openclaw-agent-runner.mjs
```

### 5.2 P9.1 成本守卫验证

新增环境变量和代码路径验证：

```bash
# 确认安全默认：connector 不自动认领/执行任务
TIANGONG_AGENT_ID=1 TIANGONG_MCP_KEY=tg-test-key-for-smoke-123456 \
  node scripts/openclaw-connector/connector.mjs --help | grep -A6 "P9.1"

# 检查成本守卫函数存在
node -e "
const fs = require('fs');
const code = fs.readFileSync('scripts/openclaw-connector/connector.mjs','utf-8');
console.assert(code.includes('selectModelForTask'), 'missing selectModelForTask');
console.assert(code.includes('rewriteModelInArgs'), 'missing rewriteModelInArgs');
console.assert(code.includes('TIANGONG_PROCESS_INBOX'), 'missing PROCESS_INBOX env');
console.assert(code.includes('TIANGONG_CLAIM_TASKS'), 'missing CLAIM_TASKS env');
console.assert(code.includes('TIANGONG_CHEAP_MODEL'), 'missing CHEAP_MODEL env');
console.assert(code.includes('TIANGONG_CHEAP_MODEL_OPS'), 'missing CHEAP_MODEL_OPS env');
console.assert(code.includes('TIANGONG_ALLOW_EXPENSIVE_RECURRING'), 'missing ALLOW_EXPENSIVE_RECURRING env');
console.log('✅ P9.1 cost guard functions and env names present');
"
```

### 5.2 Smoke 测试

`scripts/smoke/p9_smoke.mjs` 覆盖：
1. task.promote API
2. usage.record / usage.byModel API
3. task.list 排序验证
4. 文件语法检查

### 5.3 不验证

- 不连接真实数据库（smoke 只做静态/语法验证）
- 不启动生产服务
- 不修改 Zeabur 环境变量或 Gateway 配置
- 不 push / commit

---

## 6. 后续建议

1. **Gateway executor adapter**: 在 `connect.mjs` 中实现 gateway executor adapter，对接 OpenClaw Gateway agent endpoint
2. **Usage 自动上报**: Task Runner（服务端）每次执行后自动写入 usage 记录
3. **成本计算**: 根据模型定价自动计算 `costCents`
4. **告警阈值**: token 用量超阈值自动通知/限流
5. **Dify 集成**: 扩展 connector 支持 Dify 作为 Agent source
