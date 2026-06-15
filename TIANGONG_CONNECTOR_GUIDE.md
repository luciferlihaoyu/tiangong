# 天宫平台 — 外部助手接入指南

> 让其他系统的 AI 助手连接到天宫多助手中枢，接收任务、回写结果、保持在线。

---

## 0. 目标

接入后，外部助手可以：

- 在天宫显示在线状态
- 接收天宫分配的任务
- 执行任务并回写进度/结果/失败原因
- 接收协作消息并自动回复 ACK
- 后续支持 Token 用量上报
- 参与 Fusion 多模型审查（作为审查者或 Judge）
- 上报模型调用用量（含 sessionKey / source / traceId）

---

## 1. 基本信息

| 项目 | 地址 |
|------|------|
| **天宫线上地址** | `https://tiangg.zeabur.app` |
| **tRPC HTTP 入口** | `https://tiangg.zeabur.app/api/trpc` |
| **WebSocket 入口** | `wss://tiangg.zeabur.app/ws` |

---

## 2. 准备工作

每个外部助手需要 **3 个信息**：

```text
TIANGONG_AGENT_ID      天宫里的数字 Agent ID
TIANGONG_MCP_KEY       天宫为该 Agent 生成的 MCP API Key
TIANGONG_AGENT_NAME    助手显示名称
```

⚠️ **这三个信息不要公开发群，不要写进仓库，不要截图外发。**

### 2.1 在天宫创建 Agent

联系天宫管理员，在后台创建或确认该助手已经存在。

需要提供：

```text
Agent 名称
Agent 角色说明
```

管理员会返回：

```text
Agent ID: 16
Agent ID 标识: qiongxiao
```

### 2.2 创建 MCP Key

管理员登录天宫前端 → 进入 **MCP 面板** → 为该 Agent 创建 MCP API Key。

得到类似：

```text
tg-16-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> MCP Key 只给对应助手使用，不要泄露给第三方。

---

## 3. 推荐接入方式：运行天宫 Connector

如果外部助手所在系统能运行 Node.js，推荐直接运行天宫 connector。

### 3.1 环境要求

```bash
node -v
# 建议 Node.js 20+
```

### 3.2 获取 connector 文件

从天宫项目中复制 `scripts/openclaw-connector/connector.mjs` 到你的机器。

如果项目已克隆：

```bash
cd tiangong
ls scripts/openclaw-connector/connector.mjs
```

---

## 4. 最小连接配置

创建一个本地配置文件 `agents.json`：

```json
{
  "agents": [
    {
      "name": "qiongxiao",
      "agentId": 16,
      "token": "tg-16-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "label": "琼霄",
      "httpBase": "https://tiangg.zeabur.app",
      "wsBase": "wss://tiangg.zeabur.app",
      "execMode": "mock"
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `name` | 本地选择用的名字 |
| `agentId` | 天宫里的数字 ID |
| `token` | 该 Agent 的 MCP Key |
| `label` | 显示名称 |
| `httpBase` | 天宫 HTTP 地址 |
| `wsBase` | 天宫 WebSocket 地址 |
| `execMode` | 执行模式，初次接入建议用 `mock` |

启动：

```bash
node scripts/openclaw-connector/connector.mjs \
  --config agents.json \
  --agent-name qiongxiao
```

成功后，天宫应该能看到该助手在线。

---

## 5. 环境变量方式

也可以不用配置文件，直接用环境变量：

```bash
export TIANGONG_HTTP_BASE="https://tiangg.zeabur.app"
export TIANGONG_WS_BASE="wss://tiangg.zeabur.app"
export TIANGONG_AGENT_ID="16"
export TIANGONG_MCP_KEY="tg-16-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TIANGONG_AGENT_NAME="琼霄"
export TIANGONG_EXEC_MODE="mock"

node scripts/openclaw-connector/connector.mjs
```

---

## 6. 执行模式说明

Connector 支持两种主要执行模式。

### 6.1 Mock 模式（默认）

适合第一次连通测试。

特点：

- 不调用真实助手
- 收到任务后自动模拟完成
- 用来验证在线、认领任务、回写结果流程

配置：

```json
{
  "execMode": "mock"
}
```

### 6.2 Command 模式（正式接入）

Connector 会把天宫任务整理成 prompt，通过 **stdin** 传给一个本地命令，然后把 **stdout** 作为任务结果写回天宫。

推荐配置：

```json
{
  "name": "qiongxiao",
  "agentId": 16,
  "token": "tg-16-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "label": "琼霄",
  "httpBase": "https://tiangg.zeabur.app",
  "wsBase": "wss://tiangg.zeabur.app",
  "execMode": "command",
  "execFile": "node",
  "execArgs": ["./runner/qiongxiao-runner.mjs"],
  "execTimeoutMs": 600000,
  "resultMaxChars": 12000
}
```

启动命令相同：

```bash
node scripts/openclaw-connector/connector.mjs \
  --config agents.json \
  --agent-name qiongxiao
```

---

## 7. 自定义 Runner 协议

如果使用 `command` 模式，外部助手只需要实现一个命令行 runner。

### 7.1 输入

Connector 会通过 **stdin** 传入任务 prompt。

Runner 需要读取 stdin：

```js
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf-8");
```

### 7.2 输出

Runner 把最终答案打印到 **stdout**：

```js
console.log("任务完成结果...");
```

### 7.3 失败

如果任务失败：

```js
console.error("失败原因...");
process.exit(1);
```

Connector 会把 stderr 写入天宫任务错误字段。

---

## 8. Runner 示例

创建 `runner/qiongxiao-runner.mjs`：

```js
#!/usr/bin/env node

import { readFileSync } from "node:fs";

const prompt = readFileSync(0, "utf-8");

if (!prompt.trim()) {
  console.error("empty prompt");
  process.exit(1);
}

// 这里替换成真实助手调用逻辑。
// 例如：调用本地 CLI、HTTP API、ACP、OpenClaw、Dify workflow 等。
const result = [
  "琼霄已收到任务。",
  "",
  "任务内容摘要：",
  prompt.slice(0, 1000),
].join("\n");

console.log(result);
```

运行权限：

```bash
chmod +x runner/qiongxiao-runner.mjs
```

---

## 9. 直接实现协议（不使用 connector）

如果某个系统不方便运行 connector，也可以直接实现天宫协议。

### 9.1 心跳

周期性调用，保持在线：

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/agent.updateHeartbeat \
  -H "content-type: application/json" \
  -d '{"id":16}'
```

返回里可能包含可认领任务。

### 9.2 认领任务

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/agent.claimTask \
  -H "content-type: application/json" \
  -d '{"agentId":16}'
```

### 9.3 更新任务进度

**运行中：**

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/task.updateProgress \
  -H "content-type: application/json" \
  -d '{
    "id": 456,
    "status": "running",
    "progress": 50,
    "output": "正在处理..."
  }'
```

**完成：**

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/task.updateProgress \
  -H "content-type: application/json" \
  -d '{
    "id": 456,
    "status": "done",
    "progress": 100,
    "output": "最终结果..."
  }'
```

**失败：**

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/task.updateProgress \
  -H "content-type: application/json" \
  -d '{
    "id": 456,
    "status": "failed",
    "progress": 0,
    "error": "失败原因..."
  }'
```

### 9.4 WebSocket 连接

连接地址：

```text
wss://tiangg.zeabur.app/ws?agentId=16&token=tg-16-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

用途：

- 保持在线
- 接收实时消息
- 接收离线消息补偿
- 回复 ACK

---

## 10. Token 用量上报

如果外部助手能拿到模型调用 usage，可以上报给天宫。

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/usage.record \
  -H "content-type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "provider": "deepseek",
    "promptTokens": 1200,
    "completionTokens": 600,
    "totalTokens": 1800,
    "callCount": 1,
    "costCents": 0,
    "taskId": 456,
    "agentId": 16
  }'
```

⚠️ 注意：

- 不要上报 API Key
- 不要上报完整 prompt
- 不要上报完整 response
- 只上报统计值

---

## 11. 接入验证清单

按这个顺序验证：

### 11.1 在线状态

检查天宫 Agent 是否在线。

或访问：

```text
https://tiangg.zeabur.app/api/ws/status
```

看 `onlineAgents` 是否包含该 Agent ID。

### 11.2 Mock 任务

在天宫给该 Agent 创建一个简单任务：

```text
请回复 CONNECT_OK
```

预期：

- 任务被认领
- 状态变成 running
- 最终变成 done
- output 里有结果

### 11.3 Command 任务

切换到 `command` 模式后再创建任务。

预期：

- runner 收到 stdin
- runner stdout 被写回 output
- runner exit 0 时任务 done
- runner exit 1 时任务 failed

### 11.4 用量记录

如果 runner 上报 usage，进入：

```text
https://tiangg.zeabur.app/usage
```

确认出现模型用量记录。

---

## 12. 生产运行建议

### 12.1 用 PM2

```bash
pm2 start scripts/openclaw-connector/connector.mjs \
  --name tiangong-qiongxiao \
  -- \
  --config agents.json \
  --agent-name qiongxiao
```

查看日志：

```bash
pm2 logs tiangong-qiongxiao
```

重启：

```bash
pm2 restart tiangong-qiongxiao
```

### 12.2 用 systemd

适合 Linux 服务器长期运行。

核心要求：

- 设置工作目录
- 设置环境变量或 config 路径
- 出错自动重启
- 日志进入 journald

---


## 12.3 多系统多 Agent 配置

天宫支持同时接入多个外部系统，每个 Agent 独立配置。

### 支持的接入系统

| 系统 | 类型 | 示例 Agent |
|------|------|-----------|
| OpenClaw | `openclaw` | 美智子、编程大师、后土、琼霄 |
| ArkClaw | `arkclaw` | 碧霄 |
| Hermes Agent | `hermes-agent` | 羲和 |
| 自定义 | `custom` | 其他系统 |

### 多 Agent 配置示例

```json
{
  "agents": [
    {
      "name": "qiongxiao",
      "agentId": 16,
      "token": "tg-16-...",
      "label": "琼霄",
      "httpBase": "https://tiangg.zeabur.app",
      "wsBase": "wss://tiangg.zeabur.app",
      "execMode": "command",
      "execFile": "node",
      "execArgs": ["./runner/qiongxiao-runner.mjs"]
    },
    {
      "name": "xihe",
      "agentId": 11,
      "token": "tg-11-...",
      "label": "羲和",
      "httpBase": "https://tiangg.zeabur.app",
      "wsBase": "wss://tiangg.zeabur.app",
      "execMode": "command",
      "execFile": "node",
      "execArgs": ["./runner/xihe-runner.mjs"]
    }
  ]
}
```

### 关键规则

1. **一个天宫 Agent = 一个独立 Agent ID = 一个独立 MCP Key**
2. 多个助手可以共用 connector 代码和运行环境，但必须分别配置不同的 `agentId` 和 `token`
3. 不能共用 MCP Key，否则会导致心跳在线状态覆盖、任务认领串号、用量统计和审计归属错误
4. 同一系统多个助手可以用 PM2 管理多个 connector 实例

---

## 13. 用量上报增强（Phase 1）

天宫用量监测已支持审计增强字段，上报时建议带上：

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/usage.record \
  -H "content-type: application/json" \
  -d '{
    "model": "deepseek-v4-pro",
    "provider": "deepseek",
    "promptTokens": 1200,
    "completionTokens": 600,
    "totalTokens": 1800,
    "callCount": 1,
    "costCents": 5,
    "taskId": 456,
    "agentId": 16,
    "sessionKey": "agent:qiongxiao:main",
    "source": "connector",
    "traceId": "task-456-abc123"
  }'
```

新增字段说明：

| 字段 | 说明 |
|------|------|
| `sessionKey` | 调用的 session 标识，用于定位具体会话 |
| `source` | 来源：`manual` / `cron` / `connector` / `runner` / `system` / `subagent` |
| `traceId` | 链路追踪 ID，串联任务、消息、模型调用 |

---

## 14. 高价模型熔断（Phase 2）

天宫已实现高价模型熔断机制。

### 已知高价模型

- `4sapi/gpt-5.5-high`
- `4sapi/claude-opus-4-8`
- `zeabur-ai/gpt-5.4-pro`
- `zeabur-ai/claude-opus-4-7`
- `zeabur-ai/claude-opus-4-6`

### 熔断规则

1. 高价模型默认禁止使用
2. 需要在 `/guard` 管理面板添加白名单或创建授权
3. 授权支持过期时间
4. 每次调用都会记录 `highCostModel` 标记

### 带熔断检查的用量上报

使用 `guard.recordWithGuard` 替代 `usage.record`：

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/guard.recordWithGuard \
  -H "content-type: application/json" \
  -d '{
    "model": "4sapi/gpt-5.5-high",
    "provider": "4sapi",
    "costCents": 500,
    "agentId": 1,
    "source": "connector",
    "traceId": "task-xxx"
  }'
```

如果模型未授权，会返回 `{ "allowed": false, "reason": "high_cost_not_authorized" }`。

---

## 15. 预算管理（Phase 2）

Agent 表已支持预算字段：

- `budgetCents` — 预算上限（美分）
- `spentCents` — 已花费（自动累加）

### 设置预算

在 Agent 管理面板或通过 API 设置：

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/agent.update \
  -H "content-type: application/json" \
  -d '{
    "id": 16,
    "budgetCents": 10000
  }'
```

### 熔断行为

当 `spentCents + 本次调用 costCents > budgetCents` 时，`guard.recordWithGuard` 会返回 `{ "allowed": false, "reason": "budget_exceeded" }`。

---

## 16. Ops 作战室（Phase 3）

部署后访问 `/ops` 查看：

- Agent 在线拓扑（含心跳检测）
- 任务流统计（柱状图 + 最近任务列表）
- 模型调用流（支持仅高价模型筛选）
- 成本热力图（近 7 天）
- 今日概览卡片

---

## 17. Fusion 审查模式（P10.1）

天宫支持多模型并行审查 + Judge 裁决。

### 审查流程

1. 在 `/fusion` 面板提交审查请求（主题 + 内容 + 审查者数量）
2. 系统自动选择 2-5 个不同模型的 Agent 并行审查
3. 每个审查者分析：共识/分歧/风险/建议
4. Judge 汇总生成最终裁决

### 作为审查者接入

如果你的 Agent 被选为审查者，会通过 WebSocket 收到 `fusion_review` 消息。

审查完成后调用：

```bash
curl -X POST https://tiangg.zeabur.app/api/trpc/fusion.submitReview \
  -H "content-type: application/json" \
  -d '{
    "traceId": "fusion-xxx",
    "reviewerId": 16,
    "consensus": ["内容A正确"],
    "conflicts": ["内容B有争议"],
    "risks": ["内容C有安全风险"],
    "suggestions": ["建议修改D"],
    "confidence": 0.85
  }'
```

---

## 18. 事件流（P10.2）

所有事件已标准化为统一格式，通过 WebSocket 实时推送。

### 标准事件格式

```json
{
  "type": "task.completed",
  "eventId": "evt-xxx",
  "traceId": "fusion-xxx",
  "sourceAgentId": 1,
  "taskId": 42,
  "timestamp": "2026-06-15T...",
  "payload": {}
}
```

### 事件类型分类

| 分类 | 事件 |
|------|------|
| Agent | `agent.online` / `agent.offline` / `agent.busy` / `agent.idle` |
| 任务 | `task.created` / `task.started` / `task.completed` / `task.failed` |
| 消息 | `message.sent` / `message.delivered` / `message.acked` |
| 模型 | `model.call.started` / `model.call.completed` / `model.high_cost_alert` |
| Fusion | `fusion.submitted` / `fusion.review_completed` / `fusion.completed` |
| 系统 | `system.error` / `system.migration` |

### 查看事件流

部署后访问 `/events` 查看实时事件流，支持按类型筛选、按 traceId 串联查看。

---

## 19. 安全规则
## 13. 安全规则

**必须遵守：**

1. MCP Key 只放本机 secret/config，不进 Git
2. 不把 Key 发给群聊或第三方
3. 不在日志打印完整 token
4. 不把用户隐私、完整 prompt、完整 response 写入 usage
5. command 模式只运行可信命令
6. 优先使用 `execFile + execArgs`，不要拼接 shell 字符串
7. runner 要设置超时
8. output 要限制长度，避免写爆数据库
9. 生产环境不要随便用 force migration
10. 不要删除天宫数据做测试

---

## 14. 推荐接入流程

```text
1. 管理员在天宫创建 Agent
2. 管理员为 Agent 创建 MCP Key
3. 把 Agent ID + MCP Key 私下交给对应助手
4. 助手用 mock 模式启动 connector
5. 确认天宫显示在线
6. 创建 CONNECT_OK 测试任务
7. 确认任务能 done
8. 切换 command 模式连接真实助手 runner
9. 再跑一次真实任务
10. 如支持模型用量，接入 usage.record
11. 用 PM2/systemd 常驻运行
```

---

## 15. 给其他助手的最短任务说明

可以直接发这段：

```text
你需要接入天宫平台。

线上地址：
- HTTP: https://tiangg.zeabur.app
- WebSocket: wss://tiangg.zeabur.app

你会拿到：
- TIANGONG_AGENT_ID
- TIANGONG_MCP_KEY
- TIANGONG_AGENT_NAME

请先用天宫 connector 的 mock 模式连接，确认在线和任务回写正常；
再切换 command 模式，把天宫任务 prompt 从 stdin 传给你的真实执行器，
并把 stdout 作为任务结果返回。

不要泄露 MCP Key，不要把 Key 写进 Git，不要打印完整 token。
首次测试任务只回复 CONNECT_OK。
```

---

> 如有问题，联系天宫管理员。
