#!/bin/bash
# 后土（CEO）Runner - 任务分发 + OpenClaw 执行桥
#
# 启动时：
# 1. 扫描所有 status=queued 的任务
# 2. 根据关键词匹配最合适的助手
# 3. 调用 task.update 分配任务
# 4. 调用 mailbox.send 通知薇子
#
# 然后：
# 5. 将 stdin prompt 转发给 OpenClaw gateway（通过 runner.mjs）
set -euo pipefail

TIANGONG_DIR="/home/node/.openclaw/workspace-meizhizi/tiangong"
DISPATCH_STRATEGY="$TIANGONG_DIR/scripts/openclaw-connector/lib/dispatch-strategy.mjs"
RUNNER_MJS="$TIANGONG_DIR/scripts/openclaw-connector/runner.mjs"

echo "[Houtu] ═══════════════════════════════════════════"
echo "[Houtu] 后土 CEO 任务分发扫描启动..."

# Step 1: 立即执行一次分配扫描
node "$DISPATCH_STRATEGY" houtu

# Step 2: 后台循环每30秒执行扫描
(
  while true; do
    sleep 30
    node "$DISPATCH_STRATEGY" houtu || echo "[Houtu] 扫描异常，继续循环..."
  done
) &
echo "[Houtu] 后台扫描循环已启动 (PID=$!)"

echo "[Houtu] ═══════════════════════════════════════════"

# Step 3: 前台启动 runner.mjs 处理 OpenClaw 任务
export TIANGONG_OPENCLAW_AGENT_NAME="meixizi"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:meixizi:main"
exec node "$RUNNER_MJS"
