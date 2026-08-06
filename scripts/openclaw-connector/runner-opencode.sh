#!/bin/sh

# Load runner-scoped New API secrets from a git-ignored local env file (if present).
# The runner also loads this file itself as a fallback; sourcing here keeps the
# connector's child process environment complete for any other tooling.
ENV_FILE="$(cd "$(dirname "$0")" && pwd)/.env.local"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

export OPENCODE_WORK_DIR="${OPENCODE_WORK_DIR:-/opt/tiangong-tasks}"
export OPENCODE_TIMEOUT_MS="${OPENCODE_TIMEOUT_MS:-900000}"
export OPENCODE_AUTO="${OPENCODE_AUTO:-true}"

exec node /opt/tiangong/scripts/openclaw-connector/runner-opencode.mjs
