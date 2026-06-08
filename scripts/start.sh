#!/bin/sh
# 天宫启动脚本
# 1. 同步数据库 schema（容错：失败不影响启动）
# 2. 启动服务

echo "🔧 Syncing database schema..."
npx drizzle-kit push 2>&1 || echo "⚠️ db:push failed, continuing..."

echo "🚀 Starting Tiangong server..."
NODE_ENV=production node dist/boot.js
