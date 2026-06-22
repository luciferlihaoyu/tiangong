# 天宫 P13：成本分析系统 Spec

> 状态：Spec 待实现
> 日期：2026-06-22
> 目标：精确追踪每个助手、每个模型、每次调用的 token 消耗与费用，支持缓存命中率分析，按时间/助手/模型等多维度汇总

## 背景

现有 `token_usage` 表已有基础用量记录，但：
- `costCents` 是硬编码的 `$0.002/1K tokens` 统一费率，不准确
- 没有缓存命中/未命中区分
- 没有按 Agent 的聚合路由
- 前端缺少 Agent 维度视图和缓存分析

## 目标

### P0 — 模型定价表

1. **新增 `model_pricing` 表**
   - 模型名（主键）
   - 提供方
   - 输入价格（每 1K token，美元）
   - 输出价格（每 1K token，美元）
   - 缓存命中输入价格（每 1K token，美元，可空）
   - 货币单位：美元（USD），前端展示时按实时汇率换算为人民币

2. **预置主流模型定价数据**
   - 覆盖 L 使用的所有模型
   - 定价数据来自各模型官方定价页
   - 可手动新增/修改

3. **`token_usage` 表新增字段**
   - `cached_prompt_tokens` INT DEFAULT 0 — 命中缓存的输入 token
   - `uncached_prompt_tokens` INT DEFAULT 0 — 未命中缓存的输入 token
   - `currency` VARCHAR(3) DEFAULT 'USD' — 货币单位
   - `exchange_rate` DECIMAL(10,6) DEFAULT 1.0 — 汇率（USD→目标货币）
   - `cost_display` DECIMAL(12,4) DEFAULT 0 — 按汇率换算后的显示金额

4. **`usage.record` 自动计算真实费用**
   - 根据 model 查 `model_pricing` 表
   - 计算：`cost = (uncached_prompt_tokens * input_price + cached_prompt_tokens * cached_input_price + completion_tokens * output_price) / 1000`
   - 如果定价表中没有该模型，fallback 到统一费率

### P1 — 后端聚合路由

5. **`usage.byAgent`** — 按 Agent 聚合
   - 返回每个 Agent 的：总 token、输入/输出 token、缓存/未缓存、调用次数、费用
   - 支持时间范围筛选

6. **`usage.byAgentAndModel`** — 按 Agent × 模型交叉统计
   - 返回每个 (Agent, Model) 组合的统计
   - 支持时间范围筛选

7. **`usage.cacheStats`** — 缓存命中率统计
   - 总缓存命中率
   - 按模型缓存命中率
   - 按 Agent 缓存命中率
   - 节省的费用（缓存价格 vs 非缓存价格差额）

8. **`usage.pricing.list`** — 列出所有模型定价
9. **`usage.pricing.upsert`** — 新增/修改模型定价
10. **`usage.pricing.delete`** — 删除模型定价

### P2 — 前端成本分析面板

11. **新增"成本分析"面板**（或大幅改造现有 UsagePanel）
    - **概览卡片**：总花费（USD + CNY）、总 Token、总调用次数、缓存节省金额
    - **按 Agent 统计表**：每个助手的消耗明细
    - **按模型统计表**：每个模型的消耗明细（增强现有）
    - **Agent × 模型交叉表**：矩阵视图
    - **缓存命中率图表**：环形图/柱状图
    - **日趋势图**：每日花费趋势（增强现有）
    - **最近记录列表**：增强显示缓存信息

12. **筛选器**
    - 时间范围（开始/结束日期）
    - Agent 下拉选择
    - 模型下拉选择
    - 来源选择
    - 货币切换（USD / CNY）

13. **汇率功能**
    - 默认使用固定汇率（可配置）
    - 前端显示 USD 和 CNY 双币种

### P3 — Connector 上报增强

14. **Connector 上报缓存信息**
    - 上报时区分 `cached_prompt_tokens` 和 `uncached_prompt_tokens`
    - 如果无法区分，全部记为 `uncached_prompt_tokens`

## 数据模型

### model_pricing 表

```sql
CREATE TABLE model_pricing (
  model              VARCHAR(100) PRIMARY KEY,
  provider           VARCHAR(50) DEFAULT 'unknown',
  input_price        DECIMAL(10,8) NOT NULL DEFAULT 0,     -- USD per 1K tokens
  output_price       DECIMAL(10,8) NOT NULL DEFAULT 0,     -- USD per 1K tokens
  cached_input_price DECIMAL(10,8),                        -- USD per 1K tokens (nullable)
  currency           VARCHAR(3) DEFAULT 'USD',
  notes              TEXT,                                  -- 备注/来源
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### token_usage 表新增字段

```sql
ALTER TABLE token_usage
  ADD COLUMN cached_prompt_tokens INT DEFAULT 0,
  ADD COLUMN uncached_prompt_tokens INT DEFAULT 0,
  ADD COLUMN currency VARCHAR(3) DEFAULT 'USD',
  ADD COLUMN exchange_rate DECIMAL(10,6) DEFAULT 1.0,
  ADD COLUMN cost_display DECIMAL(12,4) DEFAULT 0;
```

## 预置模型定价（初始数据）

| 模型 | 提供方 | 输入价/1K | 输出价/1K | 缓存输入价/1K |
|------|--------|-----------|-----------|--------------|
| deepseek-v4-flash | deepseek-official | $0.0003 | $0.0006 | $0.000075 |
| deepseek-reasoner | deepseek-official | $0.002 | $0.008 | $0.0005 |
| deepseek-v3.2 | zeabur-ai | $0.0005 | $0.0015 | - |
| deepseek-v4-pro | deepseek-official | $0.002 | $0.008 | $0.0005 |
| kimi-for-coding | kimi-code | $0.004 | $0.012 | - |
| MiniMax-M3 | minimax-cn | $0.002 | $0.008 | - |
| MiniMax-M2.7 | minimax-cn | $0.001 | $0.004 | - |
| claude-opus-4-8 | anthropic | $0.015 | $0.075 | $0.0075 |
| claude-fable-5 | anthropic | $0.003 | $0.015 | $0.0003 |
| ark-code-latest | volcengine-plan | $0.002 | $0.008 | - |
| qwen3.6-plus | bailian | $0.002 | $0.008 | - |
| doubao-seedream-5-0-260128 | volcengine | $0.008 | $0.024 | - |
| gpt-4o | openai | $0.005 | $0.015 | $0.0025 |
| openclaw-connector | openclaw | $0.001 | $0.002 | - |
| mock-executor | tiangong-mock | $0 | $0 | - |

> 注：定价数据需验证后确认。标记为 `-` 的表示该模型不支持缓存折扣。

## 汇率

- 默认汇率：1 USD = 7.2 CNY（可配置）
- 存储在 `model_pricing` 表的 `exchange_rate` 字段或独立配置
- 前端显示双币种：`$X.XX / ¥X.XX`

## 修改文件清单

### 数据库
1. **`db/schema.ts`** — 新增 `modelPricing` 表定义 + `tokenUsage` 表新增字段

### 后端
2. **`api/usage-router.ts`** — 新增 `byAgent`、`byAgentAndModel`、`cacheStats` 路由
3. **`api/pricing-router.ts`** — 新增定价管理路由（list/upsert/delete）
4. **`api/lib/auto-migrate.ts`** — 新增自动迁移逻辑
5. **`api/lib/model-pricing.ts`** — 定价计算工具函数

### Connector
6. **`scripts/openclaw-connector/connector.mjs`** — 上报时传缓存信息

### 前端
7. **`src/pages/UsagePanel.tsx`** — 大幅改造，新增 Agent 视图、缓存分析、双币种
8. **`src/pages/PricingPanel.tsx`** — 新增定价管理页面
9. **`src/App.tsx`** — 注册新路由

## 验收清单

| # | 验收项 | 状态 |
|---|--------|------|
| P0.1 | model_pricing 表创建 | ⬜ |
| P0.2 | 预置模型定价数据 | ⬜ |
| P0.3 | token_usage 新增缓存字段 | ⬜ |
| P0.4 | usage.record 自动计算真实费用 | ⬜ |
| P1.1 | usage.byAgent 路由 | ⬜ |
| P1.2 | usage.byAgentAndModel 路由 | ⬜ |
| P1.3 | usage.cacheStats 路由 | ⬜ |
| P1.4 | pricing.list/upsert/delete 路由 | ⬜ |
| P2.1 | 前端成本分析面板 | ⬜ |
| P2.2 | Agent 维度视图 | ⬜ |
| P2.3 | 缓存命中率图表 | ⬜ |
| P2.4 | 双币种显示 | ⬜ |
| P2.5 | 定价管理页面 | ⬜ |
| P3.1 | Connector 上报缓存信息 | ⬜ |
