#!/bin/bash
export TIANGONG_OPENCLAW_AGENT_NAME="sumu"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:sumu:main"
exec node "/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs"
