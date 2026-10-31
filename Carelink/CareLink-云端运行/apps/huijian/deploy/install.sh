#!/usr/bin/env bash
# 在服务器上跑一次。幂等：重复跑不会破坏已有状态，也不碰 unseen 的任何东西。
#
#   sudo MINIMAX_API_KEY='...' WORLDLABS_API_KEY='...' bash /tmp/huijian/deploy/install.sh
#
# 只做四件事：建用户、放代码、写 env、装 systemd 单元。Caddy 站点单独 import，见 Caddyfile.huijian。
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST=/opt/huijian
ENV_DIR=/etc/huijian

[[ $EUID -eq 0 ]] || { echo "需要 root"; exit 1; }

if ! command -v node >/dev/null; then
  echo "服务器上没有 node。先装 Node 22+（nodesource 或 nvm），再回来跑这个脚本。"; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || { echo "node 版本 $NODE_MAJOR，需要 22+"; exit 1; }

id -u huijian >/dev/null 2>&1 || useradd --system --home-dir "$DEST" --shell /usr/sbin/nologin huijian

mkdir -p "$DEST"
# 只同步运行需要的东西；tools/ 探针和 .git 不上服务器。
for path in server.mjs package.json lib public photos README.md; do
  rm -rf "${DEST:?}/${path}"
  cp -R "$SRC/$path" "$DEST/$path"
done
chown -R root:root "$DEST"
chmod -R a+rX "$DEST"

mkdir -p "$ENV_DIR"
chmod 750 "$ENV_DIR"
if [[ ! -f "$ENV_DIR/env" && -z "${MINIMAX_API_KEY:-}" ]]; then
  echo "缺 MINIMAX_API_KEY：先 'sudo install -m 640 -o root -g huijian /dev/stdin $ENV_DIR/env' 手动写入再启动"; exit 1
fi

touch "$ENV_DIR/env"
update_env() {
  local key="$1" value="$2" temporary
  [[ -n "$value" ]] || return 0
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || { echo "$key 含非法换行"; exit 1; }
  temporary="$(mktemp "$ENV_DIR/env.XXXXXX")"
  grep -v "^${key}=" "$ENV_DIR/env" > "$temporary" || true
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  install -m 640 -o root -g huijian "$temporary" "$ENV_DIR/env"
  rm -f "$temporary"
}

update_env MINIMAX_API_KEY "${MINIMAX_API_KEY:-}"
update_env MINIMAX_TTS_BASE_URL "${MINIMAX_TTS_BASE_URL:-}"
update_env MINIMAX_TTS_MODEL "${MINIMAX_TTS_MODEL:-}"
update_env MINIMAX_TTS_VOICE_ID "${MINIMAX_TTS_VOICE_ID:-}"
update_env WORLDLABS_API_KEY "${WORLDLABS_API_KEY:-${WLT_API_KEY:-}}"
update_env WORLDLABS_MODEL "${WORLDLABS_MODEL:-}"
update_env WORLDLABS_DAILY_LIMIT "${WORLDLABS_DAILY_LIMIT:-}"
update_env WORLDLABS_VISITOR_DAILY_LIMIT "${WORLDLABS_VISITOR_DAILY_LIMIT:-}"
update_env TTS_COST_WINDOW_MS "${TTS_COST_WINDOW_MS:-}"
update_env TTS_VISITOR_REQUEST_LIMIT "${TTS_VISITOR_REQUEST_LIMIT:-}"
update_env TTS_VISITOR_CHARACTER_LIMIT "${TTS_VISITOR_CHARACTER_LIMIT:-}"
update_env TTS_GLOBAL_REQUEST_LIMIT "${TTS_GLOBAL_REQUEST_LIMIT:-}"
update_env TTS_GLOBAL_CHARACTER_LIMIT "${TTS_GLOBAL_CHARACTER_LIMIT:-}"
chown root:huijian "$ENV_DIR/env"
chmod 640 "$ENV_DIR/env"
echo "已保留并更新 $ENV_DIR/env；未传入的密钥继续沿用"

install -m 644 "$SRC/deploy/unseen-huijian.service" /etc/systemd/system/huijian.service
systemctl daemon-reload
systemctl enable huijian
systemctl restart huijian
sleep 2
systemctl --no-pager --lines=5 status huijian || true

echo "--- 本机自检 ---"
curl -fsS -o /dev/null -w 'GET /        -> %{http_code}\n' http://127.0.0.1:4611/
curl -fsS -o /dev/null -w 'GET /api/health -> %{http_code}\n' http://127.0.0.1:4611/api/health
curl -fsS -o /dev/null -w 'GET /api/photos -> %{http_code}\n' http://127.0.0.1:4611/api/photos
curl -fsS -o /dev/null -w 'GET /world -> %{http_code}\n' http://127.0.0.1:4611/world
curl -fsS -o /dev/null -w 'GET /unseen-demo -> %{http_code}\n' http://127.0.0.1:4611/unseen-demo
curl -fsS -o /dev/null -w 'GET /unseen-dap -> %{http_code}\n' http://127.0.0.1:4611/unseen-dap
curl -fsS -o /dev/null -w 'GET /api/worldlabs/config -> %{http_code}\n' http://127.0.0.1:4611/api/worldlabs/config
echo "接下来：把 deploy/Caddyfile.huijian 放进 Caddy 并 reload，再确认 DNS A 记录指向本机。"
