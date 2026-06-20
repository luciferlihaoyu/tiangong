# 天宫 (Tiangong)

> 多 Agent 协作 · 任务编排 · 组织管理 — 像指挥空间站一样调度 AI 网络

---

## 核心能力

- **多 Agent 接入** — 统一管理来自 OpenClaw、Dify、自定义系统的不同 Agent
- **Agent 协作通信** — Agent 之间可互发消息（command/response/broadcast/system）
- **DAG 任务编排** — 任务依赖管理、状态机流转、自动触发下游、循环依赖检测
- **公司架构管理** — 组织/部门/汇报线，Agent 归属组织参与任务
- **成本控制** — Agent 预算分配与消耗追踪
- **心跳监控** — Agent 心跳上报，实时在线状态

---

## 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| **前端** | React 19 + TypeScript | UI 框架 |
| | Vite | 构建工具 |
| | Tailwind CSS | 中国科幻风样式（朱红+金色+深空黑） |
| | tRPC 11.x | 端到端类型安全 API |
| **后端** | Hono | HTTP 服务器 |
| | tRPC 11.x | API 路由层 |
| | Drizzle ORM + MySQL | 数据库 |
| | JWT (jose) | 本地认证 |

---

## 数据库表结构

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `users` | 用户 | id, username, passwordHash, role |
| `agents` | AI Agent | agentId, name, source, model, role, orgId, departmentId, reportsTo, capabilities, budgetCents, spentCents, lastHeartbeat |
| `tasks` | 任务 | taskId, name, agentId, status, priority, input, output, retryCount, maxRetries, parentTaskId |
| `task_dependencies` | 任务依赖 (DAG) | taskId, dependsOnTaskId |
| `messages` | Agent 间消息 (P8.1 可靠总线) | fromAgent, toAgent, content, type, status, correlationId, idempotencyKey, taskId, parentMessageId, expiresAt, ackedAt, deliveredAt, retryCount, priority |
| `organizations` | 组织 | name, goals, budget |
| `departments` | 部门 | name, orgId, leadAgentId |
| `systems` | 外部系统 | name, slug, status |

---

## API 路由

### Agent 管理 (`agent.*`)

| 路由 | 类型 | 说明 |
|------|------|------|
| `agent.list` | query | 查询所有 Agent |
| `agent.getById` | query | 按 ID 查询 |
| `agent.getBySource` | query | 按来源系统查询 |
| `agent.getHierarchy` | query | 获取组织层级树 |
| `agent.create` | mutation | 创建 Agent |
| `agent.update` | mutation | 更新 Agent（全字段） |
| `agent.updateStatus` | mutation | 更新状态/任务/进度 |
| `agent.updateHeartbeat` | mutation | 更新心跳时间 |
| `agent.delete` | mutation | 删除 Agent |

### 任务编排 (`orch.*`)

| 路由 | 类型 | 说明 |
|------|------|------|
| `orch.createTask` | mutation | 创建任务（支持依赖） |
| `orch.updateStatus` | mutation | 更新状态（状态机检查 + 自动触发下游） |
| `orch.getDag` | query | 获取任务 DAG（含拓扑排序） |
| `orch.createBatch` | mutation | 批量创建任务 DAG |
| `orch.getOverview` | query | 系统概览（任务/Agent 统计） |

### 组织架构 (`org.*`)

| 路由 | 类型 | 说明 |
|------|------|------|
| `org.orgList` | query | 列出所有组织 |
| `org.orgGet` | query | 获取组织详情 |
| `org.orgCreate` | mutation | 创建组织 |
| `org.orgUpdate` | mutation | 更新组织 |
| `org.orgDelete` | mutation | 删除组织 |
| `org.deptList` | query | 列出所有部门 |
| `org.deptGet` | query | 获取部门详情 |
| `org.deptCreate` | mutation | 创建部门 |
| `org.deptUpdate` | mutation | 更新部门 |
| `org.deptDelete` | mutation | 删除部门 |
| `org.deptGetAgents` | query | 获取部门下 Agent |
| `org.deptAssignAgent` | mutation | 分配 Agent 到部门 |

### 消息系统 (`message.*`) [P8.1 可靠消息总线]

| 路由 | 类型 | 说明 |
|------|------|------|
| `message.list` | query | 查询最近 100 条消息 |
| `message.listByAgent` | query | 查询指定 Agent 消息 |
| `message.send` | mutation | 发送消息（支持幂等、correlationId、taskId、priority） |
| `message.inbox` | query | 获取待处理消息（按优先级排序） |
| `message.ack` | mutation | 幂等确认消息 |
| `message.replayUndelivered` | mutation | 重推未投递消息 |
| `message.markRead` | mutation | 标记已读 |
| `message.conversation` | query | 查询两人对话 |
| `message.broadcast` | mutation | 广播消息 |
| `message.stats` | query | 消息统计（含 byStatus 分组） |

### 协作编排 (`collab.*`) [P8.2]

| 路由 | 类型 | 说明 |
|------|------|------|
| `collab.delegate` | mutation | 将父任务拆成多个子任务并发送委托消息 |
| `collab.status` | query | 查看 parent mission 的子任务/Agent/消息 ACK 状态 |
| `collab.summary` | query | 汇总子任务 output/error/status counts |
| `collab.unblockReady` | mutation | 依赖完成后将 pending 子任务推进 queued |

### 认证 (`auth.*`)

| 路由 | 类型 | 说明 |
|------|------|------|
| `auth.login` | mutation | 用户名+密码登录 |
| `auth.register` | mutation | 注册用户 |
| `auth.changePassword` | mutation | 修改密码 |
| `auth.me` | query | 获取当前用户 |
| `auth.logout` | mutation | 退出登录 |
| `auth.seed` | mutation | 注入种子数据 |

---

## 任务编排引擎

### 状态机

```
pending → queued → running → done
                      ↓
                   failed → queued (自动重试, retryCount < maxRetries)
```

### DAG 依赖管理

- 创建任务时可指定依赖其他任务
- **循环依赖检测** — DFS 算法防止死循环
- **自动触发** — 当任务 A 完成，所有依赖 A 的任务 B 若其余依赖也完成 → 自动进入 queued
- **拓扑排序** — `getDag` 返回任务执行顺序

### 示例

```
任务A (done) ──→ 任务B (queued) ──→ 任务D (pending)
任务C (done) ──→ 任务B
任务C (done) ──→ 任务D
```

当 A 和 C 都完成后，B 自动触发；当 B 完成后，D 自动触发。

---

## 公司架构

### 组织结构

```
天宫科技 (Organization)
├── 总调度中心 (Department) — Lead: 美智子
├── 代码开发部 (Department) — Lead: 编程大师, Member: 经纬
├── 内容运营部 (Department) — Lead: 上官婉儿, Member: 美澄
└── 社区服务部 (Department) — Lead: 后土, Member: 苏木
```

### 预置 Agent

| Agent | 来源 | 模型 | 角色 | 能力 |
|-------|------|------|------|------|
| 美智子 | OpenClaw | volcengine-plan/ark-code-latest | CTO - 总调度 | code, review, architecture, hacking |
| 编程大师 | OpenClaw | deepseek-v4-pro | Senior Engineer | coding, refactoring, debugging |
| 上官婉儿 | OpenClaw | volcengine-plan/ark-code-latest | Content Lead | writing, content, editing |
| 后土 | OpenClaw | volcengine-plan/ark-code-latest | Support Lead | support, community, knowledge |
| 苏木 | OpenClaw | volcengine-plan/ark-code-latest | Community Manager | community, engagement |
| 美澄 | OpenClaw | volcengine-plan/ark-code-latest | WeChat Operator | wechat, social-media |
| 经纬 | OpenClaw | deepseek-v4-pro | Research Assistant | research, analysis |

---

## 快速开始

```bash
# 克隆
git clone https://github.com/luciferlihaoyu/tiangong.git
cd tiangong

# 安装
npm install

# 环境变量
cp .env.example .env
# 编辑 .env: DATABASE_URL, APP_SECRET

# 初始化数据库
npm run db:push      # 同步表结构
npx tsx db/seed.ts   # 注入种子数据（组织+部门+Agent）

# 启动
npm run dev           # http://localhost:3000
```

### 环境变量

```env
# 数据库（必需）
DATABASE_URL=mysql://user:password@host:port/database

# JWT 密钥
APP_SECRET=your-secret-key

# 管理员账号（默认 admin/admin）
ADMIN_USER=admin
ADMIN_PASSWORD=admin
```

---

## 部署

### Zeabur

1. 连接 GitHub 仓库
2. 设置环境变量（DATABASE_URL, APP_SECRET）
3. 自动构建部署

### Docker

```bash
docker build -t tiangong .
docker run -p 3000:3000 --env-file .env tiangong
```

### 构建元数据

`api/commit.ts` 由 `scripts/generate-build-meta.mjs` 在构建前自动生成，包含当前 git commit、分支和构建时间。`npm run build` / `npm run check` 会自动调用该脚本。部署环境（如 Zeabur）无需额外配置，只需确保构建时执行 `prebuild` 即可。

---

## 设计风格

**中国科幻风** — 灵感来源于中国空间站：

- 朱红 + 金色 + 深空黑配色
- Canvas 2D 星空粒子背景
- CSS 3D 节点架构可视化
- 深浅色主题切换

---

## License

MIT License

## P8.1 Reliable Message Bus

详见 `TIANGONG_P8_RELIABLE_MESSAGE_BUS_SPEC.md`。

核心增强：
- **幂等发送**：`fromAgent + idempotencyKey` 唯一约束
- **消息关联**：`correlationId`, `taskId`, `parentMessageId`
- **Inbox 队列**：`message.inbox` 按优先级获取待处理消息
- **ACK 确认**：`message.ack` 幂等确认
- **过期回收**：`expiresAt` 自动过滤
- **离线补偿**：`message.replayUndelivered` 重推未投递消息
- **Connector 集成**：统一 InboxProcessor + DedupTracker

## P8.2 Collaboration Orchestration

详见 `TIANGONG_P8_2_COLLABORATION_ORCHESTRATION_SPEC.md`。

核心增强：
- **任务拆解**：`collab.delegate` 将 parent task 拆成显式子任务
- **委托消息**：创建子任务时发送绑定 `taskId/correlationId/idempotencyKey` 的 command message
- **状态追踪**：`collab.status` 展示子任务、Agent、投递和 ACK 状态
- **结构化汇总**：`collab.summary` 汇总 outputs/errors/status counts
- **依赖推进**：`collab.unblockReady` 将依赖完成的 pending 子任务推进 queued

## P8.3 Collaboration Command Center

详见 `TIANGONG_P8_3_COLLABORATION_COMMAND_CENTER_SPEC.md`。

核心增强：
- **协作面板**：任务指挥中心内选择父任务/协调 Agent 并显式输入子任务
- **一键委托**：前端调用 `collab.delegate` 创建子任务与委托消息
- **状态/汇总可视化**：展示子任务状态、消息投递/ACK、outputs/errors counts
- **自动汇总**：任务 done/failed 时广播 `collab_summary`
- **依赖推进**：依赖完成后自动或手动推进 ready 子任务进入 queued

## P7 Remote OpenClaw Gateway Runner

Tiangong Task Runner supports a third execution mode for production environments that cannot install the `openclaw` CLI inside the app container:

```bash
TIANGONG_TASK_RUNNER_MODE=gateway
TIANGONG_OPENCLAW_GATEWAY_URL=https://your-openclaw-gateway.example.com
TIANGONG_OPENCLAW_GATEWAY_TOKEN=***
TIANGONG_OPENCLAW_GATEWAY_AGENT=codemaster
# optional
TIANGONG_OPENCLAW_GATEWAY_MODEL=openai/gpt-5.4
TIANGONG_OPENCLAW_GATEWAY_SESSION_PREFIX=tiangong
```

Gateway mode calls OpenClaw Gateway `POST /v1/chat/completions`, routing to `openclaw/<agent>` with `x-openclaw-agent-id` and an explicit Tiangong session key. It does not require `openclaw` CLI in the Tiangong container.

Security notes:

- Production default remains `mock` until the operator explicitly switches it.
- `/api/runner/status` only exposes safe booleans/host/agent diagnostics; it never returns tokens, full URLs, prompts, command args, or env values.
- The OpenClaw Gateway chat-completions endpoint must be enabled intentionally and protected by private ingress or bearer auth.
- Roll back by setting `TIANGONG_TASK_RUNNER_MODE=mock`.

---

## Smoke Test — 本地端到端验证（第二轮）

不启动生产服务、不连接 Zeabur、不泄露真实 token，在纯本地环境验证 **Connector → A2A-lite 完整生命周期**：

```bash
# 1. 安装依赖
npm install

# 2. 运行端到端 smoke（~15 秒）
npm run smoke:connector
```

该脚本会：
1. 启动本地 tRPC + WebSocket stub（模拟天宫后端）
2. 以 `command` 模式启动 connector，runner 为 `echo-runner.mjs`
3. 验证完整链路：
   - `agent.claimTask` 返回任务
   - `a2a.dispatch` 投递任务
   - `a2a.ack` 确认收到
   - `task.updateProgress` 10% → 25% → 50% → 75%
   - `a2a.submitResult` 提交结果并生成 artifact
   - `usage.record` 上报用量
4. 断言最终状态为 `done/completed/progress=100/artifact=1`
5. 断言 **没有冗余调用 `a2a.review`**（`submitResult` 已是最终完成态）

覆盖范围：
- ✅ Connector 心跳、Inbox 处理、任务认领
- ✅ A2A-lite v0.1 三段式状态（dispatch / ack / submitResult）
- ✅ echo-runner 实际执行 stdin prompt 并回传 stdout
- ❌ 不覆盖真实 OpenClaw Gateway 调用（由 P7 / runner.mjs 单独验证）
- ❌ 不覆盖数据库持久化（stub 为内存模拟）

如需查看 connector 详细输出：

```bash
SMOKE_VERBOSE=1 npm run smoke:connector
```
