#!/bin/bash
export TIANGONG_OPENCLAW_AGENT_NAME="shangguan"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:shangguan:main"
exec node "/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs"
