#!/bin/bash
# Map Tiangong numeric agent id to OpenClaw agent id, then run runner.mjs.
# Important: connector does not pass TIANGONG_AGENT_ID/TIANGONG_AGENT_NAME into child env;
# start-all-agents.sh sets TIANGONG_OPENCLAW_AGENT_NAME per process, so preserve it.
if [ -z "${TIANGONG_OPENCLAW_AGENT_NAME:-}" ]; then
  case "${TIANGONG_AGENT_ID:-}" in
    1)  export TIANGONG_OPENCLAW_AGENT_NAME="meizhizi" ;;
    2)  export TIANGONG_OPENCLAW_AGENT_NAME="codemaster" ;;
    5)  export TIANGONG_OPENCLAW_AGENT_NAME="meixizi" ;;
    6)  export TIANGONG_OPENCLAW_AGENT_NAME="shangguan" ;;
    7)  export TIANGONG_OPENCLAW_AGENT_NAME="sumu" ;;
    8)  export TIANGONG_OPENCLAW_AGENT_NAME="qiongxiao" ;;
    9)  export TIANGONG_OPENCLAW_AGENT_NAME="yunxiao" ;;
    10) export TIANGONG_OPENCLAW_AGENT_NAME="weizi" ;;
    11) export TIANGONG_OPENCLAW_AGENT_NAME="meichengzi" ;;
    12) export TIANGONG_OPENCLAW_AGENT_NAME="jingwei" ;;
    *)  export TIANGONG_OPENCLAW_AGENT_NAME="${TIANGONG_AGENT_NAME:-}" ;;
  esac
fi
export TIANGONG_OPENCLAW_SESSION_KEY="agent:${TIANGONG_OPENCLAW_AGENT_NAME}:main"
exec node /home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs
