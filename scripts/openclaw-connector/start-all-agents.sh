#!/bin/bash
# 启动所有天宫助手连接 - 真实模式
# 每个助手启动一个独立的 connector 进程，command 模式

set -e

CONNECTOR_DIR="/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector"
CONFIG="$CONNECTOR_DIR/agents.json"
LOG_DIR="/home/node/.openclaw/workspace-meizhizi/logs/tiangong"
HTTP_BASE="https://tiangg.zeabur.app"
WS_BASE="wss://tiangg.zeabur.app"

mkdir -p "$LOG_DIR"

AGENTS=("meizhizi" "codemaster" "houtu" "shangguan" "sumu" "qiongxiao" "yunxiao" "weizi" "meichengzi" "jingwei")

echo "🚀 启动天宫助手真实连接..."
echo ""

for agent in "${AGENTS[@]}"; do
  LOG_FILE="$LOG_DIR/connector-$agent.log"
  PID_FILE="/tmp/tiangong-$agent.pid"
  
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
      echo "⏭️  $agent 已在运行 (PID $OLD_PID)"
      continue
    fi
  fi
  
  echo "▶️  启动 $agent (command mode)..."
  
  TIANGONG_OPENCLAW_AGENT_NAME="$agent" nohup node "$CONNECTOR_DIR/connector.mjs" \
    --config "$CONFIG" \
    --agent-name "$agent" \
    --http-base "$HTTP_BASE" \
    --ws-base "$WS_BASE" \
    --heartbeat 30000 \
    --process-inbox true \
    --claim-tasks true \
    >> "$LOG_FILE" 2>&1 &
  
  PID=$!
  echo $PID > "$PID_FILE"
  echo "   PID: $PID"
  sleep 1
done

echo ""
echo "✅ 所有助手启动完成"
echo "   日志目录: $LOG_DIR"
echo ""
echo "查看状态:"
echo "  ps aux | grep connector.mjs"
echo "查看日志:"
echo "  tail -f $LOG_DIR/connector-<agent>.log"
