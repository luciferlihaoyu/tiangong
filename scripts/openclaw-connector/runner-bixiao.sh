#!/bin/bash
# 碧霄 — ArkClaw 系统助手
# TODO: 接入 ArkClaw API
export TIANGONG_OPENCLAW_AGENT_NAME="bixiao"
export TIANGONG_OPENCLAW_SESSION_KEY="agent:main"

# 读取 stdin 的任务内容
INPUT=$(cat)
echo "[碧霄] 收到任务，ArkClaw 系统对接待实现"
echo "---"
echo "$INPUT" | head -20
echo "---"
echo "[碧霄] 任务已记录，等待 ArkClaw 接入完成"
