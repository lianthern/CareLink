#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if command -v node >/dev/null 2>&1; then
  exec node server/server.js
else
  exec /Users/max/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node server/server.js
fi
