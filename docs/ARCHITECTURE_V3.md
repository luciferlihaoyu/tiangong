# 天宫 v3 架构演进规划

> 基于后土《天庭科技 Agent 系统架构演进规划》+ HiveWard 参考 + 当前线上状态分析
> 2026-06-10

---

## 当前状态 (v2.1)

### ✅ 已完成
- 7 Agent 注册 + 组织架构（天宫科技 → 4部门）
- 任务 CRUD + DAG 依赖 + 状态机 + 循环检测 + 拓扑排序
- MCP API Key 管理（创建/查看/撤销/审计日志）
- 心跳上报 API（`updateHeartbeat`）
- 消息系统（Agent 间 command/response/broadcast/system）
- 前端：仪表盘/组织架构/任务编排/MCP接入 4 个 Tab
- WebGL 降级（静态 fallback 避免白屏）
- Zeabur 部署 `https://tiangg.zeabur.app`

### ❌ 当前问题
1. **连接状态判定** — 心跳更新了 `lastHeartbeat` 但 `status` 未同步为 `online`（已修复）
2. **MCP 接入未跑通** — 前端有 MCP 管理面板，但没有 Agent 真正通过 MCP 接入
3. **消息系统空转** — 0 条消息，Agent 间通信未验证
4. **任务执行闭环未通** — 只有 1 个测试任务，0 完成
5. **成本追踪未启用** — `budgetCents/spentCents` 字段存在但无实际消耗记录

---

## v3 架构演进路线

### P0 — 核心闭环（本周）

| # | 任务 | 描述 |
|---|------|------|
| 1 | ✅ 心跳同步 status | `updateHeartbeat` 同时设 `status=online` |
| 2 | ✅ 连接判定窗口 | 5分钟→10分钟，避免时区偏差 |
| 3 | Agent 接入向导 | 前端 MCP 面板增加"接入指南"：生成 Key → 配置 Cron 心跳 → 验证在线 |
| 4 | 任务认领 API | Agent 心跳时查询待分配任务，自动认领并更新状态 |
| 5 | 端到端测试 | 美智子/编程大师接入 → 创建任务 → 心跳认领 → 执行 → 完成 |

### P1 — 平台能力（本周-下周）

| # | 任务 | 描述 | 来源 |
|---|------|------|------|
| 6 | 成本追踪 | 任务完成时记录 token 消耗，更新 `spentCents`，超预算告警 | README 声称 |
| 7 | 消息面板 | 前端消息列表 + Agent 间实时通信 UI | 当前 0 消息 |
| 8 | 任务执行历史 | 任务时间线、重试记录、输出归档 | HiveWard |
| 9 | 审批节点 | 任务状态机加 `review` 状态，人工审批后流转 | HiveWard |
| 10 | 系统概览增强 | 7日任务趋势、Agent 负载分布、成本趋势图 | 后土建议 |

### P2 — 智能调度（下周+）

| # | 任务 | 描述 | 来源 |
|---|------|------|------|
| 11 | Direct/Plan/Research 工作流 | 任务类型标记，不同类型走不同执行策略 | 后土建议 |
| 12 | Agent Eval | 任务完成后自动评估质量，反馈到 Agent 能力评分 | 后土建议 |
| 13 | 蓝图画布 | 拖拽式 DAG 编排，替代表格 | HiveWard |
| 14 | Harness 适配层 | OpenClaw Agent 标准接入 SDK（心跳/状态/任务同步） | HiveWard |

### P3 — 生态扩展（远期）

| # | 任务 | 描述 |
|---|------|------|
| 15 | 多租户 | 多公司隔离，独立数据/Agent/预算 |
| 16 | Webhook 通知 | 任务完成/失败/审批 → 飞书/Telegram/Discord |
| 17 | 模板市场 | 组织架构 + 任务流模板导入导出 |

---

## 后土架构建议对照

后土建议的核心要素 → 天宫映射：

| 后土建议 | 天宫现状 | 差距 |
|----------|----------|------|
| Direct 工作流 | 任务状态机 (pending→queued→running→done) | 缺少 Direct 快速通道 |
| Plan 工作流 | DAG 依赖 + 拓扑排序 | 缺少子任务自动拆解 |
| Research 工作流 | 无 | 需新增深度研究任务类型 |
| Agent Eval | 无 | 需新增评估体系 |
| 理解→规划→执行→验证→交付 | 只有执行部分 | 需补齐其他 4 阶段 |

---

## 技术债务

1. **tRPC mutation 在 callback 中调用** — `useDataSource.ts` 已改用 fetch，但应统一为 tRPC client 模式
2. **前端 Mock 数据 fallback** — 后端不可用时用本地状态，但类型不完整
3. **无 API 鉴权分层** — 所有路由用 `publicQuery`，MCP 路由用了 `authedQuery/adminQuery` 但不一致
4. **无 WebSocket** — 实时状态更新靠轮询（`staleTime: 30000`）
