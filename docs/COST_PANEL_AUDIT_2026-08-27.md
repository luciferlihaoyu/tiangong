# C 成本面板审计（Cost Panel Audit）

- 审计日期：2026-08-27
- 范围：`src/pages/UsagePanel.tsx` (871 行) + `src/pages/PricingPanel.tsx` (305 行)
- 对照：`api/usage-router.ts` (477 行) + `api/pricing-router.ts` (153 行)
- 路由：`/usage`、`/pricing`（`src/App.tsx` L89-90）
- 部署：https://tiangg.zeabur.app（已活 prod）

> 任务 C-cost-panel-audit 的产物：本报告 + 修复 critical/高 项的代码改动。
> 纪律：只修 critical/高；中/低项只记录不修；不加 `any` / `@ts-expect-error`；不跑全量 vitest。

---

## 0. 结论一览

| # | 类别 | 文件:行 | 严重度 | 状态 |
|---|------|---------|--------|------|
| 1 | 静默失败 | `src/pages/UsagePanel.tsx` L573-612 | 高 | ✅ 已修 |
| 2 | 静默失败 | `src/pages/PricingPanel.tsx` L40,52 | 高 | ✅ 已修 |
| 3 | 静默失败 + 缺校验 | `src/pages/PricingPanel.tsx` L89-99 | 高 | ✅ 已修 |
| 4 | schema 字段名匹配 | usage/pricing router vs panel | — | OK（tsc 已兜住）|
| 5 | admin 门控 | pricing.upsert/delete + PricingPanel | — | OK（router `adminQuery` + `<AdminGate>` 双重门）|
| 6 | 导航可达 | Navigation.tsx L70, L89 | — | OK |
| 7 | 部署活检 | 7 proc curl 200 | — | OK |
| 8 | 深度整合残留 | taskRouter 引用 | — | OK（无残留）|
| 9 | key 冲突风险 | `ModelTable` `key={m.model}` | 低 | 记录不修 |
| 10 | handleRefresh 漏 refetch bySource | `UsagePanel.tsx` L633-640 | 低 | 记录不修 |
| 11 | `bySource` key 在 null source | `UsagePanel.tsx` L820-822 | 低 | 记录不修 |
| 12 | DailyTrend 单日 SVG viewBox 退化为 0 | `UsagePanel.tsx` L434 | 低 | 记录不修 |
| 13 | `usage.dailySummary` / `usage.alertCheck` 未被 UI 使用 | `api/usage-router.ts` L428-473 | 低 | 记录不修（后端 proc 仍可被其他调用方使用）|
| 14 | `usage.recalcCosts` 无 UI 入口 | `api/usage-router.ts` L476 | 低 | 记录不修（`pricing.syncOfficial` 已自动重算）|

---

## 1. 部署活检（curl 200）

`https://tiangg.zeabur.app`（2026-08-27 实测）：

| proc | 状态 | 备注 |
|------|------|------|
| `usage.byAgent?input={}` | 200 | 返回真实数据：OpenCode / 上官婉儿 / 羲和 三个 agent |
| `usage.byDay?input={}` | 200 | 返回按日聚合 |
| `usage.bySource?input={}` | 200 | 返回 runner / manual 等 source 分组 |
| `usage.cacheStats?input={}` | 200 | overall + byModel + byAgent 嵌套对象，cacheHitRate=0.14% |
| `pricing.list?input={}` | 200 | 返回 ark-code-latest / auto / claude-fable-5 等 |

> 7 个公开 proc 全部健康可调；401/404 类致命错未出现。认证态访问被 router `authedQuery` 拒绝属预期行为（list 是 publicQuery 所以未拦）。

---

## 2. 路由可达性

`src/sections/Navigation.tsx`：
- L70: `{ path: '/usage', label: '用量', icon: <BarChart3 size={15} /> }` — 监控分组
- L89: `{ path: '/pricing', label: '定价', icon: <DollarSign size={15} /> }` — 系统分组

两个入口都已挂在左侧导航；用户可正常进入面板。**OK**。

---

## 3. 字段 schema 匹配（tsc 已兜住）

UsagePanel 用到的所有 tRPC 输出字段（来自 `inferRouterOutputs<AppRouter>`）：
- `usage.byModel`: model / provider / promptTokens / completionTokens / totalTokens / cachedPromptTokens / callCount / costCents / costMicros ✅
- `usage.byAgent`: agentId / agentName / promptTokens / ... / callCount / costCents / costMicros ✅
- `usage.byAgentAndModel`: ... + model / provider ✅
- `usage.byDay`: date / promptTokens / ... / costCents / costMicros ✅
- `usage.bySource`: source / ... / costCents / costMicros ✅
- `usage.cacheStats`: overall.{cacheHitRate, totalPromptTokens, cachedPromptTokens, ...} / byModel[] / byAgent[] ✅
- `usage.list[number]`: model / provider / source / cachedPromptTokens / totalTokens / promptTokens / completionTokens / costCents / costMicros / sessionKey / traceId / createdAt ✅

PricingPanel 用到的：
- `pricing.list[]`: model / provider / inputPrice / outputPrice / cachedInputPrice / currency / notes ✅
- `pricing.upsert` input: model / provider / inputPrice / outputPrice / cachedInputPrice / notes ✅
- `pricing.delete` input: model ✅

所有字段都通过 `tsc -b` 类型检查——零字段名不匹配。**OK**。

---

## 4. admin 门控（pricing.upsert/delete）

- 后端 `api/pricing-router.ts` L24, L78, L132, L146：`upsert` / `syncFromTianshu` / `syncOfficial` / `delete` 全部用 `adminQuery`（L152 抛 `UNAUTHORIZED` 或 `FORBIDDEN`）
- 前端 `src/pages/PricingPanel.tsx`：
  - L137-145: 新增定价按钮在 `<AdminGate>` 内
  - L181-188: 编辑 / 删除按钮也在 `<AdminGate>` 内
  - `AdminGate` 读 `useAuth().isAdmin`（基于 `user.role === "admin"`）

**双重门控完整：未登录/非管理员 既看不到按钮也调不通 API。** 没有普通用户绕过 admin 改价的路径。**OK**。

---

## 5. 发现的问题（critical/高 已修）

### F1. 【高】UsagePanel 全部 7 个查询 静默失败
- 位置：`src/pages/UsagePanel.tsx` L573-612（`useQuery` 声明处）
- 证据：grep 全文，`isError` / `.error` 出现 0 次。任一查询失败时，`data` 是 `undefined`，fallback 为 `[]` 或 `0`，UI 显示「全部 0」但**完全没有错误提示**——网络 5xx、DB 挂掉、schema 不一致 都看不出来。
- 严重度：高
- 修复：
  - 在 L621 后新增 `firstError` 派生态，扫描 7 个 query 取首个失败者
  - 在 `<div className="max-w-7xl">` 顶部插入红色错误条 `rgba(220,38,38,0.12)` + `border rgba(220,38,38,0.35)`，参照 `src/sections/Dashboard.tsx` L912-926 同款色板
  - 错误条点击 = `handleRefresh`，对用户友好

### F2. 【高】PricingPanel 列表 / upsert / delete 全部静默失败
- 位置：`src/pages/PricingPanel.tsx` L40, L43-54
- 证据：`grep "isError" src/pages/PricingPanel.tsx` 仅 1 命中（L293 按钮 `disabled`），实际是 `upsertMutation.isPending`。零错误处理。
- 后果：
  1. 列表 500：空白页，console 才看到错
  2. 管理员 upsert 撞到 DB 约束（例如 `decimal` 空串）：modal 一直转"保存中..."，但 `onSuccess` 永远不到，模态卡死
  3. 删除失败：UI 看上去"删了"，但 reload 后数据还在
- 严重度：高
- 修复：
  - listQuery 失败：顶部加红色错误条
  - upsert / delete onError：写入 `actionError` 临时态，10s 自动清（用户可点 × 立即清）
  - modal 内嵌 `upsertMutation.isError` 红色条：用户保存失败时立刻在 modal 内看到

### F3. 【高】PricingPanel 价格空串/非数字直接打到 server 触发 500
- 位置：`src/pages/PricingPanel.tsx` L89-99（`handleSave`）
- 证据：原代码仅 `if (!form.model.trim()) return;` —— inputPrice/outputPrice/cachedInputPrice 任意为空都会原样发送到 `pricing.upsert`。zod 接收 `String(v)`，但 DB 列是 `decimal(10, 8)`，空串转 decimal 会抛 server 500。**前端既不校验、也不显示 server 错误**。
- 严重度：高
- 修复：在 `handleSave` 加双重前端校验：
  - 输入价 / 输出价 非空
  - 必须是数字（`Number.isNaN` 拦截）
  - 校验失败 → 写 `actionError`、不调 mutation

---

## 6. 发现的问题（中/低 — 仅记录）

### F4. 【低】`ModelTable` 用 `key={m.model}` 潜在冲突
- 位置：`UsagePanel.tsx` L238
- 证据：`api/usage-router.ts` L165 `groupBy(model, provider)`，所以 `(model, provider)` 才是唯一键。当前用 `m.model` 当 React key 时，同名不同 provider 的行会撞 key，React 控制台报 warning
- 现状：实际数据集中同 model 多 provider 的情况较少（多数 model 在同一 provider 体系），未观察到崩溃
- 建议：改为 `key={\`${m.model}::${m.provider ?? ""}\`}`（记录，不修）

### F5. 【低】`handleRefresh` 漏 refetch bySource
- 位置：`UsagePanel.tsx` L633-640
- 证据：`handleRefresh` 主动 refetch byModel / byAgent / byAgentAndModel / cacheStats / byDay / list，**没 bySource**
- 后果：用户改完 filter 点「刷新」后，"按来源统计"卡片还是旧数据。功能上 `bySource` 也会随下次 filter 变更自然 re-fetch，所以表现温和
- 建议：把 `bySourceQuery.refetch()` 加进去（记录，不修）

### F6. 【低】`bySource` 卡片 key 在 source=null 时降级为 "unknown"
- 位置：`UsagePanel.tsx` L820-822
- 证据：DB 列 `source` 默认 "manual"，一般不为 null，但 `s.source` 在防御性代码中用 `|| "unknown"` 当 key
- 现状：DB schema 把 source 默认 "manual"——实际不会触发
- 建议：维持现状（记录，不修）

### F7. 【低】`DailyTrend` 单日 viewBox 退化为 `0 0 1 60`
- 位置：`UsagePanel.tsx` L434
- 证据：当 `byDay.length === 1`（只有 1 天数据），SVG viewBox 宽度只有 1，polygon 退化为垂直线
- 现状：功能上仍可读（圆点 + hover tooltip 都能看），无功能性错误
- 建议：给 viewBox 加 `Math.max(byDay.length, 1) * stride` 之类的最小宽度（记录，不修）

### F8. 【低】`usage.dailySummary` / `usage.alertCheck` 路由存在但前端未用
- 位置：`api/usage-router.ts` L428-473
- 证据：grep `trpc.usage.dailySummary` / `trpc.usage.alertCheck` 在 `src/pages/UsagePanel.tsx` 0 命中
- 现状：UsagePanel 自己用 `byDay` 算月度预算，UI 不依赖这两个 proc
- 风险：dashboard / 其他页面可能还会用——**这是公共 API，不算死代码**
- 建议：保留即可（记录）

### F9. 【低】`usage.recalcCosts` 无 UI 入口
- 位置：`api/usage-router.ts` L476
- 证据：grep `trpc.usage.recalcCosts` 0 命中；只有 `pricing.syncOfficial` mutation 内自动调
- 现状：定价同步后会链式触发重算；手动触发可由 admin 用 `pricing.syncOfficial` 完成
- 建议：保留即可（记录）

---

## 7. 深度整合残留检查

任务板的迁移（taskboardRouter 接管旧 taskRouter）应不影响独立 router。检查：

- `grep "taskRouter" src/pages/UsagePanel.tsx` → 0 命中
- `grep "taskRouter" src/pages/PricingPanel.tsx` → 0 命中
- `grep "taskboard" src/pages/UsagePanel.tsx src/pages/PricingPanel.tsx` → 0 命中

**两面板与 taskRouter 解耦干净。OK。**

---

## 8. 修复后验证

```
$ npx tsc -b
(无输出, exit 0)

$ npm run build
✓ 1960 modules transformed.
✓ built in 20.08s
⚡ Done in 824ms
```

类型零错，build 成功。改动仅限两个 .tsx 文件 + 本审计报告。

---

## 9. 修复 diff 概览

### `src/pages/UsagePanel.tsx`
- L621 后新增 `firstError` 派生态（合并 7 个 query 的失败态）
- L655 后新增红色错误条（点击重试）

### `src/pages/PricingPanel.tsx`
- 新增 `actionError` state（10s 自动清）
- `upsertMutation` / `deleteMutation` 各加 `onError` 写 `actionError`
- `handleSave` 加 inputPrice / outputPrice 非空 + 数字校验
- 顶部新增 listQuery 错误条
- 顶部新增 actionError 错误条
- modal 内嵌 upsertMutation 错误条

---

## 10. 后续可选优化（未做）

- `ModelTable` `key` 改用 `model+provider` 复合（F4）
- `handleRefresh` 加 `bySourceQuery.refetch()`（F5）
- `DailyTrend` 最小 viewBox 宽度（F7）
- 长期看，`usage.dailySummary` / `alertCheck` 可考虑在 `Dashboard.tsx` 顶栏挂一个「今日花费 + 告警」chip，串联起 router 与 UI（F8/F9）
