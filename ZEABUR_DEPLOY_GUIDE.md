# 天宫 Zeabur 独立部署指南

> 将天宫部署为独立的 Zeabur 项目，使用独立的 MySQL 数据库，避免数据因其他服务重启而丢失。

## 前提

- Zeabur 账号已登录
- GitHub 仓库 `luciferlihaoyu/tiangong` 可访问
- Zeabur 项目已创建

---

## 步骤 1：添加 MySQL 数据库

1. 打开 https://zeabur.com/dashboard
2. 进入你的项目
3. 点击 **「添加服务」**
4. 选择 **「MySQL」** 模板
5. 等待 MySQL 服务启动完成（约 1-2 分钟）
6. 启动后，Zeabur 会自动生成 `DATABASE_URL` 环境变量

## 步骤 2：部署天宫服务

1. 在项目中，再次点击 **「添加服务」**
2. 选择 **「GitHub」** → 连接 `luciferlihaoyu/tiangong` 仓库
3. 选择分支：`main`
4. Zeabur 会自动检测到 `zeabur.json`（配置为 `docker` 构建）
5. 等待构建和部署完成（约 3-5 分钟）

## 步骤 3：配置环境变量

在项目的 **「Environment Variables」** 中，确认以下变量已设置：

| 变量名 | 说明 | 是否自动生成 |
|--------|------|------------|
| `DATABASE_URL` | MySQL 连接字符串 | ✅ MySQL 插件**自动生成并注入**，无需手动填写 |
| `APP_SECRET` | 应用密钥（用于 JWT 签名） | ❌ 需要手动设置 |
| `ADMIN_USER` | 管理员用户名 | ❌ 需要手动设置 |
| `ADMIN_PASSWORD` | 管理员密码 | ❌ 需要手动设置 |

> ⚠️ **重要：`DATABASE_URL` 不需要手动填写！**
> Zeabur 的 MySQL 插件会自动生成 `DATABASE_URL` 环境变量并注入到项目中的所有服务。
> 你只需要添加 MySQL 插件，天宫服务就能自动获取到数据库连接。

### 手动设置以下变量（示例为占位符，请填入你自己的值）：

```
APP_SECRET=<随机生成的长密钥，可用 openssl rand -hex 32 生成>
ADMIN_USER=<你的管理员用户名>
ADMIN_PASSWORD=<你的强密码，至少 8 位>
```

> 注意：
> - `APP_SECRET` 是 JWT 签名密钥，泄露意味着任何人都能伪造登录态，务必使用高强度随机值并妥善保管。
> - `ADMIN_USER` / `ADMIN_PASSWORD` 为必填项，未配置时服务将拒绝启动。
> - **切勿把真实凭据提交到 git 仓库**（包括文档和 .env.example）。

## 步骤 4：配置域名

1. 在项目中，进入天宫服务
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

迁移完成后，通过 API 注册 Agent，例如：

```bash
curl -X POST https://<你的域名>/api/trpc/agent.create \
  -H "Content-Type: application/json" \
  -d '{"name":"示例Agent","agentId":"example","source":"openclaw","status":"idle","system":"openclaw"}'
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
| `https://<域名>/api/trpc/pricing.list` | 模型定价表 |

---

## 注意事项

1. **不要 force recreate** — 访问 `/api/admin/migrate` 时不要加 `?force=1` 参数，否则会清空数据
2. **数据库持久化** — Zeabur MySQL 插件的数据是持久化的，不会因重新部署而丢失
3. **Connector 需要更新** — 部署新域名后，Connector 需要指向新的 WebSocket 地址
4. **凭据轮换** — 如果 `APP_SECRET` 或管理员密码曾经泄露（例如误提交到公开仓库），请立即在 Zeabur 环境变量中更换并重新部署
