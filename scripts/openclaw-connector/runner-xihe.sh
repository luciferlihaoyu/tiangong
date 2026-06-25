#!/bin/bash
# 羲和 — Hermes Agent 系统助手
# TODO: 接入 Hermes Agent API
export TIANGONG_OPENCLAW_AGENT_NAME="xihe"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:main"

# 读取 stdin 的任务内容
INPUT=$(cat)
echo "[羲和] 收到任务，Hermes Agent 系统对接待实现"
echo "---"
echo "$INPUT" | head -20
echo "---"
echo "[羲和] 任务已记录，等待 Hermes Agent 接入完成"
