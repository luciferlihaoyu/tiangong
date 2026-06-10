# 天宫 P2 Spec — OpenClaw 真实执行桥

## 背景

P1 已完成：`scripts/openclaw-connector/connector.mjs` 能作为真实 Agent 接入天宫，保持 WebSocket 在线、心跳、收消息、ACK、认领 queued task，并把任务模拟执行为 done。

P2 目标是把 P1 的“模拟执行”升级为“调用 OpenClaw 执行”，让天宫 task 真正派发给 OpenClaw session/subagent，并将结果回写天宫。

## P2 目标

1. 真实执行桥
   - connector 收到/认领 task 后，根据配置决定如何调用 OpenClaw。
   - 支持至少一种安全可用的本地执行方式：调用 OpenClaw CLI 或可配置命令。
   - 支持 dry-run/mock fallback，避免没有 OpenClaw CLI 时整条链路不可验收。

2. 任务输入映射
   - 从天宫 task 读取：`name`、`description`、`input`、`taskId`。
   - 生成明确 prompt，要求执行者返回可直接写入天宫的结果。
   - 限制 prompt 不泄露 MCP Key/token。

3. 结果回写
   - 开始执行：`task.updateProgress` → `running`，progress 10/50 等。
   - 执行成功：`done`，progress 100，output 写入执行结果。
   - 执行失败/超时：`failed`，error/output 写入摘要。
   - 可选：通过 `message.send` 向发起方/指定 Agent 发送完成通知。

4. 配置方式
   - 保留 P1 CLI/env/config 兼容性。
   - 新增执行相关配置，推荐：
     - `TIANGONG_EXEC_MODE`：`mock` | `command`，默认 `mock`。
     - `TIANGONG_EXEC_COMMAND`：command 模板或固定命令，command 模式必填。
     - `TIANGONG_EXEC_TIMEOUT_MS`：默认 300000。
     - `TIANGONG_RESULT_MAX_CHARS`：默认 12000。
   - config file agent 项也可覆盖上述配置。

5. 安全与稳定
   - 不打印完整 token/key。
   - 不把 token/key 注入 task prompt。
   - command 执行需要 timeout。
   - stdout/stderr 截断，避免超长 output 写爆数据库。
   - 不引入重依赖，优先 Node 内置 `child_process`。
   - P2 不修改 Zeabur secrets、不改域名、不改生产权限。

## 建议实现

在 `scripts/openclaw-connector/connector.mjs` 内新增：

- Config 字段：
  - `execMode`
  - `execCommand`
  - `execTimeoutMs`
  - `resultMaxChars`
- CLI 参数：
  - `--exec-mode <mock|command>`
  - `--exec-command <cmd>`
  - `--exec-timeout <ms>`
  - `--result-max-chars <n>`
- 执行函数：
  - `buildTaskPrompt(cfg, task)`
  - `executeTask(cfg, task)`
  - `executeMock(cfg, task)`
  - `executeCommand(cfg, task, prompt)`
- `processTask` 改为：
  1. 标记 running/progress 10。
  2. 调用 `executeTask`。
  3. 成功写 done/progress 100/output。
  4. 失败写 failed/error/output。

### command 模式建议

为避免 shell 注入，优先用固定命令，并通过 stdin 传 prompt：

```bash
TIANGONG_EXEC_MODE=command \
TIANGONG_EXEC_COMMAND="node ./scripts/openclaw-connector/examples/echo-runner.mjs" \
node scripts/openclaw-connector/connector.mjs ...
```

connector 使用 `spawn(command, { shell: true })` 可以保留灵活性，但必须：

- 不把 token 放环境变量以外的 prompt。
- 使用 timeout kill。
- 捕获 stdout/stderr。
- 文档明确 command 来自可信配置，不能接收外部用户拼接。

## 验收标准

1. `node scripts/openclaw-connector/connector.mjs --help` 显示 P2 参数。
2. `node --check scripts/openclaw-connector/connector.mjs` 通过。
3. `npm run check` 通过。
4. `npm run build` 通过。
5. mock 模式：线上/本地 task 可被执行并写入包含 task name/id 的真实 output。
6. command 模式：用安全 echo-runner 测试，connector 将 task prompt 通过 stdin 交给 runner，runner 输出被写回 task output。
7. 失败模式：runner 非 0 退出或超时，task 被标记 failed。
8. 日志不泄露完整 MCP Key。

## 非目标

- 不在 P2 做完整多助手 DAG 编排。
- 不在 P2 做长期 daemon 部署/systemd/Zeabur worker。
- 不在 P2 自动改生产 admin 密码、APP_SECRET 或 MCP 权限模型。
- 不在 P2 直接把所有天宫 Agent 都常驻连接。

## 后续 P3 候选

- OpenClaw session API 深度集成。
- 天宫任务 UI 加执行日志流。
- 多助手协作 DAG。
- 生产 connector worker 部署。
- 安全加固与测试 key 生命周期管理。
