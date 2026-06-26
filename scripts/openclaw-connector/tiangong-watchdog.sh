#!/bin/bash
# 天宫 Connector 看门狗 (v2)
# 从 secrets JSON 文件读取 MCP Key，不再硬编码
# 用法: nohup ./tiangong-watchdog.sh >> /var/log/tiangong-watchdog.log 2>&1 &

set -euo pipefail

TIANGONG_DIR="/home/node/.openclaw/workspace-meizhizi/tiangong"
SECRETS_FILE="/home/node/.openclaw/secrets/tiangong-openclaw-agents.json"
LOG_DIR="/var/log"
CONNECTOR_SCRIPT="$TIANGONG_DIR/scripts/openclaw-connector/tiangong-connector.sh"

# 读取 Gateway Token
GATEWAY_TOKEN=""
if [ -f /etc/tiangong-gateway-token ]; then
  GATEWAY_TOKEN=$(cat /etc/tiangong-gateway-token | tr -d '\n')
elif [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN"
fi

if [ -z "$GATEWAY_TOKEN" ]; then
  echo "[$(date)] FATAL: Gateway Token 未设置" >&2
  exit 1
fi

export OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN"

# 从 secrets 文件读取所有 agent 的 name:id:key
mapfile -t AGENTS < <(python3 -c "
import json
with open('$SECRETS_FILE') as f:
    data = json.load(f)
agents = data if isinstance(data, list) else data.get('agents', [])
for a in agents:
    name = a.get('name', a.get('agentName', ''))
    aid = a.get('agentId', a.get('id', 0))
    token = a.get('token', '')
    if name and aid and token:
        print(f'{name}\t{aid}\t{token}')
" 2>/dev/null)

if [ ${#AGENTS[@]} -eq 0 ]; then
  echo "[$(date)] FATAL: 无法从 $SECRETS_FILE 读取 agent 配置" >&2
  exit 1
fi

echo "[$(date)] 看门狗启动，监控 ${#AGENTS[@]} 个 connector"

while true; do
  for line in "${AGENTS[@]}"; do
    IFS=$'\t' read -r name id key <<< "$line"

    if ! pgrep -f "connector.mjs.*--agent-id $id" > /dev/null 2>&1; then
      echo "[$(date)] $name (id=$id) 不在运行，启动中..."
      nohup "$CONNECTOR_SCRIPT" "$name" "$id" "$key" >> "$LOG_DIR/tiangong-connector-$name.log" 2>&1 &
      pid=$!
      echo "[$(date)] $name 已启动 (PID=$pid)"
      sleep 2  # 错开启动避免同时连接
    fi
  done
  sleep 30
done
