#!/bin/bash
# 薇子（秘书部主管）Runner - 消息转发 + OpenClaw 执行桥
#
# 启动时：
# 1. 检查 mailbox 收件箱
# 2. 解析后土的分配通知
# 3. 调用 mailbox.send 通知对应助手
#
# 然后：
# 4. 将 stdin prompt 转发给 OpenClaw gateway（通过 runner.mjs）
set -euo pipefail

TIANGONG_DIR="/home/node/.openclaw/workspace-meizhizi/tiangong"
DISPATCH_STRATEGY="$TIANGONG_DIR/scripts/openclaw-connector/lib/dispatch-strategy.mjs"
RUNNER_MJS="$TIANGONG_DIR/scripts/openclaw-connector/runner.mjs"

echo "[Weizi] ═══════════════════════════════════════════"
echo "[Weizi] 薇子秘书消息转发扫描启动..."

# Step 1: 立即执行一次转发扫描
node "$DISPATCH_STRATEGY" weizi

# Step 2: 后台循环每30秒执行转发扫描
(
  while true; do
    sleep 30
    node "$DISPATCH_STRATEGY" weizi || echo "[Weizi] 扫描异常，继续循环..."
  done
) &
echo "[Weizi] 后台扫描循环已启动 (PID=$!)"

echo "[Weizi] ═══════════════════════════════════════════"

# Step 3: 前台启动 runner.mjs 处理 OpenClaw 任务
export TIANGONG_OPENCLAW_AGENT_NAME="weizi"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:weizi:main"
exec node "$RUNNER_MJS"
