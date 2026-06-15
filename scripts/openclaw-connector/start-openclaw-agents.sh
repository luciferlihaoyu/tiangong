#!/usr/bin/env bash
# 天宫 OpenClaw Connector 启动脚本 v2
# 为每个 Agent 分配模型路由模板，用 openclaw-agent-runner.mjs 做真实执行
#
# P9.1 成本守卫：默认不自动认领执行任务（仅心跳+inbox="true"在线），
# 自动执行需显式设置 TIANGONG_CLAIM_TASKS=true。
# 重复/低优先级任务强制使用低成本模型，昂贵模型仅限手动高优先任务。
set -euo pipefail

TIANGONG_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$TIANGONG_DIR/scripts/openclaw-connector/examples/openclaw-agent-runner.mjs"
CONNECTOR="$TIANGONG_DIR/scripts/openclaw-connector/connector.mjs"
SECRETS="$HOME/.openclaw/secrets/tiangong-openclaw-agents.json"
RUN_DIR="$HOME/.openclaw/run/tiangong-connectors"
LOG_DIR="$HOME/.openclaw/logs/tiangong-connectors"

HTTP_BASE="${TIANGONG_HTTP_BASE:-https://tiangg.zeabur.app}"
WS_BASE="${TIANGONG_WS_BASE:-wss://tiangg.zeabur.app}"

# ─── P9.1 Cost Guard defaults ───
# 安全默认：不自动认领执行任务，仅维持心跳 + inbox 在线
TIANGONG_PROCESS_INBOX="${TIANGONG_PROCESS_INBOX:-true}"
TIANGONG_CLAIM_TASKS="${TIANGONG_CLAIM_TASKS:-false}"
TIANGONG_CHEAP_MODEL="${TIANGONG_CHEAP_MODEL:-deepseek-official/deepseek-v4-flash}"
TIANGONG_CHEAP_MODEL_OPS="${TIANGONG_CHEAP_MODEL_OPS:-minimax-cn/MiniMax-M3}"
TIANGONG_ALLOW_EXPENSIVE_RECURRING="${TIANGONG_ALLOW_EXPENSIVE_RECURRING:-false}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

# Agent: name|agent_id|openclaw_agent|model|thinking
declare -a AGENTS=(
  # 架构管理 → Claude Opus 4.8 / DeepSeek V4 Pro
  "meizhizi|1|meizhizi|4sapi/claude-opus-4-8|medium"
  "houtu|4|meixizi|deepseek-official/deepseek-v4-pro|medium"
  # 安全审查 → Claude Opus 4.8
  "codemaster|2|codemaster|deepseek-official/deepseek-v4-pro|medium"
  # 中文运营 → MiniMax M3
  "shangguan|3|shangguan|minimax-cn/MiniMax-M3|off"
  # 日常轻度 → DeepSeek Flash
  "eriyi|5|sumu|deepseek-official/deepseek-v4-flash|off"
  "meichengzi|6|meichengzi|deepseek-official/deepseek-v4-flash|off"
  "jingwei|12|jingwei|deepseek-official/deepseek-v4-flash|off"
  "yunxiao|13|main|deepseek-official/deepseek-v4-flash|off"
  "weizi|14|weizi|deepseek-official/deepseek-v4-flash|off"
)

for entry in "${AGENTS[@]}"; do
  IFS='|' read -r NAME AGENT_ID OC_AGENT MODEL THINKING <<< "$entry"

  TOKEN=$(python3 -c "import json; d=json.load(open('$SECRETS')); a=next((x for x in (d.get('agents',d)) if x['name']=='$NAME'),None); print(a['token'] if a else '')" 2>/dev/null)

  if [[ -z "$TOKEN" ]]; then
    echo "❌ 找不到 $NAME 的 token"
    continue
  fi

  LOG_FILE="$LOG_DIR/$NAME.log"
  PID_FILE="$RUN_DIR/$NAME.pid"

  if [[ -f "$PID_FILE" ]]; then
    OLD_PID=$(cat "$PID_FILE")
    kill "$OLD_PID" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi

  echo "▶️  启动 $NAME (#$AGENT_ID) → $OC_AGENT @ $MODEL"

  TIANGONG_AGENT_ID="$AGENT_ID" \
  TIANGONG_MCP_KEY="$TOKEN" \
  TIANGONG_AGENT_NAME="$NAME" \
  TIANGONG_HTTP_BASE="$HTTP_BASE" \
  TIANGONG_WS_BASE="$WS_BASE" \
  TIANGONG_EXEC_MODE="command" \
  TIANGONG_EXEC_FILE="$RUNNER" \
  TIANGONG_EXEC_ARGS_JSON="[\"--agent\",\"$OC_AGENT\",\"--model\",\"$MODEL\",\"--thinking\",\"$THINKING\",\"--timeout\",\"300\"]" \
  TIANGONG_PROCESS_INBOX="$TIANGONG_PROCESS_INBOX" \
  TIANGONG_CLAIM_TASKS="$TIANGONG_CLAIM_TASKS" \
  TIANGONG_CHEAP_MODEL="$TIANGONG_CHEAP_MODEL" \
  TIANGONG_CHEAP_MODEL_OPS="$TIANGONG_CHEAP_MODEL_OPS" \
  TIANGONG_ALLOW_EXPENSIVE_RECURRING="$TIANGONG_ALLOW_EXPENSIVE_RECURRING" \
  nohup node "$CONNECTOR" >> "$LOG_FILE" 2>&1 &

  echo $! > "$PID_FILE"
  echo "   pid=$!"
done

echo ""
echo "✅ 全部 connector 已启动（command 模式 + 模型路由）"
echo "   P9.1 成本守卫: process_inbox=$TIANGONG_PROCESS_INBOX claim_tasks=$TIANGONG_CLAIM_TASKS"
echo "   默认不会自动认领/执行任务，需 TIANGONG_CLAIM_TASKS=true 显式启用"
