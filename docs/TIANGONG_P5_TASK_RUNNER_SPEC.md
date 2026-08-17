# 天宫 P5：真实任务执行闭环 Spec

> 状态：Implementation in progress
> 日期：2026-06-13
> 目标：把 P4 的手动任务指挥中心升级为自动执行闭环：queued task 自动进入执行、回写 output/error、广播状态、可在线验收。

## 背景

P4 已完成 `/task-center`：可以创建任务、指派 Agent、手动排队/执行/完成/失败、写入记事板、WebSocket 刷新。

P5 要补上真正的执行层，让天宫不只是任务面板，而是可以自动派活的 Agent 调度中心。

## 目标

### P0 — 服务端 Task Runner

1. 新增服务端 Runner
   - 在 API 服务启动时初始化。
   - 周期性扫描 `queued` 任务。
   - 按优先级和创建时间领取任务。
   - 用安全状态更新避免重复领取。
   - 领取后：`queued -> running`，progress 至少更新到 10。

2. 执行任务
   - 根据任务的 `agentId` 找到 Agent。
   - 根据 Agent 信息和 task input 构造执行 prompt。
   - P5 最小可验收执行模式必须稳定：
     - 默认 `mock` 模式：生成结构化执行结果，保证线上可验收。
     - 可配置 `command` 模式：通过可信命令 stdin 传入 prompt，捕获 stdout/stderr。
   - 不把 token/key/secrets 放进 prompt、stdout、日志。

3. 结果回写
   - 成功：写入 `output`，`status=done`，`progress=100`。
   - 失败/超时：写入 `error`，`status=failed`，保留简短 output/error 摘要。
   - 每次状态变化广播 `task_update` 到 Dashboard WS。

### P1 — 执行日志/轨迹

4. 轻量执行轨迹
   - 不做复杂新表优先；如要改 schema，必须同步 auto-migrate。
   - 推荐先把阶段日志写进 `output` 或 `error` 的结构化文本区块，前端详情可直接显示。
   - 如果新增 `task_logs` 表，必须更新 `db/schema.ts` 和 `api/lib/auto-migrate.ts`，并提供查询接口。

5. 前端展示
   - Task detail drawer 显示 Runner 信息：自动执行中/完成/失败，output/error 已可见。
   - 如新增日志接口，则在详情抽屉补「执行轨迹」区。

### P2 — 健康状态与部署判断

6. 修正 `/mcp/health` build 信息
   - 当前 `api/mcp/transport.ts` 的 build 是硬编码 `4ca0e5f`，会误导部署判断。
   - 改为从 env 读取：`GIT_COMMIT` / `ZEABUR_GIT_COMMIT` / `SOURCE_VERSION` / fallback `unknown`。
   - 保留 version 字段。

7. Runner 状态诊断
   - 增加最小诊断接口或 health 字段：runner enabled/mode/interval/running。
   - 避免泄露 command 内容中的 secrets；返回 command 时最多返回是否设置。

## 配置建议

使用环境变量，默认安全可跑：

- `TIANGONG_TASK_RUNNER_ENABLED`：默认 `true`。
- `TIANGONG_TASK_RUNNER_MODE`：`mock | command`，默认 `mock`。
- `TIANGONG_TASK_RUNNER_INTERVAL_MS`：默认 `5000`。
- `TIANGONG_TASK_RUNNER_BATCH_SIZE`：默认 `1`，最大建议 `5`。
- `TIANGONG_TASK_RUNNER_COMMAND`：command 模式使用，可信配置；prompt 通过 stdin 传入。
- `TIANGONG_TASK_RUNNER_TIMEOUT_MS`：默认 `300000`。
- `TIANGONG_TASK_RUNNER_RESULT_MAX_CHARS`：默认 `12000`。

## 安全边界

- 不修改 Zeabur secrets。
- 不创建/删除 Zeabur 域名或服务。
- 不外泄 API key/token/JWT/数据库 URL。
- command 模式只接受服务端可信配置，不把用户输入拼进 shell command。
- stdout/stderr 必须截断。
- Runner 错误不能导致 API 服务崩溃。

## 非目标

- 不做复杂 DAG 并发调度。
- 不做多租户权限重构。
- 不自动创建公网域名。
- 不删除任何 Zeabur 项目/服务。
- 不强依赖真实 OpenClaw 模型调用；mock 模式必须能独立验收。

## 验收标准

本地必须通过：

```bash
npm run check
npm run build
```

线上必须验证：

1. GitHub `origin/main` 包含 P5 commit。
2. `https://tiangg.zeabur.app` 正常返回。
3. `/mcp/health` build 不再是硬编码旧值。
4. 创建/排队一个测试任务后，Runner 可自动把它从 `queued` 推进到 `running` 再到 `done` 或 `failed`。
5. 任务详情里能看到 output 或 error。
6. 前端 `/task-center` 仍可访问，JS 包含 P5 新标记。

## 推荐实现文件

- 新增：`api/lib/task-runner.ts`
- 修改：`api/boot.ts`
- 修改：`api/mcp/transport.ts`
- 可能修改：`api/task-router.ts` / `api/orchestration-router.ts`
- 可能修改：`src/pages/TaskCenter.tsx`
- 新增/更新：`TIANGONG_P5_TASK_RUNNER_SPEC.md`
