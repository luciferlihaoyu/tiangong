# TIANGONG P8.3 — 协作指挥台与自动汇总

> **状态**: 本地实现完成  
> **日期**: 2026-06-14  
> **依赖**: P8.1 可靠消息总线、P8.2 协作编排 API

## 1. 目标

P8.3 把 P8.2 的后端协作编排推进到可日常使用：

1. 在任务指挥中心提供协作面板。
2. 从 UI 选择父任务、协调 Agent、显式输入子任务列表并委托。
3. 在 UI 查看子任务状态、委托消息投递/ACK、结构化汇总。
4. 子任务完成/失败时自动触发协作汇总广播。
5. 依赖完成后自动/手动推进 ready 子任务进入 `queued`。

## 2. 后端事件

新增共享 helper：`api/lib/collaboration-events.ts`

- `unblockReadyCollabTasks(parentTaskId)`：检查 parent 下 pending 子任务，依赖都 done 时推进 queued。
- `buildCollabSummary(parentTaskId)`：复用 P8.2 汇总语义，返回 outputs/errors/status counts/message counts。
- `emitCollabSummaryForTask(taskId)`：子任务 done/failed 后自动 unblock + broadcast `collab_summary`。

接入点：

- `task.updateProgress`：connector 或手动更新任务为 done/failed 时触发。
- `orch.updateStatus`：前端/编排路由更新任务为 done/failed 时触发。
- `TaskRunner` 直写 DB 路径：mock/command/gateway runner 完成或失败时触发。

Dashboard WebSocket 事件：

- `collab_summary`
- `collab_unblocked`
- `collab_delegation_message`

## 3. 前端面板

`src/pages/TaskCenter.tsx` 新增 `CollaborationPanel`：

- 父任务选择：只显示 `parentTaskId == null` 的任务。
- 协调 Agent 选择。
- 子任务输入格式：

```text
标题 | Agent数字ID | 优先级 | 描述
调研方案 | 1 | 3 | 收集背景和约束
实现原型 | 2 | 4 | 输出可验证改动
```

- 点击「创建并委托」调用 `collab.delegate`。
- 点击「推进可运行子任务」调用 `collab.unblockReady`。
- 右侧显示 `collab.status` / `collab.summary`：
  - 状态计数
  - 子任务列表
  - Agent
  - 消息状态
  - ACK 状态
  - 输出/错误数量

## 4. 实时刷新

TaskCenter 已监听 Dashboard WebSocket：

- `task_update` → 刷新任务列表。
- `collab_summary` / `collab_unblocked` / `collab_delegation_message` → 刷新任务与协作查询。

## 5. 验收

1. 创建一个父任务。
2. 在 P8.3 协作编排台选择父任务和协调 Agent。
3. 输入 2+ 行子任务并委托。
4. 确认子任务出现在任务列表，且右侧协作状态显示消息状态。
5. 将某个子任务标记 done/failed。
6. 确认协作汇总刷新，依赖满足的 pending 子任务可进入 queued。

## 6. 边界

- 不自动 LLM 拆解。
- 不修改生产 runner 默认模式。
- 不修改 OpenClaw Gateway 配置。
- 不修改 Zeabur env。
- 不 commit/push/deploy。
