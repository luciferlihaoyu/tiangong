#!/bin/sh
# 天宫启动脚本
# 数据库 schema 由应用启动时的 autoMigrate + migrateV2 负责。
# 不在这里执行 drizzle-kit push：它可能在 Zeabur 启动阶段阻塞，导致服务长期 STARTING。

set -e

echo "========================================"
echo " 天宫 (Tiangong) 启动检查"
echo "========================================"

# 检查关键环境变量
# 数据库（SQLite 化后）：DATABASE_URL 可为
#   a) 本地 SQLite 文件路径（如 data/tiangong.db，推荐，走 /app/data volume 持久化）
#   b) 旧 MySQL DSN（mysql://…，迁移过渡期由 connection.ts 兜底到 /app/data/tiangong.db）
#   c) 未设置（默认 /app/data/tiangong.db）
if [ -z "$DATABASE_URL" ]; then
  echo "✅ DATABASE_URL: 未设置 — 使用默认 SQLite 路径 /app/data/tiangong.db（推荐）"
elif printf '%s' "$DATABASE_URL" | grep -q '^mysql://\|^mysql2://'; then
  echo "⚠️  DATABASE_URL: MySQL DSN（${DATABASE_URL:0:30}...）— 迁移过渡期，将兜底到 /app/data/tiangong.db"
else
  echo "✅ DATABASE_URL: SQLite 文件路径 ${DATABASE_URL}（不存在则启动时创建）"
fi
echo ""
echo "   ⚠️  若使用 SQLite，请确认 zeabur.json 的 /app/data volume 挂载已生效（数据持久化）"

if [ -z "$APP_SECRET" ]; then
  echo "❌ APP_SECRET: NOT SET — 应用将拒绝启动，请在 Zeabur 环境变量中配置"
else
  echo "✅ APP_SECRET: SET"
fi

if [ -z "$ADMIN_USER" ]; then
  echo "❌ ADMIN_USER: NOT SET — 应用将拒绝启动，请在 Zeabur 环境变量中配置"
else
  echo "✅ ADMIN_USER: SET ($ADMIN_USER)"
fi

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "❌ ADMIN_PASSWORD: NOT SET — 应用将拒绝启动，请在 Zeabur 环境变量中配置"
else
  echo "✅ ADMIN_PASSWORD: SET"
fi

echo ""
echo "🚀 Starting Tiangong server..."
NODE_ENV=production node dist/boot.js
