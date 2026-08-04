#!/bin/sh

export OPENCODE_WORK_DIR="${OPENCODE_WORK_DIR:-/opt/tiangong-tasks}"
export OPENCODE_TIMEOUT_MS="${OPENCODE_TIMEOUT_MS:-900000}"
export OPENCODE_AUTO="${OPENCODE_AUTO:-true}"

exec node /opt/tiangong/scripts/openclaw-connector/runner-opencode.mjs
