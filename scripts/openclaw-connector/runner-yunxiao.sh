#!/bin/bash
export TIANGONG_OPENCLAW_AGENT_NAME="yunxiao"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:yunxiao:main"
exec node "/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs"
