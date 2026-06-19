#!/bin/bash
export TIANGONG_OPENCLAW_AGENT_NAME="jingwei"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:jingwei:main"
exec node "/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs"
