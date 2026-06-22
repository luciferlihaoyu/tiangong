# 天宫 Zeabur 独立部署指南

> 将天宫部署为独立的 Zeabur 项目，使用独立的 MySQL 数据库，避免数据因其他服务重启而丢失。

## 前提

- Zeabur 账号已登录
- GitHub 仓库 `luciferlihaoyu/tiangong` 可访问
- 项目已创建（项目 ID: `6a394808e41f9f1d192fd607`，名称: `tiangg`）

---

## 步骤 1：添加 MySQL 数据库

1. 打开 https://zeabur.com/dashboard
2. 进入 **tiangg** 项目
3. 点击 **「添加服务」**
4. 选择 **「MySQL」** 模板
5. 等待 MySQL 服务启动完成（约 1-2 分钟）
6. 启动后，Zeabur 会自动生成 `DATABASE_URL` 环境变量

## 步骤 2：部署天宫服务

1. 在 tiangg 项目中，再次点击 **「添加服务」**
2. 选择 **「GitHub」** → 连接 `luciferlihaoyu/tiangong` 仓库
3. 选择分支：`main`
4. Zeabur 会自动检测到 `zeabur.json`（配置为 `docker` 构建）
5. 等待构建和部署完成（约 3-5 分钟）

## 步骤 3：配置环境变量

在 tiangg 项目的 **「Environment Variables」** 中，确认以下变量已设置：

| 变量名 | 说明 | 是否自动生成 |
|--------|------|------------|
| `DATABASE_URL` | MySQL 连接字符串 | ✅ MySQL 插件**自动生成并注入**，无需手动填写 |
| `APP_SECRET` | 应用密钥（用于 JWT 等） | ❌ 需要手动设置 |
| `ADMIN_USER` | 管理员用户名 | ❌ 需要手动设置 |
| `ADMIN_PASSWORD` | 管理员密码 | ❌ 需要手动设置 |

> ⚠️ **重要：`DATABASE_URL` 不需要手动填写！**
> Zeabur 的 MySQL 插件会自动生成 `DATABASE_URL` 环境变量并注入到项目中的所有服务。
> 你只需要添加 MySQL 插件，天宫服务就能自动获取到数据库连接。

### 手动设置以下变量：

```
APP_SECRET=tiangong_app_secret_2026
ADMIN_USER=tiangong_admin_4fea85
ADMIN_PASSWORD=TG-4e7…sj7S
```

> 注意：`APP_SECRET` 可以随便填一个随机字符串，用于 JWT 签名。
> `ADMIN_USER` 和 `ADMIN_PASSWORD` 用于访问 `/api/admin/migrate` 等管理端点。

## 步骤 4：配置域名

1. 在 tiangg 项目中，进入天宫服务
2. 点击 **「Domains」**
3. Zeabur 会自动分配一个 `*.zeabur.app` 域名
4. （可选）绑定自定义域名

## 步骤 5：运行数据库迁移

部署完成后，访问以下 URL 触发自动迁移：

```
https://<你的域名>/api/admin/migrate
```

如果提示需要认证，使用上面设置的 `ADMIN_USER` / `ADMIN_PASSWORD`。

迁移成功后，你会看到类似输出：

```
Table users: OK
Table agents: OK
Table tasks: OK
...
Model pricing seeded: 15 inserted, 0 skipped
Auto-migration completed: 22 tables checked
```

## 步骤 6：注册 Agent

迁移完成后，通过 API 注册美智子和编程大师：

```bash
# 注册美智子
curl -X POST https://<你的域名>/api/trpc/agent.create \
  -H "Content-Type: application/json" \
  -d '{"name":"美智子","agentId":"meizhizi","source":"openclaw","status":"idle","system":"openclaw"}'

# 注册编程大师
curl -X POST https://<你的域名>/api/trpc/agent.create \
  -H "Content-Type: application/json" \
  -d '{"name":"编程大师","agentId":"codemaster","source":"openclaw","status":"idle","system":"openclaw"}'
```

## 步骤 7：更新 Connector

天宫部署完成后，需要更新 Connector 的 WebSocket 地址指向新的域名。

在 OpenClaw 环境中，Connector 是通过看门狗 cron 自动管理的。需要更新看门狗任务中的 `--http-base` 和 `--ws-base` 参数。

---

## 验证

部署完成后，访问以下端点确认：

| 端点 | 预期结果 |
|------|---------|
| `https://<域名>/` | 天宫首页（SPA） |
| `https://<域名>/api/trpc/ping` | `{"result":{"data":{"ok":true}}}` |
| `https://<域名>/api/trpc/agent.list` | Agent 列表 |
| `https://<域名>/api/trpc/pricing.list` | 模型定价表（47 个模型） |

## 恢复定价表

迁移后定价表只有 15 个基础模型。需要手动添加其他模型：

在 OpenClaw 中执行以下命令恢复完整定价表：

```bash
# 批量添加模型定价（在 OpenClaw 环境执行）
curl -s -X POST "https://<域名>/api/trpc/pricing.upsert" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","provider":"openai","inputPrice":"0.005","outputPrice":"0.03","cachedInputPrice":"0.0005"}'
# ... 其他模型类似
```

> 完整的 47 个模型定价数据已保存在天宫代码仓库的自动迁移种子数据中。
> 如需全部恢复，请联系美智子执行批量恢复脚本。

---

## 注意事项

1. **不要 force recreate** — 访问 `/api/admin/migrate` 时不要加 `?force=1` 参数，否则会清空数据
2. **数据库持久化** — Zeabur MySQL 插件的数据是持久化的，不会因重新部署而丢失
3. **Connector 需要更新** — 部署新域名后，Connector 需要指向新的 WebSocket 地址
4. **旧域名仍可用** — 旧域名 `tiangg.zeabur.app` 会继续指向旧部署，直到你切换 DNS
