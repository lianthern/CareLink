#!/usr/bin/env bash
set -euo pipefail

confirm=""
project_root="/home/max/src/unseen-3dgs-sceneworker"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-gpu-preview)
      confirm="yes"
      shift
      ;;
    --project-root)
      project_root="${2:?--project-root requires a value}"
      shift 2
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
if [[ "$confirm" != "yes" ]]; then
  printf 'GPU work requires the explicit --confirm-gpu-preview switch.\n' >&2
  exit 2
fi
case "$project_root" in
  /home/*) ;;
  *) printf 'Refusing non-WSL-ext4 project root: %s\n' "$project_root" >&2; exit 2 ;;
esac
dataset="$project_root/data/360roam-base-v10/prepared/base-erp10"
prepared="$dataset/.prepared.json"
[[ -f "$prepared" ]] || { printf 'Run Prepare-V10-360Roam.sh first.\n' >&2; exit 2; }
python3 - "$prepared" <<'PY'
import json, sys
report = json.load(open(sys.argv[1], encoding="utf-8"))
if report.get("status") != "READY" or not all(report.get("checks", {}).values()):
    raise SystemExit("prepared-data gate is not PASS")
PY
for command_name in nvidia-smi ns-train python3; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'Missing required command: %s\n' "$command_name" >&2; exit 2; }
done
if pgrep -af '[n]s-train|[c]olmap|[n]s-export' >/dev/null; then
  printf 'Refusing to overlap another GPU/COLMAP/export job.\n' >&2
  pgrep -af '[n]s-train|[c]olmap|[n]s-export' >&2 || true
  exit 2
fi

run_root="$project_root/artifacts/training/v10/360roam-base-r001"
log_root="$project_root/artifacts/reports/v10/360roam-base-r001/logs"
attempt_marker="$run_root/.preview-7000-attempted"
[[ ! -e "$attempt_marker" ]] || { printf 'v10 preview was already attempted; refusing hidden retry.\n' >&2; exit 2; }
[[ ! -e "$run_root/360roam-base-v10" ]] || { printf 'v10 training output already exists; refusing overwrite.\n' >&2; exit 2; }
mkdir -p "$run_root" "$log_root"
set -o noclobber
printf 'started_at=%s\niterations=7000\n' "$(date --utc --iso-8601=seconds)" >"$attempt_marker"
set +o noclobber

if [[ -f "$project_root/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$project_root/.venv/bin/activate"
fi
command=(
  ns-train splatfacto
  --output-dir "$run_root"
  --experiment-name 360roam-base-v10
  --timestamp stage-7000
  --max-num-iterations 7000
  --steps-per-save 2000
  --steps-per-eval-image 100000
  --steps-per-eval-all-images 100000
  --vis tensorboard
  --pipeline.model.use-scale-regularization True
  --pipeline.model.random-init True
  --pipeline.model.camera-optimizer.mode off
  nerfstudio-data
  --data "$dataset"
  --load-3D-points False
  --orientation-method up
  --center-method poses
  --auto-scale-poses True
  --downscale-factor 1
)
printf '%q ' "${command[@]}" >"$log_root/train-command.txt"
printf '\n' >>"$log_root/train-command.txt"
nvidia-smi --query-gpu=timestamp,memory.used,utilization.gpu --format=csv,noheader,nounits -lms 500 >"$log_root/gpu-samples.csv" &
monitor_pid=$!
cleanup() {
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
}
trap cleanup EXIT
start_epoch=$(date +%s)
set +e
/usr/bin/time -v "${command[@]}" 2>&1 | tee "$log_root/train.log"
train_status=${PIPESTATUS[0]}
set -e
end_epoch=$(date +%s)
cleanup
trap - EXIT
oom=false
if grep -Eiq 'out of memory|cuda.*oom' "$log_root/train.log"; then oom=true; fi
peak_vram=$(awk -F, '{gsub(/ /, "", $2); if (($2 + 0) > peak) peak=$2 + 0} END {printf "%d", peak}' "$log_root/gpu-samples.csv")
python3 - "$log_root/stage-result.json" "$train_status" "$start_epoch" "$end_epoch" "$peak_vram" "$oom" <<'PY'
import json, sys
path, status, start, end, peak, oom = sys.argv[1:]
result = {
    "schemaVersion": "1.0",
    "sceneRevisionId": "360roam-base-r001",
    "stage": 7000,
    "fromScratch": True,
    "randomInit": True,
    "usesAuthorScenePly": False,
    "exitCode": int(status),
    "wallSeconds": int(end) - int(start),
    "peakVramMiB": int(peak),
    "oom": oom == "true",
    "status": "TRAINING_COMPLETE" if int(status) == 0 else "FAILED",
}
open(path, "w", encoding="utf-8").write(json.dumps(result, indent=2) + "\n")
PY
exit "$train_status"
