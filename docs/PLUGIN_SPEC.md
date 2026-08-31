# PLUGIN_SPEC — 天宫 MCP 插件接入规范

> 版本 1.0 · 2026-08-31 · 维护：碧霄
> 依据：alist-mcp / xuanji-mcp 两个生产插件的真实交付经验蒸馏（含三次事故复盘）
> 样例：`luciferlihaoyu/mcp-servers` 仓库 `echo` 分支（最简参照实现，本规范的活文档）

任何新能力，照本规范做成一个 `<域>-mcp` 插件，走完 §8 checklist，即可出现在天宫插件中心，并被任何 MCP 客户端消费。

---

## 1. 命名与元数据

| 项 | 规则 | 例 |
|---|---|---|
| 插件域 | `<域>`，小写字母/数字 | `alist`、`xuanji`、`echo` |
| Zeabur 服务名 | `<域>-mcp` | `alist-mcp` |
| 仓库分支 | `<域>`（分支根目录即部署物） | `alist` 分支 |
| 插件中心 key | `<域>` | `alist` |
| 工具命名 | 动词短语，snake_case | `write_text` |

插件中心元数据（tiangong SQLite `plugins` 表）：`key, name, description, url, token_env_key, enabled`。

## 2. 传输协议契约（MCP over HTTP，无状态 JSON）

**不做 SSE、不建会话**：插件中心探活按 JSON 解析（M1 评审 minor①），无状态 JSON 重启无感、零会话管理。

| 请求 | 响应 |
|---|---|
| `GET /health`（免鉴权） | `200 {"ok":true,"name":"<server-name>"}` |
| `POST /mcp` `initialize` | `200` result: `protocolVersion / capabilities / serverInfo{name,version}` |
| `POST /mcp` `tools/list` | `200` result: `{tools:[{name,description,inputSchema}]}` |
| `POST /mcp` `tools/call` | `200` result: `{content:[{type:"text",text,isError?}]}` |
| 无 `id`（通知） | `202` 空体 |
| 未知方法 | `200` error `-32601` |
| 请求体非法 JSON | `400` error `-32700` |
| 非法 JSON-RPC 结构 | `400` error `-32600` |
| 请求体 > 8MB | `413` |
| 鉴权失败 | `401` error `-32001` |
| 其余路径 | `404` |

**两条铁律（事故复盘 §10-①②）**：

1. `handleRpc` **每个分支必须返回 `{status, body}` 信封**。漏包装 → `JSON.stringify(undefined)` → `Buffer.byteLength` 抛 `ERR_INVALID_ARG_TYPE` → 一律 500。
2. **业务错误 = HTTP 200 + `isError:true` + 中文说明**，绝不 500。500 只留给框架自身缺陷。未知工具回 isError 文本并列出可用工具。

## 3. 鉴权

- 环境变量 `MCP_BEARER_TOKEN`，除 `/health` 外全部请求要求 `Authorization: Bearer <token>` 全等。
- **fail-closed**：env 未配置时拒绝一切请求，绝不放行。
- 比较用定长摘要防时序侧信道：

```js
const expected = createHash("sha256").update(process.env.MCP_BEARER_TOKEN ?? "").digest();
const got = createHash("sha256").update(bearer).digest();
if (expected.length !== got.length || !timingSafeEqual(expected, got)) → 401 -32001
```

- token 生成：`openssl rand -hex 24`；登记工作区 `.secrets/mcp-tokens.yml`（不进 git）。
- **轮换**：生成新 token → 插件 env 更新（自动重部署）→ 天宫 env 更新 → 重启天宫 → 探活验证。全程插件不停机窗口 < 1 分钟。

## 4. 环境变量与端口

```js
// PORT 容错解析（事故复盘 §10-②：Zeabur 会注入 tcp://ip:port 形态）
function resolvePort() {
  const raw = process.env.PORT ?? "";
  if (/^\d+$/.test(raw)) return Number(raw);          // 纯数字
  const m = raw.match(/:(\d+)\s*\/?$/);               // tcp://host:port
  if (m) return Number(m[1]);
  return 3000;                                         // 回退
}
```

| env | 必需 | 说明 |
|---|---|---|
| `MCP_BEARER_TOKEN` | ✅ | 插件自身鉴权（§3） |
| `PORT` | 建议 | 显式钉 `8080`，与服务端口声明一致 |
| `<上游>_URL` / `<上游>_AUTH` 等 | 视业务 | 上游地址与凭据**只走 env**，不进代码不进 git |

## 5. 工程约束

- **零 npm 依赖**，纯 Node 22 ESM（`node:` 内置模块够用：http/crypto/url）。
- 单文件 `server.js`；分支根目录四件套：`server.js` `package.json` `Dockerfile` `README.md`（可加 `test.mjs` 冒烟脚本，不进镜像）。
- Dockerfile 模板（无构建步骤）：

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY server.js package.json ./
ENV NODE_ENV=production
CMD ["node", "server.js"]
```

- `package.json`：`"type":"module"` + `"start":"node server.js"`。

## 6. 部署配方（Zeabur，tiangg-prowal 项目）

1. 代码推到 `mcp-servers` 仓库 `<域>` 分支（根目录四件套）。
2. Zeabur 建服务 `<域>-mcp`（项目内已有占位则复用；否则 CLI `deploy --create` 或面板创建）。
3. 本地打包部署（四步上传协议，脚本 `dsh/方案整合/scripts/zeabur_upload_deploy.py`）：
   `git archive <域> | 打 zip` → `POST /v2/upload`（**Cookie 认证 + 浏览器 UA**）→ S3 presign PUT → `prepare(existing_service)` 自动触发部署。
4. 服务 env：`PORT=8080` + `MCP_BEARER_TOKEN=<token>`（env 变更自动重部署）。
5. 端口声明：HTTP / 8080（`updateServicePorts`）。
6. 等部署 RUNNING → `curl http://<地址>/health`。

**网络事实**：同项目容器互通用内网域名 `http://service-<服务ID>:8080`（K8s Service DNS，比 ClusterIP 稳，重部署不变）；`*.zeabur.app` 自选子域 API 一律拒签（DOMAIN_UNAVAILABLE），公网入口走面板生成域名，非必需。

## 7. 注册配方（天宫插件中心）

```sql
INSERT INTO plugins (key,name,description,url,token_env_key,enabled,created_at,updated_at)
VALUES ('<域>','<中文名>','<一句话>','http://service-<服务ID>:8080/mcp','<域>_MCP_TOKEN',1,unixepoch(),unixepoch());
```

- **URL 必须带 `/mcp` 路径**——探活直接 POST 这个 URL，漏路径会 404 误报 down。
- 天宫容器加 env `<域>_MCP_TOKEN=<token>` → 重启 tiangong 服务。
- 验证：天宫容器内带 Bearer 探 `tools/list` 返回工具清单；插件中心页灯绿。

## 8. 上线验收 checklist（照单走完即上线）

- [ ] 1. `GET /health` → 200 `{"ok":true,...}`
- [ ] 2. 无 token → `401 -32001`；错 token → `401`（fail-closed：unset env 时也 401）
- [ ] 3. `initialize` / `tools/list` 形态正确，工具数与 schema 符合设计
- [ ] 4. `tools/call` 真实回环：成功态 + **业务错误态（200 + isError）** 各验一次
- [ ] 5. 未知工具 → isError + 工具清单；未知方法 → `-32601`；坏 JSON → `400 -32700`
- [ ] 6. 注册后插件中心灯绿；**启停开关生效**（停→list 不再探活/标 unknown，开→复绿）
- [ ] 7. 有上游凭据的插件：上游 401 时工具报业务错误（不 500、不挂死），凭据修复后自恢复
- [ ] 8. README 写明工具清单与 env 表

## 9. 参照实现

| 分支 | 定位 |
|---|---|
| `echo` | **最简样例**——本规范的活文档，新插件从此起步 |
| `alist` | 真实业务插件：AList 网盘文件能力（含上游凭据、重登、中文路径实战） |
| `xuanji` | 真实业务插件：璇玑记忆检索/写入（含 tRPC 上游对接范式） |

## 10. 反面教材（真实事故，防再犯）

1. **tools/call 漏 `{status,body}` 信封** → 所有调用 500（M2 事故，§2 铁律 1）。
2. **PORT 解析 `Number("tcp://...")` = NaN** → 服务启动即崩（M2 事故，§4）。
3. **注册 URL 漏 `/mcp` 路径** → 探活 404 误报 down（§7）。
4. **上游 JSON 列双重编码** → 鉴权链路静默 401/500（璇玑 `api_keys.scopes` 存量事故：drizzle json 列读取 `JSON.parse` 抛错被 context 静默吞掉；tRPC 链 401、无 try/catch 的端点 500）。教训：接上游时对异常鉴权失败先查「上游数据是否干净」，别只查代码。
