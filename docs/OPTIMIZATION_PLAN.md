# 🏯 天宫优化计划书

> 当前基线：commit `62eeae3` + 鉴权加固
> 目标：让天宫从"功能完整"到"工程可靠"

---

## 任务分解

### P0 — 统一错误处理中间件（高优先级）

**问题：** 当前各 router 错误处理方式不统一，有的用 try-catch，有的直接抛错，错误响应格式不一致。

**方案：** 在 `api/middleware.ts` 添加一个全局 tRPC 错误格式化器（`formatError`），统一所有错误的返回格式。

**涉及文件：**
- `api/middleware.ts` — 添加 `formatError` 配置

**具体修改：**
```typescript
// 在 createContext 下方或 t 对象处添加
const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    return {
      code: shape.code,
      message: shape.message,
      data: {
        code: shape.code,
        httpStatus: shape.data?.httpStatus,
        path: shape.data?.path,
        // 生产环境不暴露 stack
        stack: process.env.NODE_ENV === "development" ? shape.data?.stack : undefined,
      },
    };
  },
});
```

**验收标准：**
- [ ] 所有错误返回格式统一：`{ code, message, data: { code, httpStatus, path } }`
- [ ] 开发环境保留 stack trace
- [ ] 不改变现有业务逻辑

---

### P1 — API 集成测试套件（高优先级）

**问题：** 项目零测试覆盖，29 个 API router、19 个前端页面没有任何测试。改代码全靠胆量。

**方案：** 使用 vitest（已有依赖）为核心 API 流程添加 smoke tests，覆盖关键路径。

**涉及文件：**
- 新建 `tests/api/task-flow.test.ts` — 任务创建→分配→执行→完成的完整流程
- 新建 `tests/api/agent-flow.test.ts` — Agent 注册→心跳→状态查询
- 新建 `tests/api/message-flow.test.ts` — 消息发送→inbox→ACK
- 新建 `tests/setup.ts` — 测试数据库初始化

**具体步骤：**
1. 创建 `tests/` 目录结构
2. 写 `tests/setup.ts`：创建内存 SQLite 数据库（或使用现有 MySQL 测试库），导入 schema
3. `tests/api/task-flow.test.ts`：
   - 测试创建任务（task.create）
   - 测试查询任务列表（task.list）
   - 测试更新任务进度（task.updateProgress）
   - 测试任务状态流转（pending→queued→running→done）
4. `tests/api/agent-flow.test.ts`：
   - 测试 Agent 注册
   - 测试心跳更新
   - 测试 Agent 列表
5. `tests/api/message-flow.test.ts`：
   - 测试发送消息
   - 测试 inbox 查询
   - 测试 ACK
6. 在 `package.json` 的 `test` script 中加入 `vitest run tests/`

**验收标准：**
- [ ] `npm test` 通过，所有测试绿色
- [ ] 任务 CRUD + 状态流转测试通过
- [ ] Agent 心跳测试通过
- [ ] 消息发送+接收测试通过
- [ ] 测试使用独立的数据库（不影响生产数据）

---

### P2 — 前端导航与路由对齐（低优先级）

**问题：** 导航菜单中 `/dag` 有入口但路由已指向 `/tasks/:id`（TaskDetail），而 `/account` 和 `/login` 路由在导航中没有入口。

**方案：** 导航菜单加入 `/account` 入口（账户设置），保持其他不变。

**涉及文件：**
- `src/sections/Navigation.tsx` — 添加账户设置入口

**具体修改：**
- 在"工具"或"系统"分组中添加 `{ path: '/account', label: '账户', icon: <User size={15} /> }`（`User` icon 已在 import 中）

**验收标准：**
- [ ] 导航菜单中出现"账户"入口
- [ ] 点击后跳转到 `/account` 页面

---

### P3 — 文档与部署确认（低优先级）

**问题：** 需要验证当前代码变更后的部署流程。

**方案：** 确认 git push 后 Zeabur 自动部署行为。

**步骤：**
1. 提交当前变更到 GitHub（`git add` + `git commit`）
2. 推送到 origin（`git push`）
3. 检查 Zeabur 是否自动触发部署

---

## 执行优先级

```
P0 — 统一错误处理中间件   (30min)
P1 — API 集成测试套件     (1.5h)
P2 — 导航对齐             (15min)
P3 — 部署确认             (15min)
```

## 验收清单

- [ ] P0: 所有错误响应格式统一
- [ ] P1: `npm test` 全部通过
- [ ] P1: 任务、Agent、消息三个核心流程有测试覆盖
- [ ] P2: 导航中出现账户入口
- [ ] P3: 代码推送到 GitHub，Zeabur 部署成功
