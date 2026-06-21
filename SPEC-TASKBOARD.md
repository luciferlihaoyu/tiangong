# 天宫任务板 (Tiangong TaskBoard) — 完整构想

> 基于 A2A-lite 六阶段规划 + OpenClaw Workboard 启发
> 2026-06-21

---

## 与六阶段规划的关系

### 已完成的基础（A2A-lite v0.1 ~ v0.2）
- ✅ 阶段 3（TaskThread）：任务线程 + task_messages + task_artifacts
- ✅ 阶段 4（三段式协议）：dispatch → ACK → result，lifecycleStatus 状态机
- ✅ 阶段 5 子集（Mailbox）：mention / subtask / handoff

### TaskBoard 覆盖的阶段

| 阶段 | 内容 | TaskBoard 对应 |
|------|------|---------------|
| **阶段 1** | Agent 身份卡 | Phase 1：AgentCard 数据结构 + API |
| **阶段 2** | 重做任务状态机 | Phase 1：boardStatus 扩展 + 流转校验 |
| **阶段 3** | TaskThread（已有） | 复用现有 task_messages |
| **阶段 4** | 三段式协议（已有） | 复用现有 dispatch/ack/result |
| **阶段 5** | 助手间通信（Mailbox 已有） | 新增 Agent 工具集（claim/heartbeat/submit 等） |
| **阶段 6** | 审核与工作流 | Phase 3：review → done 审核 + 自动 promote |

### 实际开发顺序（TaskBoard 视角）

| 轮次 | 内容 | 对应阶段 |
|------|------|---------|
| **Phase 1（当前轮）** | AgentCard + 状态机升级 + Agent 工具 API | 阶段 1 + 2 + 5 子集 |
| **Phase 2** | Kanban UI | 阶段 5 子集 |
| **Phase 3** | 审核流 + 通知 + 自动 promote | 阶段 6 |

---

## 一、核心定位

天宫任务板不是简单的任务列表 UI，而是 **多助手协作的任务中枢**：

- 助手可以通过 API/工具自行管理任务（claim / report progress / submit result）
- L 可以通过 UI 创建、分配、跟踪任务
- 任务状态机完整可靠，不允许假完成
- 任务线程支持助手间交流（mention / subtask / handoff 已有）

---

## 二、任务状态机（完整版）

借鉴 Workboard 的状态链，结合天宫已有的 lifecycleStatus：

```
triage ──→ backlog ──→ todo ──→ ready ──→ running ──→ review ──→ done
                  ↑                      ↑       ↓           ↓
                  └── blocked ←──────────┘       failed ───→ cancelled
```

| 状态 | 含义 | 谁可以设 |
|------|------|---------|
| `triage` | 新任务，未评估 | L / 任何助手 |
| `backlog` | 已评估但未排期 | L / 主管助手 |
| `todo` | 已排期，等待分配 | L / 主管助手 |
| `ready` | 已分配，等待助手领取 | 系统自动（分配后） |
| `running` | 助手正在执行 | 助手 claim 后 |
| `review` | 执行完成，等待审核 | 助手 submit 后 |
| `blocked` | 被阻塞 | 任何参与者 |
| `done` | 审核通过，已完成 | 审核者 |
| `failed` | 执行失败 | 系统 / 助手 |
| `cancelled` | 已取消 | L / 主管助手 |

### 核心规则（不可违反）

1. **没有 submitted 绝不能 completed** ✅ 已有
2. **只有 assignee 可以 claim 任务**
3. **claim 后必须定期 heartbeat**（超时自动释放）
4. **review 状态必须有人审核才能 done**
5. **blocked 必须记录原因**
6. **父子任务：父任务 done 前子任务不能 promoted 到 ready**

---

## 三、Agent 工具集（借鉴 Workboard）

每个助手应该能通过天宫 API 调用以下工具管理自己的任务：

| 工具 | 功能 |
|------|------|
| `taskboard.list` | 查看自己的任务列表（按状态筛选） |
| `taskboard.get` | 查看任务详情 + 线程消息 + artifacts |
| `taskboard.claim` | 领取一个 ready 任务 → 设为 running |
| `taskboard.heartbeat` | 执行中定期心跳，防止超时释放 |
| `taskboard.release` | 释放任务（让给其他人 / 暂停） |
| `taskboard.progress` | 更新进度百分比 + 状态说明 |
| `taskboard.submit` | 提交结果 → 设为 review |
| `taskboard.block` | 标记阻塞 + 原因 |
| `taskboard.unblock` | 解除阻塞 → 回到之前状态 |
| `taskboard.comment` | 在任务线程中添加评论 |
| `taskboard.mention` | @某个助手到任务线程 ✅ 已有 |
| `taskboard.createSubtask` | 创建子任务 ✅ 已有 |
| `taskboard.handoff` | 移交任务给其他人 ✅ 已有 |

---

## 四、任务卡片结构

借鉴 Workboard 的卡片设计，扩展天宫现有 tasks 表：

```typescript
interface TaskCard {
  // ── 基础字段（已有） ──
  id: number
  taskId: string        // TG-XXXXX
  name: string
  description: string
  agentId: number       // assignee
  status: string        // 简略状态
  priority: number      // 0-100
  input: string         // 任务输入
  output: string        // 任务输出/结果
  error: string

  // ── 新增字段 ──
  boardStatus: string   // triage|backlog|todo|ready|running|review|blocked|done|failed|cancelled
  boardLabels: string[] // 标签
  boardNotes: string    // 备注/笔记
  sourceUrl: string     // 来源链接（GitHub issue / 飞书文档等）
  
  // ── 父子任务（已有 parentTaskId） ──
  parentTaskId: number
  
  // ── 生命周期时间戳（已有） ──
  claimedAt: Date
  dispatchedAt: Date
  acceptedAt: Date
  completedAt: Date
  failedAt: Date
  
  // ── 新增时间戳 ──
  triagedAt: Date
  backloggedAt: Date
  readyAt: Date
  reviewAt: Date
  blockedAt: Date
  unblockedAt: Date
  
  // ── 心跳 ──
  lastHeartbeatAt: Date
  heartbeatIntervalMs: number  // 默认 300000 (5min)
  
  // ── 审核 ──
  reviewerId: number          // 审核人
  reviewResult: string        // approved|changes_requested|rejected
  
  // ── 元数据 ──
  createdAt: Date
  updatedAt: Date
}
```

---

## 五、UI 视图

### 5.1 Kanban 板
- 列：Triage / Backlog / Todo / Ready / Running / Review / Blocked / Done
- 每列显示卡片数量
- 拖拽移动卡片（改变 boardStatus）
- 点击卡片查看详情

### 5.2 任务详情页
- 基础信息（名称、描述、优先级、标签）
- 当前状态 + 状态流转历史
- Assignee 信息
- 任务线程（task_messages 按时间线展示）
- Artifacts 列表
- 子任务列表
- 操作按钮（claim / submit / block / handoff 等）

### 5.3 我的任务视图
- 只看当前登录助手/用户的任务
- 按状态分组
- 支持筛选（优先级、标签、关键词）

### 5.4 任务创建弹窗
- 名称、描述、优先级、标签
- Assignee 选择
- 父任务选择
- 来源链接
- 初始状态（默认 triage）

---

## 六、实现路线

### Phase 1：后端状态机升级 + Agent 工具（当前轮）
1. 扩展 tasks 表：新增 `boardStatus`、`boardLabels`、`boardNotes`、`sourceUrl`、心跳字段、审核字段
2. 迁移现有任务的 `lifecycleStatus` → `boardStatus`
3. 新增 `taskboard.*` API endpoint（claim / heartbeat / progress / submit / block / unblock / comment）
4. 状态流转校验：不允许非法跳转
5. 超时释放机制：claim 后无 heartbeat 自动释放

### Phase 2：Kanban UI（下一轮）
1. 天宫前端新增 TaskBoard 页面
2. Kanban 列视图
3. 拖拽移动卡片
4. 任务详情弹窗
5. 任务创建弹窗

### Phase 3：审核与通知（再下一轮）
1. review → done 审核流程
2. 任务状态变更通知（飞书/Telegram）
3. 子任务自动 promote
4. 阻塞依赖链可视化

---

## 七、与 OpenClaw Workboard 的差异

| 维度 | OpenClaw Workboard | 天宫 TaskBoard |
|------|-------------------|----------------|
| 存储 | Gateway SQLite（本地） | MySQL（共享持久化） |
| 范围 | 单 Gateway | 多助手协作平台 |
| Agent 工具 | 内置插件工具 | 天宫 API + 助手调用 |
| 审核流 | 无专门审核状态 | review → done 审核流程 |
| 任务线程 | 有限（comments） | 完整 task_messages 线程 |
| 子任务 | link/promote | 原生 parentTaskId + subtask |
| 外部集成 | GitHub Issues 等 | 计划中 |
| 持久化 | Gateway 状态目录 | MySQL 数据库 |
