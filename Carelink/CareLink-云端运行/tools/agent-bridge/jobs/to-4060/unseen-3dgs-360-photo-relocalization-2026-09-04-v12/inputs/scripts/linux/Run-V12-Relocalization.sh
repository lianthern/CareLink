#!/usr/bin/env bash
set -euo pipefail

confirm=""
project_root="/home/max/src/unseen-3dgs-sceneworker"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-research-canary)
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
  printf 'Read the complete v12 contract, then rerun with --confirm-research-canary.\n' >&2
  exit 2
fi
case "$project_root" in
  /home/*) ;;
  *)
    printf 'Refusing non-WSL-ext4 project root: %s\n' "$project_root" >&2
    exit 2
    ;;
esac
if [[ ! -d "$project_root" || -L "$project_root" ]]; then
  printf 'Project root must already exist as a real WSL ext4 directory: %s\n' "$project_root" >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
bridge_root=$(cd -- "$script_dir/../../../../../.." && pwd -P)
localizer="$script_dir/localize_v11_photos.py"
tests="$script_dir/../../tests/test_localize_v11_photos.py"
dataset="$project_root/data/360roam-base-v11/prepared/base-erp9-posefix"
v11_result="$bridge_root/results/from-4060/unseen-3dgs-360roam-posefix-2026-09-04-v11/V11-RESULT.json"
work_dir="$project_root/work/v12-photo-relocalization"
report="$work_dir/photo-relocalization.json"
evidence_dir="$work_dir/local-evidence"

for command_name in python3 df; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. This script does not install packages.\n' "$command_name" >&2
    exit 2
  fi
done
if [[ -f "$project_root/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$project_root/.venv/bin/activate"
fi
python3 -c 'import cv2, numpy; assert hasattr(cv2, "SIFT_create")' || {
  printf 'Existing v11 environment must provide NumPy and OpenCV SIFT; this script does not install packages.\n' >&2
  exit 2
}
[[ -f "$localizer" ]] || { printf 'Missing frozen localizer: %s\n' "$localizer" >&2; exit 2; }
[[ -f "$tests" ]] || { printf 'Missing frozen tests: %s\n' "$tests" >&2; exit 2; }
[[ -f "$dataset/transforms.json" ]] || { printf 'Accepted v11 dataset is missing: %s\n' "$dataset" >&2; exit 2; }
[[ -f "$v11_result" ]] || { printf 'Accepted v11 result is missing from the pulled Bridge: %s\n' "$v11_result" >&2; exit 2; }
if [[ -e "$report" ]]; then
  printf 'Refusing to overwrite an existing official v12 report: %s\n' "$report" >&2
  exit 2
fi
available_kib=$(df -Pk "$project_root" | awk 'NR==2 {print $4}')
if [[ -z "$available_kib" || "$available_kib" -lt 2097152 ]]; then
  printf 'At least 2 GiB free is required in WSL ext4; available KiB: %s\n' "${available_kib:-unknown}" >&2
  exit 2
fi

python3 - "$v11_result" <<'PY'
import json
import sys
from pathlib import Path

result = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
assert result["finalStatus"] == "PANORAMIC_POSEFIX_ACCEPTED_7K"
assert result["sceneRevisionId"] == "360roam-base-posefix-r001"
assert result["training"]["actualOptimizationSteps"] == 7000
assert result["viewer"]["photoRelocalizationEvaluated"] is False
assert result["security"]["status"] == "PASS"
PY

export CUDA_VISIBLE_DEVICES=""
python3 "$tests"
mkdir -p "$work_dir"
python3 "$localizer" --dataset "$dataset" --report "$report" --local-evidence-dir "$evidence_dir"

printf '\nv12 relocalization PASS: %s\n' "$report"
printf 'No GPU training, SOG/checkpoint mutation, download, upload, listener, firewall change, production call or paid API occurred.\n'
