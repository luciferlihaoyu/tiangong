#!/bin/bash
export TIANGONG_OPENCLAW_AGENT_NAME="qiongxiao"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:qiongxiao:main"
exec node "/home/node/.openclaw/workspace-meizhizi/tiangong/scripts/openclaw-connector/runner.mjs"
