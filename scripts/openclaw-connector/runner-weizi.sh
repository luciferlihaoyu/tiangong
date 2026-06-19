#!/bin/bash
export TIANGONG_OPENCLAW_AGENT_NAME="weizi"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:weizi:main"
exec node "/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs"
