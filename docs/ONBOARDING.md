# 天宫新系统接入指引（ONBOARDING）

> 任何外部系统接入天宫任务闭环的标准路径。目标：**一次注册调用 + 一行启动命令 = 全自动任务闭环**。

## 闭环定义

```
发布任务（任意方）→ 你的 connector 自动认领 → 你的系统真身执行
→ 结果自动回写 → 任务 done，发布方可查
```

## 第一步：选执行模式

```
你的系统能被怎么调用？
├─ 有 HTTP 端点（收 JSON 返 JSON）      → mode=http    （connector 代跑）
├─ 有命令行入口（stdin 收/stdout 出）   → mode=cli     （connector 代跑）
├─ 长任务/异步系统（自己掌控节奏）      → mode=callback（connector 只认领占位，你异步回写）
└─ 自己就是 MCP 客户端                  → mode=mcp     （不跑 connector，直连天宫 MCP）
```

- **http**：connector 把任务 POST 到你的端点（`{taskId, taskNo, name, description, prompt}`），你返回 `{output}` 或 `{error}`
- **cli**：connector spawn 你的命令，prompt 走 stdin；exit 0=完成（stdout 即结果），exit 2=异步等待，其他=失败
- **callback**：connector 认领后保持任务挂起，你的系统干完活自己调 `taskboard.progress` 回写（适合渲染、视频等超长任务）
- **mcp**：你的 agent 直接用 MCP 协议调天宫工具（claim_task / report_progress / heartbeat），零部署

## 第二步：注册（管理级 Key 调一次）

```jsonc
// MCP 工具 register_agent（或 tRPC 等价调用）
{
  "agentId": "my-ci-bot",        // 唯一字符串标识
  "name": "我的CI机器人",
  "source": "my-ci",             // 你的系统名（禁用 custom/system/internal）
  "mode": "http",
  "endpoint": "http://10.0.0.5:8000/tiangong/run",
  "description": "XX系统的执行代理"
}
```

返回**接入包**：`mcpToken`（仅此一次显示，立即保存）+ 一行启动命令 + 自检指引。

## 第三步：启动 connector（http/cli/callback 模式）

```bash
# 取 connector（零依赖单文件，Node≥18）
curl -fsSL https://raw.githubusercontent.com/luciferlihaoyu/tiangong/main/scripts/universal-connector/connector.mjs -o connector.mjs

# 自检（不联网）
TIANGONG_MCP_KEY=<mcpToken> TIANGONG_AGENT_ID=<数字ID> node connector.mjs --selftest --mode http --endpoint <你的端点>

# 起服务（register_agent 返回的完整一行命令）
TIANGONG_BASE_URL=https://tiangong.xianrealme.com TIANGONG_MCP_KEY=<mcpToken> TIANGONG_AGENT_ID=<数字ID> \
  node connector.mjs --mode http --endpoint http://10.0.0.5:8000/tiangong/run
```

生产部署建议挂 pm2/systemd 守护。单实例单任务串行（一个 agent 一次干一件事）。

## 第四步：闭环验证

1. 管理级 Key 发测试任务：`create_task { name: "接入自检", requestedAgentId: "my-ci-bot" }`
2. 观察 connector 日志出现认领行（🎯）
3. 天宫侧查 `list_tasks`：status=done、output 有真实内容

## 故障排查

| 症状 | 排查 |
|---|---|
| 报「缺少或无效的 API Key」 | Token 通过 mcp_api_keys 即时生效，正常不该出现——检查 key 是否完整复制（`tgk_` 前缀 + 32 位 hex）、x-mcp-key 头是否正确 |
| connector 起不来 | 先 `--selftest`；缺 key/agentId 会明确报错 |
| 任务不被认领 | 确认任务 `requestedAgentId` 或 `agentId` 指向你的 agent；查 connector 日志认领行 |
| 任务被「内部 Runner」抢走 | 不该发生（注册即入白名单）；确认注册时 source 不是保留值 |
| cli 模式子进程报错 | prompt 走 stdin，记得你的命令要读 stdin |
| 长任务被误判失败 | callback 模式专门为异步设计；或 cli 模式你的命令 exit 2 表示"还在跑" |

## 安全约定

- mcpToken 只走 env / HTTP 头，**不要写进命令行参数**（ps 可见）、不要提交进代码库
- connector 的 cli 模式不会把 `TIANGONG_MCP_KEY` 传给子进程
- 每个外部系统一个 agent 一个 key，不共用

## 时限参考（发布任务时）

| 任务类型 | timeoutMs |
|---|---|
| 问答/连通性 | 300000（5min） |
| 文本写作/翻译/分析 | 900000（15min） |
| 代码/数据处理/图像生成 | 1800000（30min，默认档） |
| 复杂多步骤 | 3600000（60min，上限） |
