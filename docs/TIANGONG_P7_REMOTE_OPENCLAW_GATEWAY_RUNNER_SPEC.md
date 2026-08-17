# 天宫 P7 Spec — Remote OpenClaw Gateway Runner

> 目标：在 P6 安全 command runner 基础上，新增不依赖生产容器安装 `openclaw` CLI 的远程 OpenClaw Gateway 执行模式，让 Zeabur 上的 Tiangong 可以通过 HTTP 调用已运行的 OpenClaw Gateway agent endpoint。

## 背景

P6 的 `command` 模式适合容器内存在 `node/openclaw` CLI 的部署。但当前 Zeabur 生产镜像基于 `node:24-alpine`，没有 OpenClaw CLI；若直接把线上 runner 切成 `openclaw agent ...` 会持续失败。

OpenClaw Gateway 文档提供可选 HTTP agent endpoint：

- `POST /v1/chat/completions`
- `POST /v1/responses`

底层与 `openclaw agent` 相同，适合可信后端持有 Gateway bearer token 后远程触发 agent turn。

## 范围

1. Runner 模式扩展
   - `TIANGONG_TASK_RUNNER_MODE=mock|command|gateway`
   - 默认仍是 `mock`，不自动切生产。

2. Gateway mode 环境变量
   - `TIANGONG_OPENCLAW_GATEWAY_URL`：OpenClaw Gateway 根 URL。
   - `TIANGONG_OPENCLAW_GATEWAY_TOKEN`：Gateway bearer token/password，可为空以支持私有 open auth；status/log 不泄露。
   - `TIANGONG_OPENCLAW_GATEWAY_AGENT`：目标 agent，默认 `codemaster`。
   - `TIANGONG_OPENCLAW_GATEWAY_MODEL`：可选 backend model override，经 `x-openclaw-model` 传递。
   - `TIANGONG_OPENCLAW_GATEWAY_SESSION_PREFIX`：session key 前缀，默认 `tiangong`。

3. HTTP 行为
   - 调用 `POST {Gateway URL}/v1/chat/completions`。
   - body 使用 `model: openclaw/<agent>` 和 user message 为 Tiangong task prompt。
   - headers 设置：
     - `x-openclaw-agent-id`
     - `x-openclaw-session-key`
     - `x-openclaw-message-channel: tiangong-task-runner`
     - `authorization: Bearer ***`（仅当 token configured）
     - `x-openclaw-model`（仅当 model configured）
   - 使用 task timeout；超时通过 `AbortController` 取消并标记 task failed。

4. 安全诊断
   - `/api/runner/status` 只新增安全字段：
     - `gatewayConfigured`
     - `gatewayUrlConfigured`
     - `gatewayUrlHost`
     - `gatewayTokenConfigured`
     - `gatewayAgent`
     - `gatewayModelConfigured`
     - `gatewaySessionPrefixConfigured`
   - 不返回 token、完整 URL、prompt、headers、env。

## 切换前置条件

OpenClaw Gateway 必须：

1. 开启 `gateway.http.endpoints.chatCompletions.enabled=true`。
2. 其 HTTP endpoint 只暴露给可信私网/鉴权入口，不能直接公开 operator token 面。
3. Tiangong Zeabur env 配好 Gateway URL/token/agent。
4. 先在 `/api/runner/status` 确认 `mode=gateway` 且 `gatewayConfigured=true`，再创建真实 queued smoke 任务。

## 回滚

如果真实 Gateway 调用失败或 `consecutiveErrors` 增长，立即将：

```bash
TIANGONG_TASK_RUNNER_MODE=mock
```

重新部署/重启即可恢复默认 mock 稳定闭环。

## 验收

- `npm run check` 通过。
- `npm run build` 通过。
- `node --check scripts/smoke/p7-gateway-mock-server.mjs` 通过。
- 本地/线上 status endpoint 不泄露 token 或完整 Gateway URL。
- 生产默认仍保持 `mock`，除非确认 Gateway endpoint 和 secrets 后再切。
