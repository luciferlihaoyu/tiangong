#!/usr/bin/env bash
# 天宫 OpenClaw Connector 启动脚本 v2
# 为每个 Agent 分配模型路由模板，用 openclaw-agent-runner.mjs 做真实执行
set -euo pipefail

TIANGONG_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$TIANGONG_DIR/scripts/openclaw-connector/examples/openclaw-agent-runner.mjs"
CONNECTOR="$TIANGONG_DIR/scripts/openclaw-connector/connector.mjs"
SECRETS="$HOME/.openclaw/secrets/tiangong-openclaw-agents.json"
RUN_DIR="$HOME/.openclaw/run/tiangong-connectors"
LOG_DIR="$HOME/.openclaw/logs/tiangong-connectors"

HTTP_BASE="${TIANGONG_HTTP_BASE:-https://tiangg.zeabur.app}"
WS_BASE="${TIANGONG_WS_BASE:-wss://tiangg.zeabur.app}"

mkdir -p "$RUN_DIR" "$LOG_DIR"

# Agent: name|agent_id|openclaw_agent|model|thinking
declare -a AGENTS=(
  # 架构管理 → GPT 5.5 High
  "meizhizi|1|meizhizi|4sapi/gpt-5.5-high|medium"
  "houtu|4|meixizi|4sapi/gpt-5.5-high|medium"
  # 代码审查/安全 → Claude Opus 4.8
  "codemaster|2|codemaster|4sapi/claude-opus-4-8|medium"
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
  nohup node "$CONNECTOR" >> "$LOG_FILE" 2>&1 &

  echo $! > "$PID_FILE"
  echo "   pid=$!"
done

echo ""
echo "✅ 全部 connector 已启动（command 模式 + 模型路由）"
