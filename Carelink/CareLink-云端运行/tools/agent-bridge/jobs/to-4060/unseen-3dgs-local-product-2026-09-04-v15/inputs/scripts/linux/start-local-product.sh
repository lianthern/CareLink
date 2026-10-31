#!/usr/bin/env bash
set -euo pipefail

if [[ -d /usr/lib/wsl/lib ]]; then
  export PATH="/usr/lib/wsl/lib:$PATH"
fi

install_root="/home/max/src/unseen-local-product"
data_root="/home/max/unseen-local-product"
port="8780"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) install_root="${2:?missing value}"; shift 2 ;;
    --data-root) data_root="${2:?missing value}"; shift 2 ;;
    --port) port="${2:?missing value}"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done
command -v realpath >/dev/null 2>&1 || { printf 'realpath is required.\n' >&2; exit 1; }
install_root=$(realpath -m -- "$install_root")
data_root=$(realpath -m -- "$data_root")
case "$install_root" in /home/*) ;; *) printf 'Install root must resolve to WSL ext4 under /home.\n' >&2; exit 2 ;; esac
case "$data_root" in /home/*) ;; *) printf 'Data root must resolve to WSL ext4 under /home.\n' >&2; exit 2 ;; esac
if [[ ! "$port" =~ ^[0-9]+$ ]] || (( 10#$port < 1 || 10#$port > 65535 )); then
  printf 'Port must be an integer from 1 to 65535.\n' >&2
  exit 2
fi
app="$install_root/app/unseen_local_product.py"; runner="$install_root/app/pipeline_runner.py"
[[ -f "$app" && ! -L "$app" && -f "$runner" && ! -L "$runner" ]] || {
  printf 'Product scripts are missing or are symlinks. Re-run the verified installer first.\n' >&2
  exit 2
}
command -v sha256sum >/dev/null 2>&1 || { printf 'sha256sum is required to bind live processes to installed code.\n' >&2; exit 1; }
app_sha256=$(sha256sum -- "$app" | awk '{print $1}')
runner_sha256=$(sha256sum -- "$runner" | awk '{print $1}')
[[ "$app_sha256" =~ ^[0-9a-f]{64}$ && "$runner_sha256" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Could not fingerprint the installed product scripts.\n' >&2
  exit 1
}

poc_root="/home/max/src/unseen-3dgs-sceneworker"
if [[ -x "$install_root/.venv/bin/python3" ]]; then
  runtime_python="$install_root/.venv/bin/python3"
  export PATH="$install_root/.venv/bin:$PATH"
elif [[ -x "$poc_root/.venv/bin/python3" ]]; then
  runtime_python="$poc_root/.venv/bin/python3"
  export PATH="$poc_root/.venv/bin:$PATH"
else
  printf 'No usable local Python environment. Run %s/app/bootstrap-dependencies.sh --confirm-system-packages first.\n' "$install_root" >&2
  exit 1
fi
if [[ -x "$install_root/.tools/node/bin/node" ]]; then
  export PATH="$install_root/.tools/node/bin:$PATH"
elif [[ -x "$poc_root/.tools/node/bin/node" ]]; then
  export PATH="$poc_root/.tools/node/bin:$PATH"
fi
if [[ -x "$install_root/tools/splat-transform/node_modules/.bin/splat-transform" ]]; then
  export PATH="$install_root/tools/splat-transform/node_modules/.bin:$PATH"
elif [[ -x "$poc_root/tools/splat-transform/node_modules/.bin/splat-transform" ]]; then
  export PATH="$poc_root/tools/splat-transform/node_modules/.bin:$PATH"
fi
export PYTHONNOUSERSITE=1
export PYTHONDONTWRITEBYTECODE=1

if [[ -z "${UNSEEN_VIEWER_SOURCE:-}" ]]; then
  if [[ -f "$install_root/viewer/app.js" && -f "$install_root/viewer/vendor/playcanvas.min.mjs" ]]; then
    export UNSEEN_VIEWER_SOURCE="$install_root/viewer"
  elif [[ -f "$poc_root/viewer/app.js" && -f "$poc_root/viewer/vendor/playcanvas.min.mjs" ]]; then
    export UNSEEN_VIEWER_SOURCE="$poc_root/viewer"
  else
    printf 'Viewer source is missing. Re-run the offline installer before starting.\n' >&2
    exit 1
  fi
fi
mkdir -p "$data_root/reports"; chmod 700 "$data_root"

recorded_product_pid() {
  local pid_file="$1" role="$2" pid="" command_line=""
  [[ -f "$pid_file" ]] || return 1
  pid=$(cat "$pid_file")
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  command_line=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  [[ "$command_line" == *"unseen_local_product.py"* && "$command_line" == *" $role "* ]]
}

current_install_process_pid() {
  local pid_file="$1" role="$2" pid="" command_line=""
  recorded_product_pid "$pid_file" "$role" || return 1
  pid=$(cat "$pid_file")
  command_line=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  [[ "$command_line" == *"$app"* ]]
}

state_matches_current_code() {
  local pid_file="$1" state_file="$2" role="$3" pid=""
  [[ -f "$pid_file" && -f "$state_file" ]] || return 1
  pid=$(cat "$pid_file")
  "$runtime_python" - "$state_file" "$pid" "$role" "$app_sha256" "$runner_sha256" <<'PY' >/dev/null 2>&1
import json
import sys

state = json.load(open(sys.argv[1], encoding="utf-8"))
pid = int(sys.argv[2])
role = sys.argv[3]
assert type(state.get("pid")) is int and state["pid"] == pid
assert type(state.get("appSha256")) is str and state["appSha256"] == sys.argv[4]
if role == "worker":
    assert type(state.get("runnerSha256")) is str and state["runnerSha256"] == sys.argv[5]
    assert state.get("alive") is True
    assert state.get("state") in {"idle", "running"}
PY
}

reusable_pid() {
  local pid_file="$1" state_file="$2" role="$3"
  current_install_process_pid "$pid_file" "$role" && state_matches_current_code "$pid_file" "$state_file" "$role"
}

server_health_matches_current_code() {
  local pid="$1"
  "$runtime_python" - "$data_root/reports/server-state.json" "$port" "$pid" "$app_sha256" <<'PY' >/dev/null 2>&1
import json
import sys
import urllib.request

state = json.load(open(sys.argv[1], encoding="utf-8"))
expected_url = f"http://127.0.0.1:{sys.argv[2]}/"
assert state["url"] == expected_url
assert type(state.get("pid")) is int and state["pid"] == int(sys.argv[3])
assert type(state.get("appSha256")) is str and state["appSha256"] == sys.argv[4]
with urllib.request.urlopen(expected_url + "api/health", timeout=2) as response:
    assert response.status == 200
    health = json.load(response)
server = health["server"]
assert type(server.get("pid")) is int and server["pid"] == int(sys.argv[3])
assert type(server.get("appSha256")) is str and server["appSha256"] == sys.argv[4]
PY
}

server_pid_file="$data_root/reports/server.pid"
worker_pid_file="$data_root/reports/worker.pid"
server_state_file="$data_root/reports/server-state.json"
worker_state_file="$data_root/reports/worker-state.json"

# A process at the expected path is reusable only when its launch-time state
# binds the exact bytes now installed. If either owned process is mixed-version
# (or a live server cannot prove the same SHA through /api/health), stop both
# product roles before restarting. stop-local-product.sh preserves every data
# directory and waits for the worker supervisor to clean its runner group.
restart_required=false
if recorded_product_pid "$server_pid_file" server; then
  server_pid=$(cat "$server_pid_file")
  if ! reusable_pid "$server_pid_file" "$server_state_file" server || \
     ! server_health_matches_current_code "$server_pid"; then
    restart_required=true
  fi
fi
if recorded_product_pid "$worker_pid_file" worker && \
   ! reusable_pid "$worker_pid_file" "$worker_state_file" worker; then
  restart_required=true
fi
if [[ "$restart_required" == true ]]; then
  stop_script="$install_root/app/stop-local-product.sh"
  [[ -x "$stop_script" ]] || {
    printf 'Mixed-version product process found, but the trusted stop script is missing. No replacement was started.\n' >&2
    exit 1
  }
  "$stop_script" "$data_root" || {
    printf 'Mixed-version product process could not be stopped safely. No replacement was started.\n' >&2
    exit 1
  }
  printf 'Stopped mixed-version local processes; queue, media and checkpoints were preserved.\n'
fi

if reusable_pid "$server_pid_file" "$server_state_file" server; then
  server_pid=$(cat "$server_pid_file")
  printf 'Server already running with current app SHA256: PID %s\n' "$server_pid"
else
  rm -f "$server_pid_file" "$server_state_file"
  nohup "$runtime_python" "$app" --root "$data_root" server --host 127.0.0.1 --port "$port" >"$data_root/reports/server.log" 2>&1 &
  server_pid=$!; printf '%s\n' "$server_pid" > "$server_pid_file"
fi
if reusable_pid "$worker_pid_file" "$worker_state_file" worker; then
  worker_pid=$(cat "$worker_pid_file")
  printf 'GPU worker already running with current app/runner SHA256: PID %s\n' "$worker_pid"
else
  rm -f "$worker_pid_file" "$worker_state_file"
  nohup "$runtime_python" "$app" --root "$data_root" worker --runner "$runner" --lease-ttl 180 --poll-seconds 5 >"$data_root/reports/worker.log" 2>&1 &
  worker_pid=$!; printf '%s\n' "$worker_pid" > "$worker_pid_file"
fi
for _attempt in $(seq 1 40); do
  if [[ -f "$server_state_file" ]] && "$runtime_python" - "$server_state_file" "$port" "$server_pid" "$app_sha256" <<'PY' >/dev/null 2>&1
import json,sys,urllib.request
state=json.load(open(sys.argv[1],encoding="utf-8"))
assert state["url"] == f"http://127.0.0.1:{sys.argv[2]}/"
assert type(state.get("pid")) is int and state["pid"] == int(sys.argv[3])
assert type(state.get("appSha256")) is str and state["appSha256"] == sys.argv[4]
with urllib.request.urlopen(state["url"]+"api/health",timeout=.5) as response:
    assert response.status == 200
    health=json.load(response)
assert type(health["server"].get("pid")) is int and health["server"]["pid"] == int(sys.argv[3])
assert type(health["server"].get("appSha256")) is str and health["server"]["appSha256"] == sys.argv[4]
PY
  then break; fi
  sleep 0.25
done
if ! kill -0 "$server_pid" 2>/dev/null || ! kill -0 "$worker_pid" 2>/dev/null; then
  printf 'Startup failed. Inspect %s/reports/*.log\n' "$data_root" >&2; exit 1
fi
if ! "$runtime_python" - "$server_state_file" "$port" "$server_pid" "$app_sha256" <<'PY' >/dev/null 2>&1
import json,sys,urllib.request
state=json.load(open(sys.argv[1],encoding="utf-8")); url=state["url"]
assert url == f"http://127.0.0.1:{sys.argv[2]}/"
assert type(state.get("pid")) is int and state["pid"] == int(sys.argv[3])
assert type(state.get("appSha256")) is str and state["appSha256"] == sys.argv[4]
with urllib.request.urlopen(url+"api/health",timeout=2) as response:
    assert response.status == 200
    health=json.load(response)
assert type(health["server"].get("pid")) is int and health["server"]["pid"] == int(sys.argv[3])
assert type(health["server"].get("appSha256")) is str and health["server"]["appSha256"] == sys.argv[4]
PY
then
  printf 'Server process exists but health check failed. Inspect %s/reports/server.log\n' "$data_root" >&2
  exit 1
fi
worker_ready=false
for _attempt in $(seq 1 60); do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    break
  fi
  if "$runtime_python" - "$server_state_file" "$port" "$worker_pid" "$app_sha256" "$runner_sha256" <<'PY' >/dev/null 2>&1
import json
import sys
import urllib.request

url = json.load(open(sys.argv[1], encoding="utf-8"))["url"]
assert url == f"http://127.0.0.1:{sys.argv[2]}/"
with urllib.request.urlopen(url + "api/status", timeout=1) as response:
    assert response.status == 200
    status = json.load(response)
worker = status["worker"]
assert worker["alive"] is True
assert worker["state"] in {"idle", "running"}
assert int(worker["pid"]) == int(sys.argv[3])
assert type(worker.get("appSha256")) is str and worker["appSha256"] == sys.argv[4]
assert type(worker.get("runnerSha256")) is str and worker["runnerSha256"] == sys.argv[5]
assert isinstance(worker.get("owner"), str) and worker["owner"]
assert float(worker["heartbeatAgeSeconds"]) <= max(30.0, 3.0 * float(worker.get("pollSeconds", 5)))
PY
  then
    worker_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$worker_ready" != true ]]; then
  printf 'Worker did not become healthy (alive idle/running state, matching PID and fresh heartbeat).\n' >&2
  printf 'Local server log (last 80 lines):\n' >&2
  tail -n 80 "$data_root/reports/server.log" 2>/dev/null >&2 || true
  printf 'Local worker log (last 80 lines):\n' >&2
  tail -n 80 "$data_root/reports/worker.log" 2>/dev/null >&2 || true
  exit 1
fi
if [[ "$(sha256sum -- "$app" | awk '{print $1}')" != "$app_sha256" || \
      "$(sha256sum -- "$runner" | awk '{print $1}')" != "$runner_sha256" ]]; then
  printf 'Installed product scripts changed during startup; refusing a mixed-version success.\n' >&2
  "$install_root/app/stop-local-product.sh" "$data_root" || \
    printf 'WARNING product processes also failed to stop after code drift; do not start another worker.\n' >&2
  exit 1
fi
"$runtime_python" - "$server_state_file" <<'PY'
import json,sys
print(json.load(open(sys.argv[1],encoding="utf-8"))["url"])
PY
printf 'Server PID %s; single GPU worker PID %s. No LAN/public port was opened.\n' "$server_pid" "$worker_pid"
