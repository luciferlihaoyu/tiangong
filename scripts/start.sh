#!/bin/sh
# 天宫启动脚本
# 数据库 schema 由应用启动时的 autoMigrate + migrateV2 负责。
# 不在这里执行 drizzle-kit push：它可能在 Zeabur 启动阶段阻塞，导致服务长期 STARTING。

set -e

echo "========================================"
echo " 天宫 (Tiangong) 启动检查"
echo "========================================"

# 检查关键环境变量
if [ -z "$DATABASE_URL" ]; then
  echo "❌ DATABASE_URL: NOT SET"
  echo ""
  echo "⚠️  数据库连接未配置！"
  echo "   请在 Zeabur 控制台设置以下环境变量："
  echo "   - DATABASE_URL (MySQL 连接串)"
  echo "   - APP_SECRET (JWT 密钥)"
  echo "   - ADMIN_USER (管理员用户名)"
  echo "   - ADMIN_PASSWORD (管理员密码)"
  echo ""
  echo "   或者将 .env 文件放入项目根目录（参考 .env.example）"
  echo ""
  exit 1
else
  echo "✅ DATABASE_URL: SET (${DATABASE_URL:0:30}...)"
fi

if [ -z "$APP_SECRET" ]; then
  echo "⚠️  APP_SECRET: NOT SET (使用默认值，不安全)"
else
  echo "✅ APP_SECRET: SET"
fi

if [ -z "$ADMIN_USER" ]; then
  echo "⚠️  ADMIN_USER: NOT SET (使用默认值 admin)"
else
  echo "✅ ADMIN_USER: SET ($ADMIN_USER)"
fi

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "⚠️  ADMIN_PASSWORD: NOT SET (使用默认值，不安全)"
else
  echo "✅ ADMIN_PASSWORD: SET"
fi

echo ""
echo "🚀 Starting Tiangong server..."
NODE_ENV=production node dist/boot.js
