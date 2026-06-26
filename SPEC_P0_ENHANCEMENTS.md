# Spec：天宫 P0 功能完善（三项）

## 1. 任务结果回写

### 目标
Connector 执行任务后，把 Agent 的实际执行结果写回天宫的任务记录，而不是只记录"已投递"。

### 现状
- Connector 认领任务 → 把 prompt 投递到 Agent session → 标记任务为 `running`
- 但无论 Agent 执行结果如何，任务最终只更新到"已投递"，没有回收 output

### 方案
增强 Connector 的执行流程：

```
任务 claimed → Connector 投递到 Agent
  → Agent 执行完成
  → Connector 捕获 Agent 的输出（stdout/结果）
  → 调 task.update API 把 output 写回天宫
  → 任务状态流转：claimed → running → done(output)/failed(error)
```

### 涉及文件
- `scripts/openclaw-connector/connector.mjs` — 主连接器逻辑
- `scripts/openclaw-connector/runner.mjs` — Runner 执行器
- 可能需要新建 `scripts/openclaw-connector/lib/result-collector.mjs`

### 验收标准
- [ ] Connector 执行任务后，任务在天宫显示实际 output
- [ ] 失败的任务记录 error 信息
- [ ] 不破坏现有流程（心跳、inbox 查询等）

---

## 2. 前端任务详情页

### 目标
点击任务列表中的某个任务，弹窗或跳转查看完整信息：任务名称、描述、分配 Agent、状态流转历史、input/output、执行日志。

### 现状
- 任务列表显示了 ID、名称、状态、进度
- 但没有详情页，无法查看任务的完整生命周期

### 方案
新增一个任务详情页面（`/tasks/:id`）或 Dialog 弹窗，展示：

```
┌─────────────────────────────┐
│ 任务详情                     │
│ 任务ID: TSK-001             │
│ 名称: 数据清洗               │
│ 状态: Running 🔴            │
│ 创建: 2026-06-25 14:00     │
│ 分配给: 女娲 (id=1)         │
│                             │
│ ── 描述 ──                  │
│ 清洗用户数据中的重复记录...   │
│                             │
│ ── Input ──                 │
│ { "source": "db/users" }    │
│                             │
│ ── Output ──                │
│ { "cleaned": 1234, ... }    │
│                             │
│ ── 状态流转 ──              │
│ created → queued →          │
│ dispatched → running → done │
└─────────────────────────────┘
```

### 涉及文件
- 新建 `src/pages/TaskDetail.tsx`
- 修改 `src/App.tsx` 添加路由
- 可能需要添加 tRPC query（如果后端没有 getTaskById）

### 验收标准
- [ ] 点击列表任务可查看详情
- [ ] 显示完整生命周期
- [ ] 显示 input/output
- [ ] 页面加载不报错

---

## 3. 仪表盘数据真实化

### 目标
Dashboard 上目前 Mock 的数据（系统资源 CPU/RAM/NET、在线状态等）改为从真实 API 获取或至少展示有意义的数据。

### 现状
- `SystemMonitor` 组件用 `Math.random()` 模拟 CPU/RAM/NET
- `StatsRow` 统计来自本地 Mock 数据
- 系统时间 `LiveClock` 是真实的 ✅（这个不用改）

### 方案
分两档：

**第一档（简单）：**
- CPU/RAM 从浏览器 `navigator.hardwareConcurrency` 和 `performance.memory` 获取（前端能拿到的）
- 或者在 Zeabur 后端加一个 `/api/system/health` 返回容器资源

**第二档（推荐）：**
- Dashboard 统计直接调天宫已有的 tRPC API（任务数、Agent 数等已有后端数据）
- 移除 `useEffect` 的随机数，改为真实数据

### 涉及文件
- `src/sections/Dashboard.tsx` — SystemMonitor / StatsRow 组件

### 验收标准
- [ ] CPU/RAM 不再显示随机跳动
- [ ] 统计数据反映实际数据库内容
- [ ] 页面不报错
