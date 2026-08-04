#!/bin/sh

set -eu

if [ -z "${TIANGONG_OPENCODE_MCP_KEY:-}" ]; then
  echo "ERROR: TIANGONG_OPENCODE_MCP_KEY is required" >&2
  exit 1
fi

export TIANGONG_EXEC_TIMEOUT_MS=900000

cd /opt/tiangong
exec node scripts/openclaw-connector/connector.mjs \
  --agent-id 16 \
  --token "$TIANGONG_OPENCODE_MCP_KEY" \
  --agent-name "OpenCode" \
  --http-base "https://tiangg.zeabur.app" \
  --ws-base "wss://tiangg.zeabur.app" \
  --exec-mode command \
  --exec-file scripts/openclaw-connector/runner-opencode.sh \
  --heartbeat 30000 \
  --process-inbox true \
  --claim-tasks true
