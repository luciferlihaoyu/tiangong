# 天宫 P1 Spec — OpenClaw 助手真实接入器

## 背景
P0 已验收通过：线上两个 Agent 可通过 `wss://tiangg.zeabur.app/ws` 同时连接，并通过 `message.send` 实时双向通信。

P1 目标是把临时 E2E 脚本升级为可复用的 OpenClaw 助手接入器，让天宫开始承担“真实多助手中枢”的角色。

## P1 目标

1. 真实助手接入
   - 首批接入：美智子、编程大师。
   - 每个助手使用天宫 Agent ID + MCP Key。
   - 接入器维持 WebSocket 长连接。

2. 心跳与在线状态
   - 接入器定时调用 `agent.updateHeartbeat`。
   - 天宫前端可看到助手在线/离线状态。
   - 心跳返回 claimedTask 时，接入器能识别并处理。

3. 任务认领闭环
   - 天宫创建 queued task，指定给某个 Agent。
   - 助手心跳/claim 后收到任务。
   - 接入器更新任务状态：running → done/failed。
   - 接入器通过 `message.send` 回传执行确认/结果。

4. WebSocket 消息闭环
   - 接入器收到 `message` 类型事件后，根据消息 type 处理：
     - `command`：记录/回 ACK。
     - `response`：记录。
     - `broadcast/system`：记录。
   - 最小版本先不真正调用 OpenClaw 内部会话执行，只完成“收任务、确认、回传”。

## 非目标

- 不在 P1 做复杂任务编排 DAG。
- 不在 P1 做多租户权限重构。
- 不在 P1 修改 Zeabur 域名/删除服务。
- 不在 P1 自动更改生产 admin 密码/APP_SECRET；这属于安全加固，需要单独授权。

## 建议实现

新增目录：

```text
scripts/openclaw-connector/
  README.md
  connector.mjs
  agents.example.json
```

### connector.mjs

功能：

- 读取配置文件或环境变量：
  - `TIANGONG_HTTP_BASE`
  - `TIANGONG_WS_BASE`
  - `TIANGONG_AGENT_ID`
  - `TIANGONG_MCP_KEY`
  - `TIANGONG_AGENT_NAME`
- 建立 WebSocket：`/ws?agentId=X&token=***`
- 定时心跳：`/api/trpc/agent.updateHeartbeat`
- 可选主动 claim：`/api/trpc/agent.claimTask`
- 任务完成后调用：`/api/trpc/task.updateProgress`
- 消息回传：`/api/trpc/message.send`
- 自动重连：指数退避，上限 30s。
- 日志敏感信息遮蔽。

### README.md

包含：

- 如何给 Agent 创建 MCP Key。
- 如何启动一个助手接入器。
- 如何启动两个助手做本地/线上闭环。
- 验收命令。

## 验收标准

1. `npm run check` 通过。
2. `npm run build` 通过。
3. 线上启动两个 connector：
   - 美智子 connector online。
   - 编程大师 connector online。
4. 天宫创建给编程大师的 queued task。
5. 编程大师 connector 认领任务并回传 done。
6. 美智子与编程大师之间能通过天宫消息路由发送 command/response。
7. `/api/ws/status` 可看到在线期间 Agent ID 出现在 onlineAgents。

## 风险/注意

- 当前生产 admin/admin 和默认 APP_SECRET 需要后续安全加固，但不混入 P1。
- 测试 MCP Key 不要输出完整值。
- 如果 connector 常驻要上线，后续再做 systemd/cron/Zeabur worker；P1 先用可执行脚本验证。
