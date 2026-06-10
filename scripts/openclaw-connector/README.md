# 天宫 OpenClaw Connector (P2 + P3)

让真实 OpenClaw 助手作为 Agent 接入天宫多助手中枢。

- **P2**: 可配置执行桥（mock / command 模式），通过 stdin 将 task prompt 交给可信命令执行
- **P3**: OpenClaw Session Runner，调用 `openclaw agent --json` 将天宫 task 派发给 OpenClaw Agent/session，提取最终文本回写天宫

## 功能

- 🔌 **WebSocket 长连接** — 维持与天宫的实时双向连接
- 💓 **定时心跳** — 定期调用 `agent.updateHeartbeat` 保持在线状态
- 🎯 **自动认领任务** — 心跳返回 `claimedTask` 后自动处理并回传 done/failed
- 📩 **消息处理** — 接收 WebSocket 消息、记录日志、自动回复 ACK
- 🔄 **自动重连** — 指数退避重连，上限 30s
- 🔒 **Token 遮蔽** — 日志中自动隐藏敏感信息
- 🚀 **P2: 可配置执行桥** — mock 模式或 command 模式调用外部执行器

## 前置条件

### 1. 在天宫创建 MCP Key

在天宫管理面板中：
1. 进入 MCP 面板
2. 为指定的 Agent 创建一个 MCP API Key
3. 记录生成的 Key（格式：`tg-...`）

### 2. 确认 Agent 在天宫中有数字 ID

在天宫数据库中 Agent 表的主键 `id` 即为 `agentId`。可通过以下方式获取：

```bash
# 通过 API
curl http://localhost:3999/api/trpc/agent.list | jq '.result.data[].id, .result.data[].agentId, .result.data[].name'
```

## 快速开始

### 方式一：配置文件（推荐）

1. 复制示例配置并填入真实信息：

```bash
cp scripts/openclaw-connector/agents.example.json agents.json
# 编辑 agents.json，填入真实的 agentId 和 token
```

2. 启动连接器：

```bash
# 启动美智子（默认 mock 模式）
node scripts/openclaw-connector/connector.mjs \
  --config agents.json --agent-name meizhizi

# 启动编程大师（配置文件可指定 command 模式）
node scripts/openclaw-connector/connector.mjs \
  --config agents.json --agent-name codemaster
```

### 方式二：命令行参数

```bash
node scripts/openclaw-connector/connector.mjs \
  --agent-id 1 \
  --token tg-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx \
  --agent-name 美智子
```

### 方式三：环境变量

```bash
export TIANGONG_AGENT_ID=1
export TIANGONG_MCP_KEY=tg-xxxxxxxxxxxxxxxxxxxxxxxxxx
export TIANGONG_AGENT_NAME=美智子
node scripts/openclaw-connector/connector.mjs
```

### 连接到线上天宫

```bash
node scripts/openclaw-connector/connector.mjs \
  --config agents.json --agent-name meizhizi \
  --http-base https://tiangg.zeabur.app \
  --ws-base wss://tiangg.zeabur.app
```

## P2: 执行模式

Connector 支持两种执行模式，通过 `--exec-mode` 或 `TIANGONG_EXEC_MODE` 配置。

### Mock 模式（默认）

模拟任务执行，返回包含 task name/id 的确认信息。无需外部依赖。

```bash
# 默认即为 mock
node connector.mjs --config agents.json -n meizhizi
```

### Command 模式

通过 `child_process.spawn` 执行可信配置命令，将 task prompt 通过 **stdin** 传入，捕获 stdout 作为结果。

**推荐：argv 模式（shell:false）**

```bash
# 使用 execFile + execArgs（推荐）
TIANGONG_EXEC_MODE=command \
TIANGONG_EXEC_FILE=node \
TIANGONG_EXEC_ARGS_JSON='["./scripts/openclaw-connector/examples/echo-runner.mjs"]' \
node connector.mjs --config agents.json -n codemaster
```

**Legacy：字符串模式（shell:true）**

```bash
# 仅限受信任配置使用
TIANGONG_EXEC_MODE=command \
TIANGONG_EXEC_COMMAND="node ./scripts/openclaw-connector/examples/echo-runner.mjs" \
node connector.mjs --config agents.json -n codemaster-legacy
```

**执行流程：**

1. Connector 收到/认领 task
2. 调用 `task.updateProgress` → running, progress 10
3. 调用 `buildTaskPrompt` 生成 prompt（不含 token/key）
4. `spawn(execFile, execArgs)` 或 `spawn(execCommand)` 启动子进程，stdin 写入 prompt
5. 等待进程退出：
   - **成功 (exit 0)**：`task.updateProgress` → done, progress 100, output=stdout
   - **失败 (exit ≠ 0)**：`task.updateProgress` → failed, error=stderr
   - **超时**：SIGTERM → 5s 后 SIGKILL → failed
6. stdout/stderr 截断到 `resultMaxChars`

**P5 安全加固：**

- 推荐使用 `execFile` + `execArgs`（argv 模式），使用 `spawn(file, args, {shell: false})`，更安全
- `execCommand` 为 legacy 模式，仅限**受信任的配置**使用（管理员可控）
- 日志仅输出模式类型（argv / legacy string），不输出完整 command/args
- Token/Key **不会**出现在 prompt 中
- 命令来自**可信配置**（配置文件或环境变量），不接受外部用户拼接
- 超时保护防止僵尸进程
- 输出截断防止写爆数据库

## 配置说明

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `--config` | — | — | JSON 配置文件路径 |
| `--agent-name` | — | — | 从配置文件选择 Agent |
| `--agent-id` | `TIANGONG_AGENT_ID` | — | Agent 在天宫的数据库 ID |
| `--token` | `TIANGONG_MCP_KEY` | — | Agent 的 MCP API Key |
| `--http-base` | `TIANGONG_HTTP_BASE` | `http://localhost:3999` | tRPC HTTP 端点 |
| `--ws-base` | `TIANGONG_WS_BASE` | `ws://localhost:3999` | WebSocket 端点 |
| `--heartbeat` | — | `30000` | 心跳间隔（毫秒） |
| `--exec-mode` | `TIANGONG_EXEC_MODE` | `mock` | 执行模式: `mock` 或 `command` |
| `--exec-file` | `TIANGONG_EXEC_FILE` | — | command 模式执行文件（推荐 argv 模式） |
| `--exec-args` | `TIANGONG_EXEC_ARGS_JSON` | — | command 模式执行参数 JSON 数组 |
| `--exec-command` | `TIANGONG_EXEC_COMMAND` | — | command 模式命令（legacy，仅受信任配置） |
| `--exec-timeout` | `TIANGONG_EXEC_TIMEOUT_MS` | `300000` | 执行超时（毫秒） |
| `--result-max-chars` | `TIANGONG_RESULT_MAX_CHARS` | `12000` | 结果最大字符数 |

## 配置文件格式

```json
{
  "agents": [
    {
      "name": "meizhizi",
      "agentId": 1,
      "token": "tg-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "label": "美智子",
      "httpBase": "https://tiangg.zeabur.app",
      "wsBase": "wss://tiangg.zeabur.app"
    },
    {
      "name": "codemaster",
      "agentId": 2,
      "token": "tg-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy",
      "label": "编程大师",
      "execMode": "command",
      "execFile": "node",
      "execArgs": ["./scripts/openclaw-connector/examples/openclaw-agent-runner.mjs", "--agent", "codemaster", "--timeout", "600"],
      "execTimeoutMs": 660000,
      "resultMaxChars": 12000
    },
    {
      "name": "codemaster-echo",
      "agentId": 3,
      "token": "tg-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
      "label": "编程大师 (Echo 烟测)",
      "execMode": "command",
      "execFile": "node",
      "execArgs": ["./scripts/openclaw-connector/examples/echo-runner.mjs"],
      "execTimeoutMs": 300000,
      "resultMaxChars": 12000
    },
    {
      "name": "codemaster-legacy",
      "agentId": 4,
      "token": "tg-wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww",
      "label": "编程大师 (Legacy - 仅受信任配置)",
      "execMode": "command",
      "execCommand": "node ./scripts/openclaw-connector/examples/echo-runner.mjs",
      "execTimeoutMs": 300000,
      "resultMaxChars": 12000
    }
  ]
}
```

配置文件中的 `httpBase` 和 `wsBase` 为可选，默认使用环境变量或内置默认值。命令行参数优先级高于配置文件和环境变量。

每个 agent 项可覆盖 `execMode`、`execFile`、`execArgs`、`execCommand`、`execTimeoutMs`、`resultMaxChars`。

**推荐配置：**
- 使用 `execFile` + `execArgs`（argv 模式，shell:false），更安全
- `execCommand` 为 legacy 模式，仅限**受信任的配置**使用（例如管理员手动配置的生产环境）

## 运行流程

```
启动 → 连接 WebSocket → 定时心跳 (30s)
              ↓
    收到 WS message 事件 → 记录 + ACK
    心跳返回 claimedTask → 处理任务:
      1. progress 10 / running
      2. executeTask (mock 或 command)
      3. 成功: progress 100 / done / output
      4. 失败: failed / error / output
    连接断开 → 指数退避重连
```

## Echo Runner（烟测工具）

`examples/echo-runner.mjs` 是一个安全的烟测工具，用于验证 command 模式：

```bash
# 基本测试
echo "hello world" | node examples/echo-runner.mjs
# 输出: ECHO_RUNNER_OK | chars=11 | hello world

# 模拟失败
FAIL_MODE=1 echo "test" | node examples/echo-runner.mjs
# 退出码 1，stderr: ECHO_RUNNER_FAIL

# 模拟超时（sleep 400s，connector 超时设为 5s 可触发）
SLEEP_SEC=400 echo "test" | node examples/echo-runner.mjs
```

## 验收命令

### 1. 语法检查

```bash
node --check scripts/openclaw-connector/connector.mjs
node --check scripts/openclaw-connector/examples/echo-runner.mjs
```

### 2. 帮助信息

```bash
node scripts/openclaw-connector/connector.mjs --help
```

### 3. 项目检查

```bash
npm run check
npm run build
```

### 4. 启动本地天宫服务

```bash
npm run dev
```

### 5. 启动两个连接器（两个终端）

```bash
# 终端 1 — 美智子（mock 模式）
node scripts/openclaw-connector/connector.mjs --config agents.json -n meizhizi

# 终端 2 — 编程大师（command 模式，使用 echo-runner）
node scripts/openclaw-connector/connector.mjs --config agents.json -n codemaster
```

### 6. 验证在线状态

```bash
curl http://localhost:3999/api/ws/status | jq
# 应看到 onlineAgents 包含美智子和编程大师的 ID
```

### 7. 创建任务并观察认领

```bash
# 创建给编程大师的 queued task
curl -X POST http://localhost:3999/api/trpc/task.create \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"test-001","name":"测试任务","agentId":2,"status":"queued","priority":5,"description":"验证任务认领闭环"}'

# 观察编程大师终端是否输出"认领到任务"和"标记为 done"
# command 模式下 output 应包含 ECHO_RUNNER_OK
```

### 8. 验证消息路由

```bash
# 美智子 → 编程大师 发送 command
curl -X POST http://localhost:3999/api/trpc/message.send \
  -H 'Content-Type: application/json' \
  -d '{"fromAgent":1,"toAgent":2,"content":"你好，编程大师！","type":"command"}'

# 编程大师终端应显示收到消息 + 自动回复 ACK
# 美智子终端应收到 ACK response
```

### 9. Command 模式 dry-run（无需天宫服务）

```bash
# 直接测试 echo-runner
echo "test prompt" | node scripts/openclaw-connector/examples/echo-runner.mjs

# 模拟失败
FAIL_MODE=1 echo "test" | node scripts/openclaw-connector/examples/echo-runner.mjs; echo "exit=$?"

# 模拟超时（设置短超时）
timeout 3 sh -c 'SLEEP_SEC=10 echo "test" | node scripts/openclaw-connector/examples/echo-runner.mjs'; echo "exit=$?"
```

## P3: OpenClaw Session Runner

`examples/openclaw-agent-runner.mjs` 是一个无新 npm 依赖的 runner，让 connector 的 command 模式可以调用 `openclaw agent --json`，把天宫 task prompt 派发给 OpenClaw Agent/session，并将最终文本输出给 connector 回写。

### 闭环流程

```text
Tiangong task
  → connector claim
  → P2 command mode
  → openclaw-agent-runner.mjs
  → openclaw agent --json
  → runner extracts final text
  → connector task.updateProgress(done/failed)
```

### 快速开始

```bash
# 基本用法：通过 stdin 传入 prompt
printf '=== Tiangong Task ===\nTask ID: P3-TEST\nName: test\n' | \
  node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs \
    --agent codemaster --timeout 600

# 通过 connector 的 execCommand 使用（推荐）
TIANGONG_EXEC_MODE=command \
TIANGONG_EXEC_COMMAND="node ./scripts/openclaw-connector/examples/openclaw-agent-runner.mjs --agent codemaster --timeout 600" \
node scripts/openclaw-connector/connector.mjs --config agents.json -n codemaster
```

### Runner 选项

| 选项 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `--agent` | `OPENCLAW_RUNNER_AGENT` | — | 目标 OpenClaw agent（必需） |
| `--session-key` | `OPENCLAW_RUNNER_SESSION_KEY` | 从 Task ID 生成 | 会话 key，格式 `tiangong-{agent}-{taskId}` |
| `--model` | `OPENCLAW_RUNNER_MODEL` | — | 可选模型覆盖 |
| `--thinking` | `OPENCLAW_RUNNER_THINKING` | — | 可选 reasoning/thinking 覆盖 |
| `--timeout` | `OPENCLAW_RUNNER_TIMEOUT_SECONDS` | `300` | 传给 openclaw agent 的超时秒数 |
| `--local` | `OPENCLAW_RUNNER_LOCAL=1` | `false` | 透传 --local 给 openclaw agent |
| `--openclaw-bin` | `OPENCLAW_BIN` | `openclaw` | openclaw 二进制路径 |

### 安全设计

- 使用 `child_process.spawn` + argv 数组 + `shell: false`，**不拼接 shell 字符串**
- prompt 来自 P2 `buildTaskPrompt`，**不含 token/key**
- 日志中不打印完整 prompt，仅输出 chars/taskId/sessionKey 等摘要
- stdout/stderr 收集有上限（1MB），防止内存膨胀
- stderr 输出经过安全清理，移除 token/key 模式
- 非 0 / timeout 返回非 0，让 connector 标记 failed

### Session Key 生成

如未指定 `--session-key`，runner 从 prompt 的 `Task ID:` 行提取 taskId，生成稳定 key：

```
tiangong-{agent}-{taskId}
```

字符清理到 `[a-zA-Z0-9._:-]`，确保不同任务不会互相污染上下文。

### JSON 输出解析

Runner 从 `openclaw agent --json` 输出中提取文本，按优先级尝试：

1. `payloads[].text`
2. `result.payloads[].text`
3. `reply`
4. `text`
5. `message`
6. `result` (string)
7. `result.text`
8. `result.reply`
9. `result.message`

无法解析时输出安全摘要（JSON keys + 截断内容），不泄露原始数据。

### 本地烟测（无需真实模型）

使用 `mock-openclaw.mjs` 验证 runner 的 JSON 解析和错误处理：

```bash
# 1. 语法检查
node --check scripts/openclaw-connector/examples/openclaw-agent-runner.mjs
node --check scripts/openclaw-connector/examples/mock-openclaw.mjs

# 2. 帮助信息
node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs --help

# 3. 基本 smoke — payloads 形状
printf '=== Tiangong Task ===\nTask ID: P3-MOCK\nName: test\n' | \
  node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs \
    --agent codemaster \
    --openclaw-bin node \
    --openclaw-bin-override ./scripts/openclaw-connector/examples/mock-openclaw.mjs

# 注意：--openclaw-bin 指向 node，需要通过额外方式传 mock 脚本。
# 推荐使用包装脚本：

# 创建临时 mock openclaw 包装器
cat > /tmp/mock-openclaw << 'EOF'
#!/bin/sh
exec node /home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/examples/mock-openclaw.mjs "$@"
EOF
chmod +x /tmp/mock-openclaw

# 运行 smoke
printf '=== Tiangong Task ===\nTask ID: P3-MOCK\nName: test\n' | \
  node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs \
    --agent codemaster \
    --openclaw-bin /tmp/mock-openclaw
# stdout 应包含 MOCK_OPENCLAW_OK

# 4. 测试多种 JSON 形状
for shape in payloads result-payloads reply text message result-string result-text result-reply result-message bad-json; do
  echo "--- Testing shape: $shape ---"
  printf '=== Tiangong Task ===\nTask ID: P3-MOCK\nName: test\n' | \
    MOCK_SHAPE=$shape \
    node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs \
      --agent codemaster \
      --openclaw-bin /tmp/mock-openclaw
  echo "exit=$?"
done

# 5. 测试失败场景
printf '=== Tiangong Task ===\nTask ID: P3-MOCK\nName: test\n' | \
  MOCK_FAIL=1 \
  node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs \
    --agent codemaster \
    --openclaw-bin /tmp/mock-openclaw
# exit code 应为非 0

# 6. 测试空输出场景
printf '=== Tiangong Task ===\nTask ID: P3-MOCK\nName: test\n' | \
  MOCK_EMPTY=1 \
  node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs \
    --agent codemaster \
    --openclaw-bin /tmp/mock-openclaw
# exit code 应为非 0
```

### P2+P3 闭环烟测

使用 `examples/trpc-stub-smoke.mjs` 验证 connector + runner 完整闭环：

```bash
# 先创建 mock openclaw 包装器（如上）

# 启动 stub 服务器（后台）
node scripts/openclaw-connector/examples/trpc-stub-smoke.mjs &
STUB_PID=$!
sleep 1

# 启动 connector（command 模式 + runner）
TIANGONG_EXEC_MODE=command \
TIANGONG_EXEC_COMMAND="node ./scripts/openclaw-connector/examples/openclaw-agent-runner.mjs --agent codemaster --openclaw-bin /tmp/mock-openclaw" \
TIANGONG_AGENT_ID=9001 \
TIANGONG_MCP_KEY=tg-mock-key-for-smoke-test-only-123456 \
TIANGONG_HTTP_BASE=http://localhost:4899 \
TIANGONG_WS_BASE=ws://localhost:4899 \
node scripts/openclaw-connector/connector.mjs

# 观察输出：应看到 task.updateProgress done，output 包含 MOCK_OPENCLAW_OK
# stub 会在完成后自动退出

kill $STUB_PID 2>/dev/null
```

> **注意**: 真实模型调用仅作为人工验收，避免在自动测试中消耗模型配额。

## 文件结构

```
scripts/openclaw-connector/
├── README.md                      # 本文件
├── connector.mjs                  # 主连接器脚本 (P2)
├── agents.example.json            # 配置文件示例
└── examples/
    ├── echo-runner.mjs            # command 模式烟测工具 (P2)
    ├── openclaw-agent-runner.mjs  # OpenClaw Session Runner (P3)
    ├── mock-openclaw.mjs          # Mock openclaw 烟测工具 (P3)
    └── trpc-stub-smoke.mjs        # tRPC stub 烟测服务器 (P2)
```

## 技术依赖

- Node.js 20+
- 内置 `fetch`（HTTP/HTTPS）
- 内置 `child_process`（command 模式）
- `ws` 包（WebSocket 客户端，项目已有依赖）
- 可选：`dotenv` 包（项目已有依赖，用于 `.env` 文件加载）

## License

同天宫项目
