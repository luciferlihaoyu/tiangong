#!/bin/bash
# dsh-runner supervisor（天宫容器内常驻）
# 每 60s 检查 runner 进程；不在则拉起。轮询而非 wait 子进程——
# 崩溃/被杀/OOM 都能恢复，且不会与手动启动的 runner 冲突（pgrep 检测）。
#
# 防重复：pgrep 精确匹配 dsh-runner.mjs；已有实例在跑时绝不重复拉起
# （runner 内部单飞标志是进程级的，双实例会重复认领任务）。
#
# 日志：/data/dsh/dsh-runner-supervisor.log（只记 supervisor 事件，
#       runner 自身输出仍进 /data/dsh/dsh-runner-0905.log）

RUNNER="/data/dsh/天宫/tiangong/scripts/connector/dsh-runner.mjs"
RUNNER_LOG="/data/dsh/dsh-runner-0905.log"
SUP_LOG="/data/dsh/dsh-runner-supervisor.log"

# key 不进 git：从容器本地文件读（/data/dsh/.tiangong-dsh-key，chmod 600），
# 缺省时 fallback 环境变量（手动 export 后启动也可）
KEY_FILE="/data/dsh/.tiangong-dsh-key"
if [ -z "$DSH_TIANGONG_KEY" ] && [ -f "$KEY_FILE" ]; then
  DSH_TIANGONG_KEY=$(cat "$KEY_FILE" | tr -d "[:space:]")
fi
export DSH_TIANGONG_KEY
export TIANGONG_HTTP_BASE="${TIANGONG_HTTP_BASE:-https://tiangong.xianrealme.com}"

echo "[supervisor] $(date -Iseconds) 启动，监控 $RUNNER" >> "$SUP_LOG"

while true; do
  if ! pgrep -f "node.*dsh-runner\.mjs" > /dev/null 2>&1; then
    echo "[supervisor] $(date -Iseconds) runner 不在，拉起…" >> "$SUP_LOG"
    setsid node "$RUNNER" >> "$RUNNER_LOG" 2>&1 < /dev/null &
    sleep 5
    if pgrep -f "node.*dsh-runner\.mjs" > /dev/null 2>&1; then
      echo "[supervisor] $(date -Iseconds) 拉起成功" >> "$SUP_LOG"
    else
      echo "[supervisor] $(date -Iseconds) ⚠️ 拉起失败，60s 后重试" >> "$SUP_LOG"
    fi
  fi
  sleep 60
done
