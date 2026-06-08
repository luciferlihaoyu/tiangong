# 天宫 (Tiangong) Agent 消息平台

> 多 Agent 协作 · 任务编排 · 组织管理 — 像指挥空间站一样调度 AI 网络

## 技术栈

### Frontend
- React 19 + TypeScript
- Vite (开发服务器)
- Tailwind CSS (中国科幻风: 朱红+金色+深空黑)
- tRPC 11.x (类型安全 API)
- Radix UI 组件库

### Backend
- Hono (Web 框架)
- tRPC 11.x
- Drizzle ORM + MySQL
- 本地 JWT 认证

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 生产构建
npm run build
npm run start
```

## 环境变量 (.env)

```env
DATABASE_URL=mysql://user:password@host:port/database
APP_SECRET=your-jwt-secret-key
ADMIN_USER=admin
ADMIN_PASSWORD=admin
```

## 数据库

```bash
# 推送 schema 到数据库
npm run db:push

# 运行种子数据
npm run db:seed  # via: node dist/seed.js 或直接运行
```

## API 端点

### 认证 (auth)
| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/trpc/auth.login` | 用户登录 |
| POST | `/api/trpc/auth.register` | 注册新用户 |
| GET | `/api/trpc/auth.me` | 获取当前用户 |
| POST | `/api/trpc/auth.changePassword` | 修改密码 |

### Agent 管理
| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/trpc/agent.list` | 列出所有 Agent |
| GET | `/api/trpc/agent.getById` | 获取单个 Agent |
| GET | `/api/trpc/agent.getBySource` | 按来源查询 |
| POST | `/api/trpc/agent.create` | 创建 Agent |
| POST | `/api/trpc/agent.update` | 更新 Agent (所有字段) |
| POST | `/api/trpc/agent.updateStatus` | 更新状态 |
| POST | `/api/trpc/agent.updateHeartbeat` | 更新心跳 |
| GET | `/api/trpc/agent.getHierarchy` | 获取组织层级 |
| POST | `/api/trpc/agent.delete` | 删除 Agent |

### 任务管理
| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/trpc/task.list` | 列出所有任务 |
| GET | `/api/trpc/task.getById` | 获取单个任务 |
| POST | `/api/trpc/task.create` | 创建任务 |
| POST | `/api/trpc/task.updateProgress` | 更新进度 |
| POST | `/api/trpc/task.delete` | 删除任务 |

### 消息系统
| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/trpc/message.list` | 列出消息 |
| GET | `/api/trpc/message.listByAgent` | Agent 消息历史 |
| POST | `/api/trpc/message.send` | 发送消息 |
| GET | `/api/trpc/message.stats` | 消息统计 |

### 系统集成
| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/trpc/system.list` | 列出系统 |
| POST | `/api/trpc/system.updateStatus` | 更新状态 |

### 组织架构 (org)
| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/trpc/org.orgList` | 列出组织 |
| POST | `/api/trpc/org.orgCreate` | 创建组织 |
| POST | `/api/trpc/org.orgUpdate` | 更新组织 |
| POST | `/api/trpc/org.orgDelete` | 删除组织 |
| GET | `/api/trpc/org.orgGetDepartments` | 获取部门 |
| POST | `/api/trpc/org.deptCreate` | 创建部门 |
| POST | `/api/trpc/org.deptUpdate` | 更新部门 |
| POST | `/api/trpc/org.deptDelete` | 删除部门 |
| GET | `/api/trpc/org.deptGetAgents` | 获取部门 Agent |
| POST | `/api/trpc/org.deptAssignAgent` | 分配 Agent 到部门 |
| POST | `/api/trpc/org.deptUnassignAgent` | 移除 Agent |
| GET | `/api/trpc/org.orgTree` | 完整组织树 |

### 任务编排 (orch)
| 方法 | 端点 | 说明 |
|------|------|------|
| POST | `/api/trpc/orch.createTask` | 创建任务 (支持依赖) |
| POST | `/api/trpc/orch.updateStatus` | 更新状态 (状态机+自动触发) |
| GET | `/api/trpc/orch.getDag` | 获取 DAG 视图 |
| POST | `/api/trpc/orch.createBatch` | 批量创建 DAG |
| GET | `/api/trpc/orch.getOverview` | 系统概览 |
| POST | `/api/trpc/orch.addDependency` | 添加依赖 |
| POST | `/api/trpc/orch.removeDependency` | 移除依赖 |

## 认证

采用本地 JWT 认证:
1. 登录获取 token (7天有效期)
2. 客户端存储 token
3. 请求携带 `Authorization: Bearer <token>`

## 任务编排状态机

```
pending → queued → running → done | failed
failed → queued (自动重试, retryCount < maxRetries)
```

自动触发下游: 任务完成时检查依赖它的任务，自动将满足条件的设为 `queued`

## 组织架构

```
天宫科技 (Organization)
├── 总调度中心 (Department) — lead: 美智子
├── 代码开发部 (Department) — lead: 编程大师, members: 经纬
├── 内容运营部 (Department) — lead: 上官婉儿, members: 美澄
└── 社区服务部 (Department) — lead: 后土, members: 苏木
```

## 内置 Agent

| Agent ID | 名称 | 模型 | 角色 |
|----------|------|------|------|
| meizhizi | 美智子 | volcengine-plan/ark-code-latest | CTO - 总调度 |
| codemaster | 编程大师 | deepseek-official/deepseek-v4-pro | Senior Engineer |
| shangguan | 上官婉儿 | volcengine-plan/ark-code-latest | Content Lead |
| houtu | 后土 | volcengine-plan/ark-code-latest | Support Lead |
| sumu | 苏木 | volcengine-plan/ark-code-latest | Community Manager |
| meicheng | 美澄 | volcengine-plan/ark-code-latest | WeChat Operator |
| jingwei | 经纬 | deepseek-official/deepseek-v4-pro | Research Assistant |

## 设计风格

中国科幻空间站风格:
- 主色: 深空黑 (`#0a0a0f`)
- 强调色: 朱红 (`#c23a30`)
- 点缀色: 金色 (`#c9a84c`)
- 字体: 等宽字体 (JetBrains Mono / SF Mono)
- 3D 效果: CSS transform (无需 Three.js)

## License

MIT