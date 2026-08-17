# 天宫 P7：远程 OpenClaw Gateway Runner（实施版）

> 基于已有 SPEC 的精简实施版本
> 目标：让 Zeabur 上的天宫可以通过 HTTP 调用本地 OpenClaw Gateway，实现真实任务自动执行

## 实施范围

### 1. 服务端 Runner 新增 gateway 模式

在 `api/lib/task-runner.ts`（或现有 runner 文件）中新增：

- `TIANGONG_TASK_RUNNER_MODE=mock|gateway`（默认 mock）
- gateway 模式环境变量：
  - `TIANGONG_OPENCLAW_GATEWAY_URL`：Gateway 根 URL
  - `TIANGONG_OPENCLAW_GATEWAY_TOKEN`：Bearer token
  - `TIANGONG_OPENCLAW_GATEWAY_AGENT`：目标 agent（默认 `codemaster`）
  - `TIANGONG_OPENCLAW_GATEWAY_MODEL`：可选 model override
  - `TIANGONG_OPENCLAW_GATEWAY_SESSION_PREFIX`：session key 前缀（默认 `tiangong`）

### 2. HTTP 调用行为

- `POST {Gateway URL}/v1/chat/completions`
- body: `{ model: "openclaw/<agent>", messages: [{ role: "user", content: prompt }] }`
- headers:
  - `x-openclaw-agent-id`
  - `x-openclaw-session-key`（格式：`tiangong-<taskId>`）
  - `x-openclaw-message-channel: tiangong-task-runner`
  - `authorization: Bearer ***`
  - `x-openclaw-model`（可选）
- 使用 task timeout，超时通过 AbortController 取消

### 3. Runner 状态增强

`/api/runner/status` 新增字段（不泄露 token/完整 URL）：
- `gatewayConfigured`
- `gatewayUrlConfigured`
- `gatewayUrlHost`
- `gatewayTokenConfigured`
- `gatewayAgent`
- `gatewayModelConfigured`

### 4. 安全

- 不打印完整 token/key
- 不把 token 注入 task prompt
- status 不返回 token、完整 URL、prompt

## 修改文件

1. `api/lib/task-runner.ts`（或现有 runner 实现）
2. `api/lib/env.ts`（新增 gateway 环境变量定义）
3. 新增 smoke 脚本 `scripts/smoke/p7-gateway-mock-server.mjs`

## 验收

- `npm run check` 通过
- 线上默认保持 `mock` 模式
- status endpoint 不泄露敏感信息
