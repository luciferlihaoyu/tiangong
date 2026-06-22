#!/bin/bash
# 天宫 Connector 看门狗
# 确保所有 connector 进程都在运行，如果挂了自动重启
# 用法: nohup ./tiangong-watchdog.sh &

set -euo pipefail

CONNECTORS=(
  "meizhizi:1:tg-1-8…RM6l"
  "codemaster:2:tg-2-C…Y9Tt"
)

TIANGONG_DIR="/home/node/.openclaw/workspace-meizhizi/tiangong"
CONNECTOR_SCRIPT="$TIANGONG_DIR/scripts/openclaw-connector/tiangong-connector.sh"
LOG_DIR="/var/log"

# 读取 gateway token
GATEWAY_TOKEN=""
if [ -f /etc/tiangong-gateway-token ]; then
  GATEWAY_TOKEN=$(cat /etc/tiangong-gateway-token | tr -d '\n')
fi
export OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN"

start_connector() {
  local name="$1"
  local id="$2"
  local key="$3"
  local logfile="$LOG_DIR/tiangong-connector-$name.log"
  
  nohup "$CONNECTOR_SCRIPT" "$name" "$id" "$key" >> "$logfile" 2>&1 &
  echo "$!"
}

while true; do
  for entry in "${CONNECTORS[@]}"; do
    IFS=':' read -r name id key <<< "$entry"
    
    # 检查进程是否在运行
    if ! pgrep -f "connector.mjs.*--agent-id $id" > /dev/null 2>&1; then
      echo "[$(date)] $name (id=$id) 不在运行，启动中..." >> "$LOG_DIR/tiangong-watchdog.log"
      pid=$(start_connector "$name" "$id" "$key")
      echo "[$(date)] $name 已启动 (PID=$pid)" >> "$LOG_DIR/tiangong-watchdog.log"
    fi
  done
  sleep 30
done
