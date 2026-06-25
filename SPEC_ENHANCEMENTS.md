# 天宫功能完善 Spec（7项）

## 1. 后土定时扫描（高优先级）
**问题：** 后土 runner 只在 Connector 启动时执行一次 dispatch 扫描，之后不再扫描新任务。
**方案：** 修改 `runner-houtu.sh`，在启动时执行一次扫描后，进入定时循环（每 30 秒扫描一次 queued 任务）。
**文件：** `scripts/openclaw-connector/runner-houtu.sh`
**要点：**
- 启动时立即扫描一次
- 之后每 30 秒循环扫描
- 扫描脚本调用 `node lib/dispatch-strategy.mjs houtu`
- 循环不能阻塞 Connector 的心跳和 inbox 处理（runner 脚本是在 Connector 启动时执行的，需要在后台运行循环）
- 实际实现：把 dispatch 循环放到一个独立的 background 进程，runner 脚本前台 exec runner.mjs

## 2. 薇子定时转发（高优先级）
**问题：** 薇子 runner 也只在启动时执行一次 forward 扫描。
**方案：** 同后土，修改 `runner-weizi.sh`，加定时循环（每 30 秒扫描一次 inbox）。
**文件：** `scripts/openclaw-connector/runner-weizi.sh`
**要点：**
- 同后土模式：后台循环 + 前台 exec runner.mjs
- 扫描脚本调用 `node lib/dispatch-strategy.mjs weizi`

## 3. 任务执行结果回写（高优先级）
**问题：** Connector 认领任务后 output 只是"消息已投递到 OpenClaw session"，没有真正回收执行结果。
**方案：** 增强 Connector 的任务执行流程，让 Runner 执行完后把实际 output 回写到天宫。
**文件：** `scripts/openclaw-connector/connector.mjs` + `scripts/openclaw-connector/runner.mjs`
**要点：**
- Runner 执行完任务后，通过 stdout 输出结果
- Connector 捕获 Runner 的 stdout，调用 `task.updateProgress` 或 `task.update` 把 output 回写
- 状态流转：claimed → running → done（有 output）/ failed（有 error）
- 需要区分"投递确认"和"实际执行结果"

## 4. API 鉴权分层（中优先级）
**问题：** 所有路由都是 `publicQuery`，没有鉴权，天宫暴露在公网上。
**方案：** 增加 API Key 鉴权中间件，区分公开接口和需要认证的接口。
**文件：** `api/middleware.ts` + 各 router
**要点：**
- 保留 `publicQuery` 用于：ping、agent.list（只读）、heartbeat
- 新增 `authedQuery` 需要请求头带 `x-api-key` 或 `x-mcp-key`
- 需要认证的接口：task.create、task.delete、task.update、mailbox.send、org/dept/agent 的写操作
- 从 secrets 或数据库验证 API Key
- 前端也需要适配（如果前端有管理界面的话）

## 5. 成本追踪启用（中优先级）
**问题：** pricing 和 usage API 都有了，但 Connector 执行任务时没有自动记录 token 消耗。
**方案：** 在 Connector 执行任务后，自动调用 `usage.record` 记录 token 消耗。
**文件：** `scripts/openclaw-connector/connector.mjs`
**要点：**
- Runner 执行任务后，解析 token 消耗（如果 Runner 输出中有）
- 调用 `usage.record` API 记录
- 包含：model、promptTokens、completionTokens、agentId、taskId、source="connector"
- 如果 Runner 没有输出 token 信息，至少记录 callCount=1

## 6. 审批节点（低优先级）
**问题：** task 状态机没有 review 状态，任务完成后不能审批退回。
**方案：** 在 task 状态机中增加 `review` 状态和审批 API。
**文件：** `api/task-router.ts` + `api/orchestration-router.ts`
**要点：**
- 新增 `task.submitForReview` mutation：done → review
- 新增 `task.approve` mutation：review → completed
- 新增 `task.reject` mutation：review → running（退回重做）
- lifecycleStatus 增加 reviewing 状态
- 审批通过后可以附注审批意见

## 7. 前端 Mailbox 消息面板（低优先级）
**问题：** 前端没有 mailbox 消息列表 UI。
**方案：** 在前端增加 Mailbox 面板，展示助手间的通信记录。
**文件：** `src/pages/` 新增 MailboxPanel.tsx
**要点：**
- 列表展示所有 mailbox 消息（支持按 agent 筛选）
- 显示：from、to、subject、body、status、时间
- 支持回复操作（可选）
- 可以放在现有的 Tab 导航中

## 技术参考
- 天宫 API: `https://tiangg.zeabur.app/api/trpc/{router}.{method}`
- 所有源码在 `/home/node/.openclaw/workspace-meizhizi/tiangong/` 目录
- 前端在 `src/` 目录，后端在 `api/` 目录
- 数据库 schema 在 `db/schema.ts`
- Connector 在 `scripts/openclaw-connector/`
- 不要修改 secrets 文件和 start-openclaw-agents.sh
