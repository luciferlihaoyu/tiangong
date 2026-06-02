# 天宫 (Tiangong)

> 多 Agent、多系统共用的消息平台——像指挥中国空间站一样调度你的 AI 代理网络。

---

## 项目简介

**天宫** 是一个面向 AI Agent 的多人协作与任务交付平台，灵感来源于 [Paperclip](https://github.com/paperclipai/paperclip)。它提供完整的 Agent 管理、任务追踪、消息通信和成本控制功能。

### 核心能力

- **多 Agent 协作** — 统一管理 Claude、Codex、Cursor、GPT-4 等不同 Agent
- **任务追踪** — 实时查看任务执行状态、进度百分比
- **全链路审计** — 每个 Agent 的思考过程和工具调用全记录
- **成本控制** — 月度预算，超支自动停止
- **多系统接入** — 连接 Slack、Email、Webhook、GitHub、Jira、Notion

---

## 技术栈

### 前端

| 技术 | 用途 |
|------|------|
| React 19 + TypeScript | UI 框架 |
| Vite | 构建工具 |
| Tailwind CSS | 样式系统 |
| Three.js / R3F | 3D 架构可视化 |
| GSAP | 滚动动效 |
| Canvas 2D | 星空粒子背景 |

### 后端

| 技术 | 用途 |
|------|------|
| Hono | HTTP 服务器框架 |
| tRPC 11.x | 端到端类型安全 API |
| Drizzle ORM | 数据库 ORM |
| MySQL | 数据库 |
| OAuth 2.0 | 用户认证 |

---

## 项目结构

```
tiangong/
├── api/                    # 后端 API
│   ├── boot.ts            # 服务器入口
│   ├── router.ts          # tRPC 路由注册
│   ├── agent-router.ts    # Agent CRUD API
│   ├── task-router.ts     # 任务管理 API
│   ├── message-router.ts  # 消息系统 API
│   ├── system-router.ts   # 外部系统连接 API
│   ├── auth-router.ts     # 认证路由
│   ├── context.ts         # 请求上下文
│   ├── middleware.ts      # 中间件
│   ├── kimi/              # OAuth 认证模块
│   ├── lib/               # 工具库
│   └── queries/           # 数据库查询
├── contracts/             # 前后端共享类型
├── db/
│   ├── schema.ts          # 数据库表定义
│   ├── relations.ts       # 表关系
│   ├── seed.ts            # 种子数据
│   └── migrations/        # 迁移文件
├── src/
│   ├── sections/          # 页面区块组件
│   │   ├── Navigation.tsx       # 顶部导航
│   │   ├── Dashboard.tsx        # 主控制台
│   │   ├── Starfield.tsx        # 星空背景
│   │   ├── MatrixNodes.tsx      # 3D 架构图
│   │   ├── Features.tsx         # 功能特性
│   │   ├── ExecutionCore.tsx    # 任务执行
│   │   ├── FAQ.tsx              # 常见问题
│   │   └── FooterTerminal.tsx   # 底部终端
│   ├── hooks/
│   │   ├── useTheme.ts          # 主题切换
│   │   └── useMockData.ts       # Mock 数据
│   ├── providers/
│   │   └── trpc.tsx             # tRPC 客户端
│   ├── pages/
│   │   ├── Login.tsx
│   │   └── NotFound.tsx
│   ├── App.tsx
│   ├── main.tsx
│   └── index.css              # 科幻风主题 CSS
├── Dockerfile             # Docker 部署配置
├── package.json
├── vite.config.ts
├── drizzle.config.ts
└── tsconfig.*.json
```

---

## 数据库表结构

| 表名 | 说明 | 关键字段 |
|------|------|---------|
| `users` | 用户（OAuth） | id, unionId, name, email, role |
| `agents` | AI Agent | agentId, name, system, status, task, progress |
| `tasks` | 任务 | taskId, name, agentId, status, progress |
| `messages` | 消息 | fromAgent, toAgent, content, type |
| `systems` | 外部系统 | name, slug, status |

---

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/luciferlihaoyu/tiangong.git
cd tiangong
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

复制 `.env.example` 为 `.env`，填写以下配置：

```env
# 数据库（MySQL）
DATABASE_URL=mysql://用户名:密码@主机:端口/数据库名

# OAuth 认证
VITE_KIMI_AUTH_URL=https://auth.kimi.com
VITE_APP_ID=你的_APP_ID
APP_SECRET=你的_APP_SECRET
```

### 4. 初始化数据库

```bash
npm run db:push      # 同步表结构
npx tsx db/seed.ts   # 注入种子数据
```

### 5. 启动开发服务器

```bash
npm run dev
```

打开 http://localhost:3000

---

## 部署

### 方式一：Docker 部署（推荐）

```bash
# 构建镜像
docker build -t tiangong .

# 运行容器
docker run -p 3000:3000 --env-file .env tiangong
```

### 方式二：直接部署

```bash
# 构建
npm run build

# 启动生产服务器
npm start
```

### 方式三：Zeabur 等云平台

1. 连接 GitHub 仓库
2. 设置环境变量（DATABASE_URL 等）
3. 自动构建部署

**注意**：如果数据库未连接，系统会自动使用 Mock 数据，所有前端交互功能仍可正常使用。

---

## 主题切换

- **深色模式**：深空黑背景 + 朱红/金色强调（默认）
- **浅色模式**：空间站银白 + 朱红/金色强调

点击导航栏右侧的 ☀️/🌙 按钮切换，偏好自动保存到 localStorage。

---

## API 路由

| 路由 | 操作 |
|------|------|
| `agent.list` | 查询所有 Agent |
| `agent.create` | 创建 Agent |
| `agent.updateStatus` | 更新 Agent 状态 |
| `task.list` | 查询所有任务 |
| `task.create` | 创建任务 |
| `task.updateProgress` | 更新任务进度 |
| `message.list` | 查询消息 |
| `message.send` | 发送消息 |
| `system.list` | 查询系统连接状态 |
| `auth.me` | 获取当前用户 |
| `auth.logout` | 退出登录 |

---

## 设计风格

**中国科幻风** — 灵感来源于中国空间站：

- 朱红 + 金色 + 深空黑的配色体系
- 中式印章 Logo
- 科幻角花装饰边框
- Canvas 2D 星空粒子背景
- 中英双语界面标签
- 3D 金色节点架构可视化

---

## License

MIT License
