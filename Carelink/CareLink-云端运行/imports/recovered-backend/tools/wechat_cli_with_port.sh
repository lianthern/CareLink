#!/bin/sh
set -eu

wechat_cli=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
if [ "${1:-}" = "--port" ]; then
  wechat_ide_port=$2
  shift 2
  wechat_command=$1
  shift
  exec "$wechat_cli" "$wechat_command" --port "$wechat_ide_port" "$@"
fi
exec "$wechat_cli" "$@"
