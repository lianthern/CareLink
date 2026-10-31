#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo 'Install Node.js 20.19+ or 24 LTS, then run this script again.'
  exit 1
fi
exec node ./launch-local.cjs
