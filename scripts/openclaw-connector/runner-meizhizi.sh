#!/bin/bash
export TIANGONG_OPENCLAW_AGENT_NAME="meizhizi"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:meizhizi:main"
exec node "/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs"
