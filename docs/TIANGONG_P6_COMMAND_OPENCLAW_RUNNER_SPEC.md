# 天宫 P6 Spec — 服务端 Runner Command/OpenClaw 真实执行模式

> 日期：2026-06-13
> 状态：Implementation target
> 目标：在 P5 服务端 Task Runner 稳定 mock 闭环基础上，把 `command` 模式补到生产可用，支持安全 argv 执行和 OpenClaw runner 集成，使线上可通过环境变量从 mock 切到真实 OpenClaw 执行。

## 背景

P5 已完成：API 服务内置 Task Runner，周期扫描 queued 任务，mock 模式可自动完成任务并回写 output/error，线上 smoke 已通过。

P3 已存在：`scripts/openclaw-connector/examples/openclaw-agent-runner.mjs` 可从 stdin 接收 prompt，通过 `openclaw agent --json` 调用指定 OpenClaw Agent，并提取最终文本。

P6 要把二者接上：服务端 Runner 不再只有 legacy command string，而是支持安全 argv 模式，便于直接调用 P3 runner。

## 目标

1. 服务端 Runner command 模式安全化
   - 保留 `TIANGONG_TASK_RUNNER_MODE=mock|command`。
   - 支持推荐配置：
     - `TIANGONG_TASK_RUNNER_EXEC_FILE`：执行文件，例如 `node`。
     - `TIANGONG_TASK_RUNNER_EXEC_ARGS_JSON`：JSON 字符串数组，例如 `["./scripts/openclaw-connector/examples/openclaw-agent-runner.mjs","--agent","codemaster","--timeout","600"]`。
   - `prompt` 通过 stdin 传入，不拼入 shell。
   - 使用 `spawn(file, args, { shell:false })`，捕获 stdout/stderr。
   - 保留旧 `TIANGONG_TASK_RUNNER_COMMAND` 作为 legacy fallback，但文档和 status 标明 legacy，不推荐。

2. OpenClaw runner 集成示例
   - 文档新增服务端 Runner 配置示例：
     - smoke：调用 `mock-openclaw.mjs`。
     - real：调用 `openclaw-agent-runner.mjs --agent codemaster`。
   - 不写入真实 token/secrets。
   - 不自动修改 Zeabur secrets；只提供配置方式。

3. Runner 状态增强
   - `/api/runner/status` 返回：
     - mode
     - commandConfigured
     - execMode：`argv | legacy | none | mock`
     - execFileConfigured:boolean
     - execArgsCount:number
     - legacyCommandConfigured:boolean
   - 不返回 command、args、env、token。

4. 前端可见性
   - Task Center Runner badge/详情展示 execMode 或 commandConfigured 更准确。
   - 不暴露命令内容。

5. 本地 smoke
   - 单元级命令 smoke：在本地用 `TIANGONG_TASK_RUNNER_MODE=command` + mock openclaw runner 至少验证 executeCommand 路径可返回 `MOCK_OPENCLAW_OK`。
   - 若直接调用服务端难度高，至少补一个脚本或导出 helper；但不要引入重型依赖。

## 安全边界

- 不把 user task input 拼进 shell command。
- 不打印完整 prompt。
- 不打印 env/secrets/command args。
- stdout/stderr 截断。
- timeout 后先 SIGTERM，再短 grace 后 SIGKILL。
- command failure/timeout 只能标记任务 failed，不能崩 API 服务。
- 不修改 Zeabur secrets，不创建域名，不删除服务。

## 推荐实现文件

- 修改：`api/lib/task-runner.ts`
- 修改：`api/boot.ts`
- 修改：`src/pages/TaskCenter.tsx`
- 更新：`scripts/openclaw-connector/README.md`
- 可新增：`scripts/openclaw-connector/examples/task-runner-command-smoke.mjs` 或等价 smoke helper

## 验收标准

必须通过：

```bash
node --check scripts/openclaw-connector/examples/openclaw-agent-runner.mjs
node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs --help
npm run check
npm run build
```

建议 smoke：

```bash
printf '[TASK] P6-MOCK: smoke\n[INPUT] hello\n' | \
node scripts/openclaw-connector/examples/openclaw-agent-runner.mjs \
  --agent codemaster \
  --openclaw-bin ./scripts/openclaw-connector/examples/mock-openclaw.mjs
```

stdout 应包含 `MOCK_OPENCLAW_OK`。

线上验收：

- push 到 GitHub main。
- Zeabur 部署后 `/api/runner/status` 包含 P6 新字段。
- 默认生产仍可保持 `mock` 模式稳定执行，不因未配置 command 而失败。
- 如未配置 Zeabur command env，不强行切真实执行；最终汇报说明如何切换。
