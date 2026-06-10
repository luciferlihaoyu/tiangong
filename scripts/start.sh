#!/bin/sh
# 天宫启动脚本
# 数据库 schema 由应用启动时的 autoMigrate + migrateV2 负责。
# 不在这里执行 drizzle-kit push：它可能在 Zeabur 启动阶段阻塞，导致服务长期 STARTING。

set -e

echo "🔧 DATABASE_URL present: $([ -n "$DATABASE_URL" ] && echo 'YES' || echo 'NO')"
echo "🚀 Starting Tiangong server..."
NODE_ENV=production node dist/boot.js
