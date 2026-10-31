#!/usr/bin/env bash
set -euo pipefail

if [[ -d /usr/lib/wsl/lib ]]; then
  export PATH="/usr/lib/wsl/lib:$PATH"
fi

product_root="/home/max/src/unseen-local-product"
poc_root="/home/max/src/unseen-3dgs-sceneworker"
data_root="/home/max/unseen-local-product"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --product-root) product_root="${2:?missing value}"; shift 2 ;;
    --poc-root) poc_root="${2:?missing value}"; shift 2 ;;
    --data-root) data_root="${2:?missing value}"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

command -v realpath >/dev/null 2>&1 || { printf 'FAIL realpath command is missing\n'; exit 1; }
product_root=$(realpath -m -- "$product_root")
poc_root=$(realpath -m -- "$poc_root")
data_root=$(realpath -m -- "$data_root")
case "$product_root" in /home/*) ;; *) printf 'FAIL product root is not WSL ext4: %s\n' "$product_root"; exit 1 ;; esac
case "$poc_root" in /home/*) ;; *) printf 'FAIL PoC fallback root is not WSL ext4: %s\n' "$poc_root"; exit 1 ;; esac
case "$data_root" in /home/*) ;; *) printf 'FAIL data root is not WSL ext4: %s\n' "$data_root"; exit 1 ;; esac

export PYTHONDONTWRITEBYTECODE=1
export PYTHONNOUSERSITE=1
failed=0
fail() { printf 'FAIL %s\n' "$*"; failed=1; }
pass() { printf 'PASS %s\n' "$*"; }

if [[ "$(uname -s)" == Linux ]]; then pass 'Linux kernel'; else fail 'not running on Linux'; fi
if grep -Eqi 'microsoft.*WSL2|WSL2.*microsoft' /proc/sys/kernel/osrelease /proc/version 2>/dev/null; then
  pass 'WSL2 detected'
else
  fail 'WSL2 not detected'
fi
if [[ -r /etc/os-release ]] && grep -q '^ID=ubuntu$' /etc/os-release && grep -Eq '^VERSION_ID="?22\.04"?$' /etc/os-release; then
  pass 'Ubuntu 22.04'
else
  fail 'exactly Ubuntu 22.04 is required'
fi
if [[ "$(uname -m)" == x86_64 ]]; then pass 'x86_64 architecture'; else fail 'x86_64 architecture required'; fi

venv_root=""
if [[ -x "$product_root/.venv/bin/python3" ]]; then
  venv_root="$product_root/.venv"
  pass "local Python environment $venv_root"
elif [[ -x "$poc_root/.venv/bin/python3" ]]; then
  venv_root="$poc_root/.venv"
  pass "fallback PoC Python environment $venv_root"
else
  fail "Python environment missing; run $product_root/app/bootstrap-dependencies.sh --confirm-system-packages"
fi
if [[ -n "$venv_root" ]]; then
  # shellcheck disable=SC1090,SC1091
  source "$venv_root/bin/activate"
  export PATH="$venv_root/bin:$PATH"
  python_bin="$venv_root/bin/python3"
else
  python_bin=$(command -v python3 || true)
fi

node_root=""
if [[ -x "$product_root/.tools/node/bin/node" ]]; then
  node_root="$product_root/.tools/node"
  pass "local Node environment $node_root"
elif [[ -x "$poc_root/.tools/node/bin/node" ]]; then
  node_root="$poc_root/.tools/node"
  pass "fallback PoC Node environment $node_root"
else
  fail "pinned Node environment missing; run $product_root/app/bootstrap-dependencies.sh --confirm-system-packages"
fi
if [[ -n "$node_root" ]]; then export PATH="$node_root/bin:$PATH"; fi

splat_root=""
if [[ -x "$product_root/tools/splat-transform/node_modules/.bin/splat-transform" ]]; then
  splat_root="$product_root/tools/splat-transform"
  pass "local splat-transform installation $splat_root"
elif [[ -x "$poc_root/tools/splat-transform/node_modules/.bin/splat-transform" ]]; then
  splat_root="$poc_root/tools/splat-transform"
  pass "fallback PoC splat-transform installation $splat_root"
else
  fail "pinned splat-transform installation missing; run $product_root/app/bootstrap-dependencies.sh --confirm-system-packages"
fi
if [[ -n "$splat_root" ]]; then export PATH="$splat_root/node_modules/.bin:$PATH"; fi

for name in python3 ffmpeg ffprobe colmap ns-process-data ns-train ns-export node npm npx nvidia-smi flock ss sha256sum; do
  if command -v "$name" >/dev/null 2>&1; then pass "command $name"; else fail "command $name missing"; fi
done

app_path="$product_root/app/unseen_local_product.py"
runner_path="$product_root/app/pipeline_runner.py"
verifier_path="$product_root/app/verify_release_payload.py"
for runtime_path in \
  "$app_path" \
  "$runner_path" \
  "$verifier_path" \
  "$product_root/schemas/job.schema.json" \
  "$product_root/schemas/result.schema.json" \
  "$product_root/schemas/queue-state.schema.json"; do
  if [[ -f "$runtime_path" && ! -L "$runtime_path" ]]; then
    pass "installed runtime file $runtime_path"
  else
    fail "installed runtime file is missing or a symlink: $runtime_path"
  fi
done
app_sha256=""
runner_sha256=""
if command -v sha256sum >/dev/null 2>&1 && [[ -f "$app_path" && -f "$runner_path" ]]; then
  app_sha256=$(sha256sum -- "$app_path" | awk '{print $1}')
  runner_sha256=$(sha256sum -- "$runner_path" | awk '{print $1}')
  if [[ "$app_sha256" =~ ^[0-9a-f]{64}$ && "$runner_sha256" =~ ^[0-9a-f]{64}$ ]]; then
    pass "installed code fingerprints app=$app_sha256 runner=$runner_sha256"
  else
    fail 'installed product code fingerprints are invalid'
  fi
fi

if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -hide_banner -filters 2>/dev/null | grep -q ' v360 '; then
  pass 'ffmpeg v360 filter'
else
  fail 'ffmpeg v360 filter missing'
fi

if command -v colmap >/dev/null 2>&1; then
  registrator_help=$(colmap image_registrator -h 2>&1 || true)
  feature_help=$(colmap feature_extractor -h 2>&1 || true)
  colmap_contract_ok=yes
  for option_name in \
    Mapper.fix_existing_images \
    Mapper.abs_pose_min_num_inliers \
    Mapper.abs_pose_min_inlier_ratio \
    Mapper.abs_pose_max_error \
    Mapper.filter_max_reproj_error; do
    if ! grep -Fq -- "--$option_name" <<<"$registrator_help"; then
      fail "COLMAP image_registrator lacks required option --$option_name"
      colmap_contract_ok=no
    fi
  done
  if ! grep -Fq -- '--image_list_path' <<<"$feature_help"; then
    fail 'COLMAP feature_extractor lacks required option --image_list_path'
    colmap_contract_ok=no
  fi
  if [[ "$colmap_contract_ok" == yes ]]; then
    pass 'COLMAP CLI contract for fixed-reference photo registration'
  fi

  installed_colmap=$(dpkg-query -W -f='${Version}' colmap 2>/dev/null || true)
  if [[ "$installed_colmap" == "3.7-2" ]]; then
    pass 'Ubuntu COLMAP 3.7-2'
  else
    fail "COLMAP package must be exactly Ubuntu 3.7-2, found ${installed_colmap:-missing}"
  fi

  # Ubuntu Jammy's COLMAP 3.7-2 package is not a CUDA build. Its use_gpu=1
  # path requires an OpenGL context and is not a reliable non-interactive WSL
  # contract. Exercise the exact headless CPU SIFT path used by R3 instead;
  # the RTX 4060 CUDA gate below remains mandatory for the 7k 3DGS training.
  colmap_probe=$(mktemp -d /tmp/unseen-colmap-cpu-doctor.XXXXXX)
  colmap_probe_cleanup() { rm -rf -- "$colmap_probe"; }
  trap colmap_probe_cleanup EXIT
  mkdir -p "$colmap_probe/images"
  if ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=256x256:rate=1' -frames:v 1 "$colmap_probe/images/a.png" \
      >"$colmap_probe/ffmpeg.log" 2>&1 && \
     ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=256x256:rate=1' -vf 'hflip' -frames:v 1 "$colmap_probe/images/b.png" \
      >>"$colmap_probe/ffmpeg.log" 2>&1 && \
     colmap feature_extractor --database_path "$colmap_probe/database.db" --image_path "$colmap_probe/images" \
      --ImageReader.single_camera 1 --SiftExtraction.use_gpu 0 --SiftExtraction.max_image_size 256 \
      --SiftExtraction.max_num_features 512 >"$colmap_probe/feature.log" 2>&1 && \
     colmap exhaustive_matcher --database_path "$colmap_probe/database.db" --SiftMatching.use_gpu 0 \
      >"$colmap_probe/match.log" 2>&1; then
    pass 'COLMAP headless CPU SIFT extraction and matching smoke'
  else
    fail 'COLMAP headless CPU SIFT smoke failed; preview was not started'
    tail -n 12 "$colmap_probe/feature.log" "$colmap_probe/match.log" 2>/dev/null | sed 's/^/INFO COLMAP /'
  fi
  colmap_probe_cleanup
  trap - EXIT
fi

if command -v nvidia-smi >/dev/null 2>&1 && \
   nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null | grep -qi '4060'; then
  pass 'NVIDIA RTX 4060 visible in WSL'
  nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null | sed 's/^/INFO GPU /'
else
  fail 'RTX 4060 is not visible in WSL'
fi

if command -v node >/dev/null 2>&1; then
  if [[ "$(node --version)" == v22.23.1 ]]; then pass 'Node v22.23.1'; else fail "Node must be v22.23.1, found $(node --version)"; fi
fi
if [[ -n "$splat_root" && -n "$python_bin" ]]; then
  if "$python_bin" - "$splat_root/node_modules/@playcanvas/splat-transform/package.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
version = json.loads(path.read_text(encoding="utf-8")).get("version")
if version != "3.3.3":
    raise SystemExit(f"FAIL @playcanvas/splat-transform expected 3.3.3, found {version}")
print("PASS @playcanvas/splat-transform 3.3.3")
PY
  then :; else failed=1; fi
fi

viewer_root=""
if [[ -f "$product_root/viewer/app.js" && -f "$product_root/viewer/index.html" && \
      -f "$product_root/viewer/scene.schema.json" && -f "$product_root/viewer/vendor/playcanvas.min.mjs" ]]; then
  viewer_root="$product_root/viewer"
  pass "local viewer source $viewer_root"
elif [[ -f "$poc_root/viewer/app.js" && -f "$poc_root/viewer/index.html" && \
        -f "$poc_root/viewer/scene.schema.json" && -f "$poc_root/viewer/vendor/playcanvas.min.mjs" ]]; then
  viewer_root="$poc_root/viewer"
  pass "fallback PoC viewer source $viewer_root"
else
  fail 'viewer source is incomplete'
fi

if [[ -f "$product_root/dependencies/SHA256SUMS" ]] && command -v sha256sum >/dev/null 2>&1; then
  if (cd -- "$product_root/dependencies" && sha256sum --check --strict SHA256SUMS >/dev/null); then
    pass 'packaged dependency SHA256 values'
  else
    fail 'packaged dependency SHA256 mismatch'
  fi
else
  fail 'packaged dependency checksums are missing'
fi
gsplat_cache="$product_root/.cache/bootstrap/gsplat-1.4.0+pt21cu121-cp310-cp310-linux_x86_64.whl"
if [[ -f "$gsplat_cache" ]]; then
  actual_gsplat_sha=$(sha256sum "$gsplat_cache" | awk '{print $1}')
  if [[ "$actual_gsplat_sha" == 19a1dc14f42c1fff4dc2409b7a0bace0f6b59d1dfa58f93cf4083d52a1cce5b4 ]]; then
    pass 'cached precompiled gsplat 1.4.0+pt21cu121 wheel SHA256'
  else
    fail 'cached precompiled gsplat wheel SHA256 mismatch'
  fi
else
  printf 'INFO precompiled gsplat wheel cache is absent; exact installed metadata and CUDA kernel are checked below.\n'
fi

if [[ -n "$python_bin" ]]; then
  if "$python_bin" - <<'PY'
import importlib.metadata
import sqlite3
import sys

if sys.version_info[:2] != (3, 10):
    raise SystemExit(f"FAIL Python 3.10 required, found {sys.version.split()[0]}")
print(f"PASS Python {sys.version.split()[0]} and sqlite3")

expected = {
    "jsonschema": "4.26.0",
    "nerfstudio": "1.1.5",
    "torch": "2.1.2",
    "torchvision": "0.16.2",
}
for name, wanted in expected.items():
    try:
        actual = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        raise SystemExit(f"FAIL Python package missing: {name}")
    if actual.split("+")[0] != wanted:
        raise SystemExit(f"FAIL {name} expected {wanted}, found {actual}")
    print(f"PASS {name} {actual}")

gsplat_version = importlib.metadata.version("gsplat")
if gsplat_version != "1.4.0+pt21cu121":
    raise SystemExit(
        "FAIL gsplat must be the precompiled 1.4.0+pt21cu121 wheel; "
        f"found {gsplat_version}"
    )
print(f"PASS gsplat {gsplat_version} precompiled wheel metadata")

import torch

if torch.version.cuda != "12.1":
    raise SystemExit(f"FAIL torch CUDA runtime expected 12.1, found {torch.version.cuda}")
if not torch.cuda.is_available():
    raise SystemExit("FAIL torch.cuda.is_available() is false")
device_name = torch.cuda.get_device_name(0)
if "4060" not in device_name:
    raise SystemExit(f"FAIL torch CUDA device is not RTX 4060: {device_name}")
probe = torch.ones(1, device="cuda") + 1
torch.cuda.synchronize()
if probe.item() != 2:
    raise SystemExit("FAIL CUDA tensor probe returned the wrong value")
print(f"PASS torch CUDA 12.1 tensor probe on {device_name}")

# Import and execute both forward and backward through the compiled gsplat CUDA
# extension. Import/version checks alone would let the source-only PyPI wheel
# pass even though it later disables gsplat when nvcc is absent.
from gsplat import quat_scale_to_covar_preci
from gsplat.cuda._backend import _C

if _C is None:
    raise SystemExit("FAIL gsplat compiled CUDA extension is unavailable")
quaternions = torch.tensor([[1.0, 0.0, 0.0, 0.0]], device="cuda", requires_grad=True)
scales = torch.tensor([[1.0, 1.25, 0.75]], device="cuda", requires_grad=True)
covariances, precisions = quat_scale_to_covar_preci(quaternions, scales)
loss = covariances.sum() + precisions.sum()
loss.backward()
if not all(
    tensor is not None and torch.isfinite(tensor).all().item()
    for tensor in (covariances, precisions, quaternions.grad, scales.grad)
):
    raise SystemExit("FAIL gsplat CUDA forward/backward produced non-finite values")
torch.cuda.synchronize()
print("PASS gsplat compiled CUDA forward/backward smoke")
PY
  then :; else failed=1; fi
fi

if [[ -n "$python_bin" && -n "$app_sha256" && -n "$runner_sha256" ]]; then
  if "$python_bin" - "$data_root" "$app_path" "$app_sha256" "$runner_sha256" <<'PY'
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

data_root = Path(sys.argv[1])
app_path = sys.argv[2]
app_sha256 = sys.argv[3]
runner_sha256 = sys.argv[4]
live: dict[str, tuple[int, dict]] = {}

for role in ("server", "worker"):
    pid_path = data_root / "reports" / f"{role}.pid"
    state_path = data_root / "reports" / f"{role}-state.json"
    if not pid_path.is_file():
        print(f"INFO {role} is not currently recorded; no process fingerprint to compare")
        continue
    try:
        pid_text = pid_path.read_text(encoding="utf-8").strip()
        if not pid_text.isdigit() or int(pid_text) <= 0:
            raise ValueError("PID is not a positive integer")
        pid = int(pid_text)
        os.kill(pid, 0)
    except ProcessLookupError:
        print(f"INFO stale {role} PID file; start will replace it without touching durable data")
        continue
    except (OSError, ValueError) as exc:
        raise SystemExit(f"FAIL could not verify recorded {role} PID: {exc}") from exc
    try:
        argv = [
            part.decode("utf-8", errors="strict")
            for part in (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0")
            if part
        ]
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SystemExit(f"FAIL live {role} lacks readable process/state evidence: {exc}") from exc
    if app_path not in argv or role not in argv:
        raise SystemExit(f"FAIL recorded live {role} PID does not run the installed product path")
    if type(state.get("pid")) is not int or state["pid"] != pid:
        raise SystemExit(f"FAIL live {role} state PID does not match its PID file")
    if type(state.get("appSha256")) is not str or state["appSha256"] != app_sha256:
        raise SystemExit(f"FAIL live {role} app SHA256 does not match installed code")
    if role == "worker":
        if type(state.get("runnerSha256")) is not str or state["runnerSha256"] != runner_sha256:
            raise SystemExit("FAIL live worker runner SHA256 does not match installed code")
        if state.get("alive") is not True or state.get("state") not in {"idle", "running"}:
            raise SystemExit("FAIL live worker state is not reusable")
    live[role] = (pid, state)
    print(f"PASS live {role} launch-time code fingerprint matches installed bytes")

if "server" in live:
    server_pid, server_state = live["server"]
    url = server_state.get("url")
    if not isinstance(url, str) or re.fullmatch(r"http://127\.0\.0\.1:[0-9]{1,5}/", url) is None:
        raise SystemExit("FAIL live server state does not expose an exact loopback URL")
    try:
        with urllib.request.urlopen(url + "api/health", timeout=2) as response:
            if response.status != 200:
                raise ValueError(f"HTTP {response.status}")
            health = json.load(response)
    except Exception as exc:
        raise SystemExit(f"FAIL live server /api/health is unavailable: {exc}") from exc
    server = health.get("server", {})
    if type(server.get("pid")) is not int or server["pid"] != server_pid:
        raise SystemExit("FAIL /api/health server PID disagrees with the live process")
    if type(server.get("appSha256")) is not str or server["appSha256"] != app_sha256:
        raise SystemExit("FAIL /api/health server SHA256 disagrees with installed code")
    if "worker" in live:
        worker_pid, _worker_state = live["worker"]
        worker = health.get("worker", {})
        if type(worker.get("pid")) is not int or worker["pid"] != worker_pid:
            raise SystemExit("FAIL /api/health worker PID disagrees with the live process")
        if worker.get("appSha256") != app_sha256 or worker.get("runnerSha256") != runner_sha256:
            raise SystemExit("FAIL /api/health worker code fingerprints disagree with installed bytes")
    print("PASS /api/health process/code fingerprints match doctor evidence")
PY
  then :; else failed=1; fi
fi

if [[ -d "$product_root" ]]; then
  available_kib=$(df -Pk "$product_root" 2>/dev/null | awk 'NR==2 {print $4}')
else
  available_kib=""
fi
if [[ "${available_kib:-}" =~ ^[0-9]+$ ]] && (( available_kib >= 31457280 )); then
  pass 'WSL ext4 free space >= 30 GiB'
else
  fail 'need >= 30 GiB free on WSL ext4'
fi
if command -v pgrep >/dev/null 2>&1 && pgrep -af 'ns-train|pipeline_runner.py' | grep -v "$$" | grep -q .; then
  fail 'another GPU/training process appears active'
else
  pass 'no other known GPU job'
fi

if [[ "$failed" -ne 0 ]]; then
  printf 'DOCTOR_FAILED. No installation, download or system change was attempted.\n'
  exit 1
fi
printf 'DOCTOR_PASS. Frozen dependencies, headless CPU COLMAP, RTX 4060 training CUDA, viewer and free space are ready.\n'
