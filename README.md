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
| `messages` | Agent 间消息 | fromAgent, toAgent, content, type |
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

### 消息系统 (`message.*`)

| 路由 | 类型 | 说明 |
|------|------|------|
| `message.list` | query | 查询最近 100 条消息 |
| `message.listByAgent` | query | 查询指定 Agent 消息 |
| `message.send` | mutation | 发送消息 |
| `message.stats` | query | 消息统计 |

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
