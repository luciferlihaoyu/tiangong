# 天宫 (Tiangong)

> 多 Agent 协作 · 任务编排 · 组织管理 — 像指挥空间站一样调度 AI 网络

---

## 核心能力

- **多 Agent 接入** — 统一管理来自 OpenClaw、Dify、自定义系统的不同 Agent
- **Agent 协作通信** — Agent 之间可互发消息（command/response/broadcast/system）
- **DAG 任务编排** — 任务依赖管理、状态机流转、自动触发下游、循环依赖检测
- **公司架构管理** — 组织/部门/汇报线，Agent 归属组织参与任务
- **成本控制** — Agent 预算分配与消耗追踪，外部执行体用量记账 + 预算熔断
- **心跳监控** — Agent 心跳上报，实时在线状态
- **中枢自动流转** — 任务创建后自动派发、自动执行，高风险操作经审批闸门拦截；完成钩子收敛单一事实源（finalizeCompletedTask：璇玑记忆 + AList 上传 + 协作汇总 + 通知）
- **外部执行体接入** — DeepSeek Harness (dsh) 等外部 Agent 运行时经 MCP Key 认领任务；MCP 工具面含 claim_task / report_progress / submit_artifact / read_alist / search_xuanji 五工具
- **模型定价同步** — 从 BaseLLM（New API 比率配置）同步官方定价，支持分层计费与缓存价
- **AList 网盘集成** — 界面可配连接，任务产物自动上传（含 highlights/ 精华分级目录 + alist-compensation 补偿 sweeper 兜底），在线浏览/下载
- **璇玑知识联动** — 任务完成记忆自动写入璇玑知识库，执行前可检索知识上下文；失败教训 6 路径挂点写入（task-runner 主/catch、外部回写失败、taskboard 驳回、a2a fail/timeout、lifecycle sweeper 超时）
- **通知中心** — 5 类业务事件通知（审批通过/驳回/任务失败/教训记录/预算熔断），60s 防抖 + 预算 24h 窗口；tRPC list/markRead/markAllRead API + 前端铃铛角标 + `/notifications` 全页
- **WebSocket 实时推送** — Dashboard WS 广播（task_update/collab_summary/notification_created 等）；新通知近实时（<1s）刷新铃铛角标，30s 轮询兜底
- **OpenClaw 执行桥（P2/P3/P6）** — connector 心跳认领回写 + OpenClaw Session Runner（stdin prompt → `openclaw agent --json` → 最终文本回写）+ 服务端 task-runner command 模式安全 argv 执行，端到端 smoke 可验证

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
| `task_artifacts` | 任务产物 (长输出通道 + 归档标记) | taskId, type (collab_summary/alist_sync/xuanji_memory/xuanji_lesson), name, content, mimeType |
| `notifications` | 通知中心 | agentId, taskId, type (6 值枚举), title, body, metadata, readAt, createdAt |
| `token_usage` | 模型用量记账 | agentId, model, promptTokens, completionTokens, cachedPromptTokens, source |
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
| 天宫总调度 (`tiangong-manager`) | system | volcengine-plan/ark-code-latest | 总调度 Agent | triage, route, decompose, monitor, summarize, request_approval |
| 研究分析助手 (`openclaw:research`) | openclaw | deepseek-v4-pro | Research Analyst | research, analysis, report |
| 写作编辑助手 (`openclaw:writing`) | openclaw | volcengine-plan/ark-code-latest | Writing Editor | writing, editing, summary |
| 图片媒体助手 (`openclaw:media-image`) | openclaw | volcengine-plan/ark-code-latest | Image Media Producer | image_prompt, image_generation |
| 视频媒体助手 (`openclaw:media-video`) | openclaw | volcengine-plan/ark-code-latest | Video Media Producer | storyboard, video_generation |
| 数据分析助手 (`openclaw:data`) | openclaw | deepseek-v4-pro | Data Analyst | data_analysis, spreadsheet, datasource |
| 策略规划助手 (`openclaw:strategy`) | openclaw | deepseek-v4-pro | Strategy Planner | planning, evaluation, decision |
| 质量检查助手 (`openclaw:qa`) | openclaw | volcengine-plan/ark-code-latest | QA Reviewer | review, test_case, browser_check |
| 协同跟进助手 (`openclaw:coordinator`) | openclaw | volcengine-plan/ark-code-latest | Coordinator | coordination, followup, status_report |
| 代码需求分析助手 (`openclaw:coding-analysis`) | openclaw | deepseek-v4-pro | Coding Analyst | requirement, code_reading, spec |
| OpenCode 主执行器 (`opencode:main`) | opencode | deepseek-v4-pro | Coding Executor | coding, debugging, tests, pr, review |

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
# 编辑 .env: DATABASE_URL, APP_SECRET, ADMIN_USER, ADMIN_PASSWORD

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

# JWT 密钥（必需，生产环境请使用 openssl rand -hex 32 生成）
APP_SECRET=your-secret-key

# 管理员账号（必需，无默认值，未设置将拒绝启动；密码至少 8 位）
ADMIN_USER=your-admin-username
ADMIN_PASSWORD=your-strong-password

# 天枢模型网关（配置 TIANSHU_API_KEY 后任务执行自动经天枢路由，无需其他配置）
TIANSHU_API_KEY=sk-xxx
# TIANSHU_BASE_URL=https://woppis1.zeabur.app   （默认值，可省略）
# TIANSHU_MODEL=deepseek-v4-flash               （可选：固定执行模型）

# 中枢自动流转（默认值即可工作，一般无需设置）
# TIANGONG_AUTO_DISPATCH=true                   新任务自动派发（默认 true）
# TIANGONG_AUTO_DISPATCH_BATCH=10               每轮最多自动派发数（默认 10）
# TIANGONG_EXTERNAL_CLAIM_SOURCES=dsh-runner    外部认领型 agent 来源，Runner 不抢其任务

# AList 网盘（也可在「AList 网盘」页界面配置，界面配置优先于环境变量）
# ALIST_BASE_URL=https://your-alist
# ALIST_USERNAME=tiangong
# ALIST_PASSWORD=xxx
# ALIST_BASE_PATH=/115/天宫                      （可选，默认 "/" = 账号根目录）
# ALIST_AUTO_UPLOAD=true                         （可选，默认开启任务产物自动上传）

# 璇玑知识库联动（任务完成记忆自动写入璇玑）
# XUANJI_BASE_URL=https://xuanjj29.zeabur.app
# XUANJI_API_KEY_REF=<secret-vault 引用>

# 官方定价同步源（默认 BaseLLM，可在模型中心一键同步）
# PRICING_SYNC_URL=https://basellm.github.io/llm-metadata/api/newapi/ratio_config-v1-base.json
```

> ⚠️ 切勿将真实凭据提交到 git 仓库（包括文档和 `.env.example`）。如曾泄露，请立即轮换。

---

## 系统集成与自动化

### 天枢模型网关（统一模型来源与计费）

所有任务执行的模型调用都经过天枢（New API 兼容网关）：用量自动记账（`token_usage.cost_micros` 微美元精度），支持渠道前缀模型回退定价（如 `newapi/deepseek-v4-flash` 按 `deepseek-v4-flash` 计价）。

- **模型中心**：查看可用模型、切换默认模型、查看每个模型的定价
- **官方定价同步**：一键从 BaseLLM 比率配置同步（含 27 个按上下文长度分层计费的模型、缓存命中价），同步后自动重算历史用量成本；也可在用量页手动触发重算

### AList 网盘（产物备份与资料读取）

任务产出的文档/图片/视频等自动上传到 AList（默认目录 `<basePath>/tasks/<taskId>/`），网盘页可在线浏览目录、打开/下载文件。

- **界面配置优先**：网盘页「连接配置」表单可改地址/账号/密码/上传目录/自动上传开关，保存后立即做读写探测；密码只写不读（留空保留原密码）；界面配置存数据库，优先于环境变量
- 账号权限提示：账号需要对上传目录有写入权限（在 AList 后台「用户」中配置基本路径/权限位）

### 璇玑知识库联动

- 任务完成（通过执行闸门）后，结果摘要自动写入璇玑（`memory.xuanjiWriteTaskMemory`），含 traceId 可溯源
- 执行侧可经 `memory.xuanjiSearchContext`（keyword/vector/hybrid）检索璇玑知识，作为任务上下文
- 凭据经 secret-vault 引用，不落明文

### 中枢自动流转与外部执行体

任务从创建到完成全自动流转：`create → (审批闸门) → queued → 执行 → done`——无需人工派发。

- **自动派发**：task-runner 每轮把新建任务（pending+created）过执行审批闸门后转 queued；高风险任务（github 写操作、zeabur 部署、外部发送等）自动停放待人工审批
- **外部执行体**：`source` 为 `dsh-runner` 等外部认领型来源的 Agent，其任务由外部运行时自行认领（`agent.claimTask` / `agent.updateHeartbeat`，MCP Key 鉴权），服务端 Runner 不会抢
- **dsh 接入**：`scripts/dsh-poller.mjs` 是零依赖轮询器，在 dsh 所在机器运行即可让 DeepSeek Harness 自动认领并执行天宫任务：

```bash
TIANGONG_BASE_URL=https://tiangg.zeabur.app \
TIANGONG_MCP_KEY=<dsh助手的MCP Key> \
TIANGONG_AGENT_ID=17 \
DSH_CMD='dsh -p "$(cat {file})"' \
node scripts/dsh-poller.mjs
```

---

## 部署

### Zeabur

详细步骤见 [ZEABUR_DEPLOY_GUIDE.md](ZEABUR_DEPLOY_GUIDE.md)；artifact 存储部署契约见 [ZEABUR_DEPLOY.md](ZEABUR_DEPLOY.md)。

1. 连接 GitHub 仓库
2. 设置环境变量（DATABASE_URL, APP_SECRET, ADMIN_USER, ADMIN_PASSWORD）
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

[MIT License](LICENSE)

## P8.1 Reliable Message Bus

详见 [`docs/TIANGONG_P8_RELIABLE_MESSAGE_BUS_SPEC.md`](docs/TIANGONG_P8_RELIABLE_MESSAGE_BUS_SPEC.md)。

核心增强：
- **幂等发送**：`fromAgent + idempotencyKey` 唯一约束
- **消息关联**：`correlationId`, `taskId`, `parentMessageId`
- **Inbox 队列**：`message.inbox` 按优先级获取待处理消息
- **ACK 确认**：`message.ack` 幂等确认
- **过期回收**：`expiresAt` 自动过滤
- **离线补偿**：`message.replayUndelivered` 重推未投递消息
- **Connector 集成**：统一 InboxProcessor + DedupTracker

## P8.2 Collaboration Orchestration

详见 [`docs/TIANGONG_P8_2_COLLABORATION_ORCHESTRATION_SPEC.md`](docs/TIANGONG_P8_2_COLLABORATION_ORCHESTRATION_SPEC.md)。

核心增强：
- **任务拆解**：`collab.delegate` 将 parent task 拆成显式子任务
- **委托消息**：创建子任务时发送绑定 `taskId/correlationId/idempotencyKey` 的 command message
- **状态追踪**：`collab.status` 展示子任务、Agent、投递和 ACK 状态
- **结构化汇总**：`collab.summary` 汇总 outputs/errors/status counts
- **依赖推进**：`collab.unblockReady` 将依赖完成的 pending 子任务推进 queued

## P8.3 Collaboration Command Center

详见 [`docs/TIANGONG_P8_3_COLLABORATION_COMMAND_CENTER_SPEC.md`](docs/TIANGONG_P8_3_COLLABORATION_COMMAND_CENTER_SPEC.md)。

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
