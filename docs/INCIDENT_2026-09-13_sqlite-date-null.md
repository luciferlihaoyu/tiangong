# SQLite DATE() 事故复盘 — usage/ops 页白屏（2026-09-13）

## 事故现象
- `https://tiangong.xianrealme.com/#/usage` 整页白屏
- 报错：`null is not an object (evaluating 'i.date.slice')`（Safari 26.6.1）
- componentStack 指向 DailyTrend（`k1`）组件；ops 页同源同炸

## 根因（一句话）
SQLite 的 `DATE()` 对**裸数字输入按 Julian day number 解释而非 unix 秒**，因此
`DATE(created_at)`（`integer timestamp` 即 unix 秒列）**恒返回 NULL**；
`usage.byDay` / `ops.modelDay` 用它做 select + groupBy，只要有任意一条数据
就必然产出 `{date: null}` 行，前端 `d.date.slice(5)` 无防御 → TypeError → 白屏。

### 实证（node:sqlite 3.53.4）
```sql
SELECT DATE(1757736000);                        -- NULL  ← 合法 unix 秒也炸
SELECT DATE(1757736000, 'unixepoch');           -- '2025-09-13'
SELECT DATE('2025-09-13 04:00:00');             -- '2025-09-13'（文本形态正常）
```
混合形态（drizzle 写入的整数秒 + MySQL 迁移遗留的 ISO 文本）下，整数秒行
全部塌缩进一个 date=NULL 分组——这就是线上崩塌的形态。

## 修复（commit ccc8db9；day-sql.ts/day-sql.test.ts/usage-router 批次先被
Tiangong Subagent 自动提交混入 08e1bf8）
1. **后端（根因）**：新增 `api/lib/day-sql.ts`
   ```ts
   export function sqlDayOf(col: AnySQLiteColumn): SQL<string> {
     return sql<string>`COALESCE(DATE(${col}), DATE(${col}, 'unixepoch'))`;
   }
   ```
   整数秒走 `'unixepoch'` 分支；迁移遗留 ISO 文本走第一分支；两种历史形态
   都归一为 `YYYY-MM-DD`。`usage-router.ts`（3 处）与 `ops-router.ts`（3 处）
   全部改用共享表达式。
2. **前端（防御）**：`UsagePanel.tsx` / `OpsPanel.tsx` 的 `d.date` 访问加
   可选链 + 兜底（`d.date?.slice(5) ?? "—"`），单条脏数据不再白屏。
3. **回归测试**：新增 `tests/api/day-sql.test.ts`，用**真实 node:sqlite
   内存库**执行生产同款聚合表达式（经 `SQLiteSyncDialect.sqlToQuery` 渲染），
   覆盖：整数秒非空日期、双日期真分组、混合形态归一。RED→GREEN 闭环。

## 测试盲区教训（为什么 bug 活到今天）
项目两层测试基建**都不真正执行 SQL**：
- `tests/api/usage-flow.test.ts`：链式 mock 直接喂静态 mockData；
- `tests/api/helpers/fake-db.ts`：头注释自述 "No real SQL is ever executed"。

凡 SQL 函数行为（DATE / strftime / SUM 语义 / groupBy 值）类 bug，这两层
永远拦不住。**涉及 SQL 函数语义的改动，必须补真实 SQLite 执行的测试**
（参照 day-sql.test.ts 的模式：node:sqlite + SQLiteSyncDialect 渲染生产表达式）。

## 环境备忘
- 本容器 node_modules 缺 `better-sqlite3` 链接（pnpm `file:vendor/better-sqlite3-shim`）：
  - vitest 需 alias：`vitest.config.ts` resolve.alias `better-sqlite3` → `vendor/better-sqlite3-shim/index.js`
  - TS 需 paths：`tsconfig.app.json` / `tsconfig.server.json` paths `better-sqlite3` → `vendor/better-sqlite3-shim`
  - 生产/CI pnpm install 后不受影响
- shim 默认导出故意 throw（防误 `new Client()`）：drizzle 永远接
  `nodeSqliteAdapter(new DatabaseSync(path))`，见 `api/lib/node-sqlite-adapter.ts`
- 部署链路：`git push origin main` → Zeabur 自动构建（Docker builder）。
  本容器 git 无凭据，推送走平台 github_push 工具（带凭据注入）
- 仓库有 "Tiangong Subagent <subagent@tiangong.local>" 自动提交工作区改动的
  机制，会把改动混进不相关 commit；重要修复应尽快自行规范提交，防混淆
