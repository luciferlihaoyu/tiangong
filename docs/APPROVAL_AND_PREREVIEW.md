# 审批闸门 / 自动审批 / Fusion 预审 — 语义与开关地图

> 三个机制都在「任务被停放（待审批）」这条链上工作，但职责完全不同。本文是唯一
> 事实源，改这三处代码前请先读这里。

## 一图流

```
任务执行请求
   │
   ├─ 命中 APPROVAL_RISK_TYPES（含红线）→ parkTaskForApproval() 停放
   │     └─ boardStatus=blocked，status/lifecycleStatus 不变（重要：所以任何
   │        扫描逻辑都必须显式跳过 blocked，否则会反复重新停放 → 死循环）
   │
   ├─ 非红线停放 ─→ ①自动审批（开关默认 OFF）→ 助手 LLM 判断
   │                   ├─ 明确批准 → 放行执行
   │                   └─ 否则 / 开关关闭 → 留人工
   │
   └─ 红线停放 ───→ ②Fusion 预审（始终生效，与开关无关）
                       └─ 多模型独立审查 + Judge 汇总 → 写进任务线程
                          ★ 只做参考，永不自动放行
```

## 1. 执行审批闸门（`api/lib/execution-gate.ts`）

- **风险类型** `APPROVAL_RISK_TYPES`：`github_push` / `github_merge` / `github_release` /
  `zeabur_deploy` / `zeabur_restart` / `zeabur_delete_service` / `storage_delete` /
  `newapi_write` / `mcp_key_change` / `external_send` / `webhook_call`
- **红线** `RED_LINE_RISKS`（在 auto-approve.ts，已导出）：`github_merge` /
  `github_release` / `zeabur_deploy` / `zeabur_delete_service` / `storage_delete` /
  `mcp_key_change` —— **任何情况下都不自动批准**
- 停放方式：`parkTaskForApproval()` 只写 `boardStatus=blocked`，**不动** `status` /
  `lifecycleStatus`。因此：
  - auto-dispatch 扫描（`status=pending AND lifecycleStatus=created`）必须显式
    `if (task.boardStatus === "blocked") continue;`（已修，2026-09-13）
  - 审批状态统一用 `getApprovalState(task.input)` 读 metadata 信封
    （`routing.approvalRequired` / `routing.riskTypes` / `approval.decision`）
- 三个闸点：派发前、认领时、完成时（completion gate，防止 connector 自批）

## 2. 自动审批（`api/lib/auto-approve.ts`）

- **默认关闭**，UI 手动开关：模型管理 → 助手 Tab →「自动审批 · 天宫助手代审」
- 开关状态用 `settings.auto_approve_enabled`；日限额 `auto_approve_daily_limit`
  （默认 10），计数键 `auto_approve_count:<date>`
- 命中红线的任务**永久转人工**，不受本开关影响
- 只有助手 LLM 明确批准才放行；解析失败/超限/异常一律留人工

## 3. Fusion 预审（`api/lib/fusion-prereview.ts`）

- **触发条件**（三者同时满足）：任务处于停放态 + `getApprovalState().required` +
  `decision === "pending"`，且 `riskTypes` 与 `RED_LINE_RISKS` 有交集
- **与自动审批开关无关**：红线任务无论开关如何都会跑预审（它只提供信息，不改变状态）
- **流程**：拉 `/v1/models` → 过滤非 chat 模型（embed/bge/rerank/tts/ocr 等正则）
  → 挑 3 个模型并行独立审查（严格 JSON：共识/分歧/风险/建议/置信度）
  → Judge（助手模型）汇总出 `approve | modify | reject` + 置信度 + 建议动作
- **降级**：Judge 失败时按风险条数给降级结论（置信度固定 0.3），并在文案里写明
- **幂等**：DB 里查 `taskMessages.metadata.action === "fusion_prereview"` + 进程内
  `inFlight` 集合（LLM 一轮 2-4 分钟，DB 标记落库前必须靠内存去重）
- **日限额**：`fusion_prereview_daily_limit`（默认 10），计数键
  `fusion_prereview_count:<date>`
- **输出**：任务线程里一条 `system` 消息（`fromAgentId=助手`），前端
  `TaskDetailModal` 的 `FusionPreReviewContent` 渲染成卡片（结论徽标 + 红线 chips +
  风险/建议 + 可展开的各模型独立意见）
- **绝不自动放行**：预审从不修改任务状态，人工审批时当参考阅读

## 4. 会话中心 = 协作任务战况室（`api/lib/collab-session.ts`）

- 协作父任务（`parentTaskId` 关联）自动绑定一个 `collaboration` 共享会话，
  `sessionKey = collab-task-{parentTaskId}`（唯一、幂等）
- 三个挂点自动写消息：`collab.delegate`（启动 + 逐条派发）→
  `reportTaskProgress`（📝 进度 / ✅ 完成 / ❌ 失败）→
  `emitCollabSummaryForTask`（📊 汇总）
- 消息 metadata 带 `childTaskId` / `parentTaskId`，SessionPanel 上可一键跳
  `/tasks?task=<id>` 打开任务详情

## 5. 相关 UI 入口

| 功能 | 位置 |
|---|---|
| 自动审批开关 + 日限额 + 红线清单 | 模型管理 → 助手 Tab |
| 失败任务批量归档（预演 + 执行） | 模型管理 → 助手 Tab |
| 死模型兜底候选 | 模型管理 → 助手 Tab |
| 时间戳存量修复（扫描 + 执行） | 模型管理 → 助手 Tab |
| 模型可用性探测（✓/✗ 徽标） | 模型管理 → 模型 Tab（可用模型表） |
| 预审结论卡片 | 任务工作台 → 点任务 → 线程内 |
| 协作战况室 | 会话中心（/sessions） |
| Open WebUI 固定会话 | 对话（/chat）或首页消息面板切换 |

## 6. 血泪教训（别重踩）

1. **停放只改 boardStatus** → 扫描循环必须跳过 blocked，否则重复停放 + 重复触发预审
   （实测 16 分钟触发 6 轮）
2. **模型列表前段是 embedding 模型** → 不过滤必然全失败，静默无输出
3. **`db.insert()` 的 id 只在 `lastInsertRowid`**（node:sqlite 适配器）→ 统一用
   `api/lib/insert-id.ts` 的 `getInsertId()`，写 `(result as any).insertId` 会静默丢 id
4. **`defaultNow()` 在 sqlite timestamp 模式下写毫秒、按秒读** → 用
   `$defaultFn(() => new Date())`；历史脏行用
   `api/lib/timestamp-repair.ts`（模型管理 → 助手 Tab 可一键修）
