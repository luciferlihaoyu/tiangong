#!/bin/bash
# 天宫一键部署脚本
# 用法: bash deploy.sh [commit message]

set -e

MSG="${1:-deploy: $(date '+%Y-%m-%d %H:%M')}"

echo "🚀 天宫部署中..."
echo ""

# 1. 检查是否有未提交的变更
if [ -n "$(git status --porcelain)" ]; then
  echo "📝 发现未提交变更，自动提交..."
  git add -A
  git commit -m "$MSG"
fi

# 2. 推送到 GitHub（触发 Zeabur 自动部署）
echo "📤 推送到 GitHub..."
git push origin main

echo ""
echo "✅ 已推送，Zeabur 正在自动部署..."
echo "   构建: vite build + esbuild"
echo "   启动: drizzle-kit push (自动同步DB) + node dist/boot.js"
echo ""
echo "🔗 部署状态: https://dash.zeabur.com"
echo "🌐 访问地址: https://tiangg.zeabur.app"
echo "💊 健康检查: https://tiangg.zeabur.app/mcp/health"
