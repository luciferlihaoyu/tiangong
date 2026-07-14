# 🏯 天宫完善执行规划报告

> **当前基线：** commit `62eeae3`（2026-06-30）
> **代码量：** API ~14.5K 行 + 前端 ~23.5K 行 + Connector 脚本
> **线上：** https://tiangg.zeabur.app ✅

---

## 📊 现状全景图：已完成的 vs 待完成的

我重新审视了代码库（而非仅凭上次印象），发现**多个缺口其实已经被部分或完全实现**。以下是精确的当前状态：

### ✅ 已完成的（从缺口清单中移除）

| # | 缺口 | 现状 | 证据 |
|---|------|------|------|
| 1 | Connector 结果回写 | **已完成** | commit `4425068` — runner.mjs 等待 Agent 回复，connector.mjs 有 buildTaskPrompt 回写指令，task.update 支持 output 字段 |
| 2 | 任务详情页 | **已完成** | commit `4425068` — TaskCenter 新增 TaskDetailDrawer（生命周期时间线 + 工件列表）；commit `62eeae3` — TaskDetail.tsx 审批面板 |
| 3 | 仪表盘数据真实化 | **已完成** | commit `62ee83e` — SystemMonitor 从随机数改为真实统计（CPU任务吞吐、RAM在线Agent、NET最近24h任务） |
| 4 | 后土/薇子定时扫描 | **已完成** | runner-houtu.sh 已有后台 30 秒循环扫描；runner-weizi.sh 同模式 |
| 5 | API 鉴权分层 | **大部分已完成** | middleware.ts 定义了 authedQuery/userQuery/adminQuery，大部分 router 已使用；仅剩 execution-router / ops-router / plan-router 仍用 publicQuery |
| 6 | 成本追踪 | **部分完成** | runner.mjs 有 reportUsage 函数（估算 token 消耗），connector.mjs 传递 TIANGONG_TASK_ID，但未调用 usage.record API，只是 console.log |
| 7 | 审批节点 | **已完成** | commit `62eeae3` — TaskDetail 已有审批面板（通过/退回/拒绝）+ 审批历史；task-router.ts 有 reviewing 状态和 submitForReview |
| 8 | Mailbox 面板 | **已完成** | commit `62eeae3` — MailboxPanel 新增标记已读/关闭/回复操作 |

### 🟡 仍待完善的缺口

经过精确审计，真正的待办事项是：

| 优先级 | 项目 | 状态 | 说明 |
|--------|------|------|------|
| **P0** | Connector 成本追踪未接入 API | 🟡 半完成 | `reportUsage` 只是本地估算+console.log，没有调后端 `usage.record` API 入库 |
| **P1** | 3 个 router 仍用 publicQuery | 🟡 需加固 | `execution-router.ts`、`ops-router.ts`、`plan-router.ts` 所有接口仍公开 |
| **P1** | Connector 结果回写缺少异常处理 | 🟡 待增强 | 回写逻辑有，但 Runner 超时/失败时状态流转不完整 |
| **P2** | 前端任务详情页路由缺失 | 🟡 待增强 | 有 TaskDetailDrawer（弹窗）但独立 `/tasks/:id` 路由页面未添加 |
| **P2** | 线上部署未同步最新代码 | 🔴 确认中 | Zeabur 当前跑的是哪个 commit？需检查 |

---

## 🎯 执行规划（按优先级）

### P0 — 立刻执行（1-2 小时）

#### 1. Connector 成本追踪接入后端 API

**目标：** Connector 执行任务后自动调 `usage.record` API 记录 token 消耗

**涉及文件：**
- `scripts/openclaw-connector/runner.mjs` — 修改 `reportUsage` 函数
- `scripts/openclaw-connector/connector.mjs` — 确保任务完成后触发记录

**具体步骤：**
1. `runner.mjs` 的 `reportUsage` 当前只 `console.log` → 改为 HTTP POST 到天宫 `/api/trpc/usage.record`
2. 参数：model、promptTokens、completionTokens、agentId、taskId、source="connector"
3. 如果 Runner 没有输出 token 信息，至少记录 callCount=1
4. 错误不能阻断主流程（try-catch + console.warn）

**验收标准：**
- [ ] Connector 执行任务后，usage 表出现对应记录
- [ ] UsagePanel 能看到 Connector 执行产生的 token 消耗
- [ ] 记录失败不导致任务状态异常

---

### P1 — 次优先（1-2 小时）

#### 2. 剩余 3 个 router 鉴权加固

**目标：** 让 execution-router、ops-router、plan-router 从 publicQuery 升级到合适的鉴权级别

**涉及文件：**
- `api/execution-router.ts` — 改为 authedQuery
- `api/ops-router.ts` — 改为 authedQuery（agentStatus 可公开？考虑保留为 publicQuery 但加上速率限制）
- `api/plan-router.ts` — 改为 authedQuery

**具体步骤：**
1. 审查每个路由的功能，决定鉴权级别
2. `execution-router`: 执行日志应只对认证用户开放 → authedQuery
3. `ops-router`: agentStatus/taskStats/recentTasks 可公开（仪表盘用），recentModelCalls 需认证 → 混合
4. `plan-router`: 所有计划操作需认证 → authedQuery
5. 确保前端使用 token 或 API key 访问这些接口

**验收标准：**
- [ ] 未认证请求执行/计划/ops 敏感接口返回 401
- [ ] 前端正常功能不受影响
- [ ] Connector 使用 API Key 仍能正常访问

#### 3. Connector 异常处理增强

**目标：** Runner 超时/失败时，任务状态正确流转到 failed 并记录 error

**涉及文件：**
- `scripts/openclaw-connector/runner.mjs` — 捕获异常并回写
- `scripts/openclaw-connector/connector.mjs` — 超时处理

**具体步骤：**
1. runner.mjs 的 callGatewayWithReply 加入 timeout 捕获
2. 失败时调 `task.updateProgress({ status: "failed", error: msg })`
3. connector.mjs 的 executeTask 加入整体超时 guard

**验收标准：**
- [ ] Agent 超时或无响应时任务变为 failed
- [ ] 失败任务有 error 信息可查看

---

### P2 — 持续完善（1-2 小时）

#### 4. 独立任务详情页路由

**目标：** 除了弹窗 Drawer，增加 `/tasks/:id` 独立页面，方便分享和深度查看

**涉及文件：**
- 新建或增强 `src/pages/TaskDetail.tsx`
- `src/App.tsx` — 添加路由

**具体步骤：**
1. 创建 `/tasks/:id` 路由，加载 `task.getById`
2. 页面包含：任务信息、input/output、生命周期时间线、审批面板、成本记录
3. 复用已有的 TaskDetailDrawer 组件逻辑

**验收标准：**
- [ ] 访问 `/tasks/1` 可看到任务详情
- [ ] 从任务列表可跳转到详情页
- [ ] 页面不报错

#### 5. 确认线上部署同步

**目标：** 确保 Zeabur 线上跑的是最新代码

**步骤：**
1. 检查 Zeabur 部署状态
2. 如果落后，手动触发部署

---

## 📋 时间线总览

```
Day 1 (今天)：
  ├─ P0: Connector 成本追踪接入 API          (~1h)
  └─ P1: 剩余 router 鉴权加固                (~1h)

Day 2：
  ├─ P1: Connector 异常处理增强              (~1h)
  ├─ P2: 独立任务详情页路由                   (~1h)
  └─ P2: 线上部署确认                        (~0.5h)
```

## 🔄 总结

**现状修正：** 上次分析的 7 个缺口中，5 个（结果回写、任务详情、仪表盘、定时扫描、审批/Mailbox）实际上在 6/27-6/30 已经实现了。当前真正的待办是 **3 项**（成本追踪接入 API、鉴权扫尾、异常处理增强）+ 一些增强和部署确认。

可以按这个规划开始执行，先从 P0 开始。
