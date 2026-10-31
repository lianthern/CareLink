#!/usr/bin/env bash
# 在服务器上跑一次。幂等：重复跑不会破坏已有状态。
#
# 首次运行前，先以 root:huijian、0640 权限创建 /etc/huijian/env；也可在受控终端中
# 临时传入 MINIMAX_API_KEY。不要把 key 写进命令历史、部署脚本或仓库。
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
if [[ -n "${MINIMAX_API_KEY:-}" ]]; then
  umask 027
  printf 'MINIMAX_API_KEY=%s\n' "$MINIMAX_API_KEY" > "$ENV_DIR/env"
  chown root:huijian "$ENV_DIR/env"
  chmod 640 "$ENV_DIR/env"
  echo "已写入 $ENV_DIR/env"
elif [[ -f "$ENV_DIR/env" ]]; then
  echo "沿用已有 $ENV_DIR/env"
else
  echo "缺 MINIMAX_API_KEY：先 'sudo install -m 640 -o root -g huijian /dev/stdin $ENV_DIR/env' 手动写入再启动"; exit 1
fi

install -m 644 "$SRC/deploy/huijian.service" /etc/systemd/system/huijian.service
systemctl daemon-reload
systemctl enable huijian
systemctl restart huijian
sleep 2
systemctl --no-pager --lines=5 status huijian || true

echo "--- 本机自检 ---"
curl -fsS -o /dev/null -w 'GET /        -> %{http_code}\n' http://127.0.0.1:4611/
curl -fsS -o /dev/null -w 'GET /api/health -> %{http_code}\n' http://127.0.0.1:4611/api/health
curl -fsS -o /dev/null -w 'GET /api/photos -> %{http_code}\n' http://127.0.0.1:4611/api/photos
echo "接下来：把 deploy/Caddyfile.huijian 放进 Caddy 并 reload，再确认 DNS A 记录指向本机。"
