#!/bin/bash
# 天宫 Connector 启动器
# 用法: ./tiangong-connector.sh <agent-name> <agent-id> <mcp-key>
#
# MCP Key 硬编码在此脚本中，不会被部署覆盖。
# Gateway Token 从环境变量 OPENCLAW_GATEWAY_TOKEN 读取。

set -euo pipefail

AGENT_NAME="$1"
AGENT_ID="$2"
MCP_KEY="$3"

TIANGONG_DIR="/home/node/.openclaw/workspace-meizhizi/tiangong"
# 从安全文件读取 Gateway Token（优先），其次从环境变量
GATEWAY_TOKEN=""
if [ -f /etc/tiangong-gateway-token ]; then
  GATEWAY_TOKEN=$(cat /etc/tiangong-gateway-token | tr -d '\n')
elif [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
  GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN"
fi

if [ -z "$GATEWAY_TOKEN" ]; then
  echo "ERROR: Gateway Token 未设置（检查 /etc/tiangong-gateway-token 或 OPENCLAW_GATEWAY_TOKEN）" >&2
  exit 1
fi

cd "$TIANGONG_DIR"

# 根据 agent 名称选择 runner 脚本
case "$AGENT_NAME" in
  meizhizi)   RUNNER="runner-meizhizi.sh"; DISPLAY="美智子" ;;
  codemaster) RUNNER="runner-codemaster.sh"; DISPLAY="编程大师" ;;
  houtu)      RUNNER="runner-houtu.sh"; DISPLAY="后土" ;;
  shangguan)  RUNNER="runner-shangguan.sh"; DISPLAY="上官婉儿" ;;
  sumu)       RUNNER="runner-sumu.sh"; DISPLAY="苏木" ;;
  qiongxiao)  RUNNER="runner-qiongxiao.sh"; DISPLAY="琼霄" ;;
  yunxiao)    RUNNER="runner-yunxiao.sh"; DISPLAY="云霄" ;;
  weizi)      RUNNER="runner-weizi.sh"; DISPLAY="薇子" ;;
  meichengzi) RUNNER="runner-meichengzi.sh"; DISPLAY="美成子" ;;
  jingwei)    RUNNER="runner-jingwei.sh"; DISPLAY="精卫" ;;
  xihe)       RUNNER="runner-xihe.sh"; DISPLAY="羲和" ;;
  bixiao)     RUNNER="runner-bixiao.sh"; DISPLAY="碧霄" ;;
  eriyi)      RUNNER="runner-eriyi.sh"; DISPLAY="上衣绘梨衣" ;;
  *)
    echo "ERROR: 未知 agent: $AGENT_NAME" >&2
    exit 1
    ;;
esac

RUNNER_PATH="scripts/openclaw-connector/$RUNNER"

exec node scripts/openclaw-connector/connector.mjs \
  --agent-id "$AGENT_ID" \
  --token "$MCP_KEY" \
  --agent-name "$DISPLAY" \
  --http-base "https://tiangg.zeabur.app" \
  --ws-base "wss://tiangg.zeabur.app" \
  --exec-mode "command" \
  --exec-file "$RUNNER_PATH" \
  --heartbeat 30000 \
  --process-inbox true \
  --claim-tasks true
