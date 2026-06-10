# 天宫 P3：OpenClaw Session Runner / 会话调度桥 Spec

> 状态：Draft for implementation
> 目标：在 P2 command 执行桥之上，提供一个可复用的 OpenClaw 会话执行器，让天宫 task 能真正派发给 OpenClaw Agent/session/subagent，并把最终回复回写天宫。

## 背景

P0/P1/P2 已完成：

- P0：天宫 WebSocket 支持 Agent 实时双向通信。
- P1：`scripts/openclaw-connector/connector.mjs` 可作为真实 Agent 接入天宫，心跳、ACK、任务认领、状态回写。
- P2：connector 新增 `mock|command` 执行桥；`command` 模式通过 stdin 将 task prompt 交给可信命令执行，并捕获 stdout/stderr 回写 task。

P3 不改天宫线上鉴权、不改生产 secrets、不部署 daemon。P3 的最小闭环是：

```text
Tiangong task
  -> connector claim
  -> P2 command mode
  -> OpenClaw runner
  -> openclaw agent turn
  -> runner extracts final text
  -> connector task.updateProgress(done/failed)
```

## 范围

### In scope

1. 新增一个无新 npm 依赖的 runner：
   - 建议路径：`scripts/openclaw-connector/examples/openclaw-agent-runner.mjs`
   - shebang：`#!/usr/bin/env node`
   - 从 stdin 读取 P2 构造出的 prompt。
   - 通过 `child_process.spawn` 调用 `openclaw agent`。
   - 使用 `shell: false` 和 argv 数组，避免 shell 注入。
   - 默认输出最终可读文本到 stdout，供 connector 回写到天宫。
   - stderr 只放诊断，不输出敏感 token/key。

2. Runner 支持 CLI：
   - `--agent <id>`：目标 OpenClaw agent，例如 `codemaster`。
   - `--session-key <key>`：可选，目标会话 key；默认可由 runner 根据 Tiangong Task ID 生成稳定 key。
   - `--model <model>`：可选模型覆盖。
   - `--thinking <level>`：可选 reasoning/thinking 覆盖。
   - `--timeout <seconds>`：传给 `openclaw agent --timeout`。
   - `--local`：可选，透传给 `openclaw agent --local`。
   - `--json`：内部默认使用 `openclaw agent --json`，此参数可仅用于 debug 或保留兼容。
   - `--openclaw-bin <path>`：可选，默认 `openclaw`。

3. Runner 支持 env：
   - `OPENCLAW_RUNNER_AGENT`
   - `OPENCLAW_RUNNER_SESSION_KEY`
   - `OPENCLAW_RUNNER_MODEL`
   - `OPENCLAW_RUNNER_THINKING`
   - `OPENCLAW_RUNNER_TIMEOUT_SECONDS`
   - `OPENCLAW_RUNNER_LOCAL=1`
   - `OPENCLAW_BIN`

4. Runner 输出解析：
   - 调用命令形态：
     ```bash
     openclaw agent --agent <id> --message <prompt> --json [--session-key <key>] [--model <id>] [--thinking <level>] [--timeout <seconds>] [--local]
     ```
   - 尽量从 JSON 中提取最终文本：
     - `payloads[].text`
     - `result.payloads[].text`
     - `reply` / `text` / `message`
     - 如果无法识别，则输出格式化后的 JSON 摘要或原 stdout 截断。
   - 非 0 exit：runner 自身非 0，stderr 包含 exit code 和截断后的 stdout/stderr 诊断。

5. 安全边界：
   - 不读取、不打印、不注入天宫 MCP Key/JWT/生产密码。
   - prompt 来自 P2 `buildTaskPrompt`，已不含 token/key。
   - runner 调用 `openclaw agent` 使用 argv 数组，不拼 shell。
   - 日志中不打印完整 prompt，只可打印 chars/taskId/sessionKey 等摘要。
   - 输出限制：runner 自身可有 stdout/stderr 最大长度保护，connector 仍保留 `resultMaxChars` 最终截断。

6. 文档与示例：
   - 更新 `scripts/openclaw-connector/README.md`：新增 P3 OpenClaw runner 用法。
   - 更新 `agents.example.json`：加入注释风格不可用 JSON，因此只能用示例字段展示 `execMode=command` + `execCommand` 指向 runner；token 使用 `tg-...` 风格占位。
   - 可选新增本地 parser smoke：用 mock `openclaw` 脚本验证 runner JSON 提取，不需要真实调用模型。

### Out of scope

- 不修改 Zeabur secrets、域名、生产 auth policy。
- 不做 systemd/cron/daemon 常驻部署。
- 不做多租户权限重构。
- 不做复杂 DAG 调度。
- 不自动接入所有 Agent。
- 不提交/推送，除非 L 单独确认。

## 实现建议

### Runner 结构

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';

const prompt = await readStdin();
const opts = parseArgsAndEnv();
const args = ['agent', '--agent', opts.agent, '--message', prompt, '--json'];
if (opts.sessionKey) args.push('--session-key', opts.sessionKey);
if (opts.model) args.push('--model', opts.model);
if (opts.thinking) args.push('--thinking', opts.thinking);
if (opts.timeoutSeconds) args.push('--timeout', String(opts.timeoutSeconds));
if (opts.local) args.push('--local');

const { code, stdout, stderr } = await spawnCollect(opts.openclawBin, args, timeoutMs);
if (code !== 0) fail(...);
console.log(extractText(stdout));
```

注意：

- `spawnCollect` 需要 stdout/stderr 上限，避免内存膨胀。
- runner timeout 应略大于 `openclaw agent --timeout`，例如 `timeoutSeconds + 30s`。
- 不要把 prompt 打进 stderr。
- 如果 `--session-key` 未设置，可从 prompt 的 `Task ID:` 行提取 taskId，生成 `tiangong-${agent}-${taskId}`，但要做字符清理；或者默认不传 session-key，让 OpenClaw 用 agent 默认会话。推荐：默认生成稳定 session-key，避免任务上下文互相污染。

## 验收要求

必须通过：

```bash
node --check scripts/openclaw-connector/examples/openclaw-agent-runner.mjs
node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs --help
npm run check
npm run build
```

建议本地无模型 smoke：

1. 创建临时 mock openclaw：输出 JSON：
   ```json
   {"payloads":[{"text":"MOCK_OPENCLAW_OK"}],"meta":{"durationMs":1}}
   ```
2. 执行：
   ```bash
   printf '=== Tiangong Task ===\nTask ID: P3-MOCK\nName: test\n' | \
   node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs \
     --agent codemaster \
     --openclaw-bin /tmp/mock-openclaw
   ```
3. stdout 应包含 `MOCK_OPENCLAW_OK`。

建议 P2+P3 connector 闭环 smoke：

- 使用现有 `examples/trpc-stub-smoke.mjs` 或新增变体，让 connector 的 `TIANGONG_EXEC_COMMAND` 指向 runner + mock openclaw。
- 验证最终 `task.updateProgress(done/progress=100/output)` 包含 `MOCK_OPENCLAW_OK`。

真实模型调用只作为可选人工验收，避免在自动测试中消耗模型配额。

## 父级复核重点

- Runner 是否完全避免 shell 拼接。
- Runner 是否不会打印 prompt、token、key。
- `openclaw agent --json` 解析是否兼容多种返回形态。
- 非 0 / timeout 是否能让 connector 标记 failed。
- README 是否明确 P3 只是本地 runner/执行桥，不是生产 daemon 部署。
- `agents.example.json` 是否不含真实 key。
