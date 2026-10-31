#!/usr/bin/env bash
# 从本机推一版上去。SSH 目标由环境变量给，不写死。
#
#   HUIJIAN_SSH=deploy@example.com bash deploy/push.sh
# 首次运行前需在服务器上单独配置 /etc/huijian/env；本脚本不会传输凭据。
set -euo pipefail

: "${HUIJIAN_SSH:?用 HUIJIAN_SSH=user@host 指定服务器}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rsync -az --delete \
  --exclude '.git' --exclude 'node_modules' --exclude 'tools' \
  "$SRC/" "$HUIJIAN_SSH:/tmp/huijian/"

ssh "$HUIJIAN_SSH" "sudo bash /tmp/huijian/deploy/install.sh"
