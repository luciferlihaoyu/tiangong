#!/bin/bash
export TIANGONG_OPENCLAW_AGENT_NAME="codemaster"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:codemaster:main"
exec node "/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs"
