# 天宫 P12：阶段 6 — 审核与长期工作流 Spec

> 状态：Spec 待实现
> 日期：2026-06-22
> 依赖：Phase 1（AgentCard + 状态机）✅ 已部署、Phase 2（Kanban UI）✅ 已部署

## 背景

A2A-lite 六阶段规划的最后一块。Phase 1 和 Phase 2 已部署线上（AgentCard、状态机、Kanban UI、Agent 工具 API），Phase 3 即阶段 6 需要补上：

1. **审核流**：review → approved/changes_requested/rejected → done
2. **通知机制**：任务状态变更通知
3. **自动 promote**：子任务完成后自动推进父任务
4. **阻塞依赖链可视化**

## 目标

### P0 — 审核流程闭环

1. **审核人指派**
   - 任务创建/编辑时可指定 `reviewerId`（审核人）
   - 任务进入 `review` 状态时，自动通知审核人
   - 审核人通过 `taskboard.approve` / `taskboard.reject` / `taskboard.requestChanges` 操作

2. **审核操作**
   - `approve`：review → done，写入 `reviewResult=approved`，记录审核时间
   - `reject`：review → failed，写入 `reviewResult=rejected`，记录审核意见
   - `requestChanges`：review → running，写入 `reviewResult=changes_requested`，记录修改意见
   - 所有审核操作写入 `task_messages` 审计事件

3. **审核面板**
   - Kanban 的 Review 列显示审核人信息
   - 审核人可看到分配给自己的待审核任务列表
   - 审核操作按钮（Approve / Request Changes / Reject）
   - 审核意见输入框

### P1 — 通知机制

4. **任务状态变更通知**
   - 任务状态变更时通过 WebSocket 广播 `task_notification` 事件
   - 通知内容：任务名、旧状态→新状态、变更人、时间
   - 前端收到通知后显示 toast 提示

5. **审核通知**
   - 任务进入 review 时，通知审核人
   - 审核完成时，通知任务 assignee
   - 通过 Mailbox 消息发送（复用已有 mailbox.send）

### P2 — 自动 Promote 与依赖链

6. **子任务自动 promote**
   - 父任务的所有子任务都 done 后，自动将父任务从 running → review
   - 实现方式：子任务 done/failed 时检查父任务的子任务完成状态

7. **阻塞依赖链可视化**
   - 任务详情中显示依赖链（task_dependencies）
   - 被阻塞的任务显示阻塞原因和阻塞方
   - 依赖解除后自动 unblock

## 修改文件清单

### 后端
1. **`api/taskboard-router.ts`**
   - 新增 `approve`、`reject`、`requestChanges` 路由
   - 新增 `listReviewTasks` 路由（查询待审核任务）
   - 审核操作写入 task_messages 审计事件
   - 审核完成后广播 WS 通知

2. **`api/lib/taskboard-validator.ts`**
   - 补充 review → done/failed/running 的流转规则
   - 审核状态校验（只有 reviewer 可以 approve/reject）

3. **`api/lib/collaboration-events.ts`**（或新建 `api/lib/taskboard-notify.ts`）
   - 任务状态变更通知逻辑
   - 子任务自动 promote 逻辑
   - 依赖链解除检查

### 前端
4. **`src/components/taskboard/TaskDetailModal.tsx`**
   - 审核面板：审核人信息、审核操作按钮、审核意见输入
   - 依赖链可视化

5. **`src/pages/TaskBoard.tsx`**
   - Review 列显示审核人
   - 通知 toast

## 验收清单

| # | 验收项 | 状态 |
|---|--------|------|
| P0.1 | 任务可指定审核人 | ⬜ |
| P0.2 | approve: review → done | ⬜ |
| P0.3 | reject: review → failed | ⬜ |
| P0.4 | requestChanges: review → running | ⬜ |
| P0.5 | 审核操作写入审计事件 | ⬜ |
| P0.6 | 审核面板：待审核任务列表 | ⬜ |
| P1.1 | WS 任务通知广播 | ⬜ |
| P1.2 | 审核通知通过 Mailbox 发送 | ⬜ |
| P2.1 | 子任务自动 promote 父任务 | ⬜ |
| P2.2 | 依赖链可视化 | ⬜ |
