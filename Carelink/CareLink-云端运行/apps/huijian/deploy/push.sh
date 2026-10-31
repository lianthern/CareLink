#!/usr/bin/env bash
# 从本机推一版上去。SSH 目标由环境变量给，不写死。
#
#   HUIJIAN_SSH=root@43.132.167.200 bash deploy/push.sh
#   HUIJIAN_SSH=root@43.132.167.200 MINIMAX_API_KEY="$(...)" WORLDLABS_API_KEY="$(...)" bash deploy/push.sh
#   HUIJIAN_SSH=ubuntu@43.132.167.200 HUIJIAN_SSH_KEY="$HOME/.ssh/huijian_deploy" bash deploy/push.sh
set -euo pipefail

: "${HUIJIAN_SSH:?用 HUIJIAN_SSH=user@host 指定服务器}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_STAGE="${HUIJIAN_REMOTE_STAGE:-/tmp/huijian-deploy}"
SSH_ARGS=()
RSYNC_RSH="ssh"
if [[ -n "${HUIJIAN_SSH_KEY:-}" ]]; then
  [[ -f "$HUIJIAN_SSH_KEY" ]] || { echo "HUIJIAN_SSH_KEY 不存在"; exit 1; }
  [[ "$HUIJIAN_SSH_KEY" != *"'"* && "$HUIJIAN_SSH_KEY" != *$'\n'* && "$HUIJIAN_SSH_KEY" != *$'\r'* ]] || {
    echo "HUIJIAN_SSH_KEY 路径含不支持的引号或换行"; exit 1;
  }
  SSH_ARGS=(-i "$HUIJIAN_SSH_KEY" -o IdentitiesOnly=yes)
  RSYNC_RSH="ssh -i '$HUIJIAN_SSH_KEY' -o IdentitiesOnly=yes"
fi

rsync -az --delete -e "$RSYNC_RSH" \
  --rsync-path="mkdir -p '$REMOTE_STAGE' && rsync" \
  "$SRC/server.mjs" "$SRC/package.json" "$SRC/lib" "$SRC/public" \
  "$SRC/photos" "$SRC/README.md" "$SRC/deploy" \
  "$HUIJIAN_SSH:$REMOTE_STAGE/"

# shellcheck disable=SC2029
printf -v minimax_key_q '%q' "${MINIMAX_API_KEY:-}"
printf -v minimax_tts_base_q '%q' "${MINIMAX_TTS_BASE_URL:-}"
printf -v minimax_tts_model_q '%q' "${MINIMAX_TTS_MODEL:-}"
printf -v minimax_tts_voice_q '%q' "${MINIMAX_TTS_VOICE_ID:-}"
printf -v worldlabs_key_q '%q' "${WORLDLABS_API_KEY:-${WLT_API_KEY:-}}"
printf -v worldlabs_model_q '%q' "${WORLDLABS_MODEL:-}"
printf -v worldlabs_daily_q '%q' "${WORLDLABS_DAILY_LIMIT:-}"
printf -v worldlabs_visitor_q '%q' "${WORLDLABS_VISITOR_DAILY_LIMIT:-}"
printf -v tts_window_q '%q' "${TTS_COST_WINDOW_MS:-}"
printf -v tts_visitor_requests_q '%q' "${TTS_VISITOR_REQUEST_LIMIT:-}"
printf -v tts_visitor_characters_q '%q' "${TTS_VISITOR_CHARACTER_LIMIT:-}"
printf -v tts_global_requests_q '%q' "${TTS_GLOBAL_REQUEST_LIMIT:-}"
printf -v tts_global_characters_q '%q' "${TTS_GLOBAL_CHARACTER_LIMIT:-}"
ssh "${SSH_ARGS[@]}" "$HUIJIAN_SSH" "sudo env MINIMAX_API_KEY=$minimax_key_q MINIMAX_TTS_BASE_URL=$minimax_tts_base_q MINIMAX_TTS_MODEL=$minimax_tts_model_q MINIMAX_TTS_VOICE_ID=$minimax_tts_voice_q WORLDLABS_API_KEY=$worldlabs_key_q WORLDLABS_MODEL=$worldlabs_model_q WORLDLABS_DAILY_LIMIT=$worldlabs_daily_q WORLDLABS_VISITOR_DAILY_LIMIT=$worldlabs_visitor_q TTS_COST_WINDOW_MS=$tts_window_q TTS_VISITOR_REQUEST_LIMIT=$tts_visitor_requests_q TTS_VISITOR_CHARACTER_LIMIT=$tts_visitor_characters_q TTS_GLOBAL_REQUEST_LIMIT=$tts_global_requests_q TTS_GLOBAL_CHARACTER_LIMIT=$tts_global_characters_q bash '$REMOTE_STAGE/deploy/install.sh'"
