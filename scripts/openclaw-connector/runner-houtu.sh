#!/bin/bash
export TIANGONG_OPENCLAW_AGENT_NAME="meixizi"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:meixizi:main"
exec node "/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs"
