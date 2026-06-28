# P2: Agent 运行时引擎 — Spec

## 目标
为天宫 Agent 增加运行时管理能力，从「消息转发器」升级为「Agent 执行平台」。

## 现状问题
- Agent 通过 WebSocket 连接，但天宫不知道 Agent 有什么能力
- 任务执行 = 丢消息到 Agent session，无超时/进度/资源控制
- 没有运行时上下文（临时目录、环境变量、执行身份）
- 执行日志不完整（只能从 message 记录反向推断）

## 设计

### 1. AgentCapability 能力注册

每个 Agent 声明自己的能力：

```typescript
interface AgentCapability {
  agentId: number;
  // 支持的模型
  models: string[];
  // 支持的工具
  tools: string[];
  // 最大并发任务
  maxConcurrency: number;
  // 默认超时
  defaultTimeout: number; // 秒
  // 能力描述
  description: string;
}
```

**DB 表：** `agent_capabilities`
**API：** `capability.register`、`capability.update`、`capability.list`、`capability.getByAgent`
**前端：** Agent 详情页展示能力

### 2. ExecutionLog 执行日志

每次任务执行产生结构化日志：

```typescript
interface ExecutionLog {
  id: number;
  taskId: number;
  agentId: number;
  phase: 'dispatch' | 'running' | 'completed' | 'failed' | 'timeout';
  message: string;
  metadata: Record<string, unknown>;
  duration: number; // ms
  createdAt: string;
}
```

**DB 表：** `execution_logs`
**API：** `execution.list`、`execution.getByTask`

### 3. Task Context 任务上下文

任务执行时有完整上下文：

```typescript
interface TaskContext {
  taskId: number;
  agentId: number;
  workDir: string; // 临时工作目录
  env: Record<string, string>; // 环境变量
  timeout: number; // 剩余秒数
  startedAt: string;
  maxTokens: number;
}
```

### 4. Resource Management 资源管理

- 并发限制：Agent 最多同时执行 maxConcurrency 个任务
- 超时强制：任务超过 timeout 自动标记 failed
- Token 预算：每个任务有 token 预算限制

### 5. Agent Status 增强

当前 status: online/busy/idle
增强为：`{ status, currentTaskId, currentTaskName, capabilities, uptime, executedTasks, failedTasks, avgDuration }`

---

## 实现步骤

### Step 1: DB Schema + Migrations
- 新建 `agent_capabilities` 表
- 新建 `execution_logs` 表
- 在 `agent` 表增加 status 相关字段

### Step 2: Backend API
- `capability.*` 路由
- `execution.*` 路由
- agent.status 增强
- task runner 增强（超时/上下文）

### Step 3: Connector 端适配
- Connector 启动时注册能力
- 执行任务时发送执行日志
- 支持超时回调

### Step 4: Frontend
- Agent 详情页展示能力
- 执行日志查看面板
- 任务实时状态卡片
