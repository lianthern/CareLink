#!/usr/bin/env bash
set -euo pipefail

confirm=""
project_root="/home/max/src/unseen-3dgs-sceneworker"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-persistent-goal)
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
  printf 'Read GOAL.md and ACCEPTANCE.md, then rerun with --confirm-persistent-goal.\n' >&2
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
prepare="$script_dir/prepare_fixed_query_challenge.py"
gate_tests="$script_dir/../../tests/test_v14_final_gate.py"
candidate_tests="$script_dir/../../tests/test_v14_sift_track_candidate.py"
dataset="$project_root/data/360roam-base-v11/prepared/base-erp9-posefix"
v11_result="$bridge_root/results/from-4060/unseen-3dgs-360roam-posefix-2026-09-04-v11/V11-RESULT.json"
v13_result="$bridge_root/results/from-4060/unseen-3dgs-360-photo-relocalization-multiview-2026-09-04-v13/V13-RESULT.json"
work_dir="$project_root/work/v14-photo-return-goal"
challenge="$work_dir/challenge"

for command_name in python3 df git; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. Setup does not install packages.\n' "$command_name" >&2
    exit 2
  fi
done
if [[ -f "$project_root/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$project_root/.venv/bin/activate"
fi
python3 -c 'import cv2, numpy; assert hasattr(cv2, "SIFT_create")' || {
  printf 'Existing v11 environment must provide NumPy and OpenCV SIFT.\n' >&2
  exit 2
}
[[ -f "$prepare" ]] || { printf 'Missing v14 challenge builder: %s\n' "$prepare" >&2; exit 2; }
[[ -f "$gate_tests" ]] || { printf 'Missing v14 gate tests: %s\n' "$gate_tests" >&2; exit 2; }
[[ -f "$candidate_tests" ]] || { printf 'Missing v14 candidate tests: %s\n' "$candidate_tests" >&2; exit 2; }
[[ -f "$dataset/transforms.json" ]] || { printf 'Accepted v11 dataset is missing: %s\n' "$dataset" >&2; exit 2; }
[[ -f "$v11_result" ]] || { printf 'Accepted v11 result is missing: %s\n' "$v11_result" >&2; exit 2; }
[[ -f "$v13_result" ]] || { printf 'Audited v13 result is missing: %s\n' "$v13_result" >&2; exit 2; }
available_kib=$(df -Pk "$project_root" | awk 'NR==2 {print $4}')
if [[ -z "$available_kib" || "$available_kib" -lt 2097152 ]]; then
  printf 'At least 2 GiB free is required in WSL ext4; available KiB: %s\n' "${available_kib:-unknown}" >&2
  exit 2
fi

python3 - "$v11_result" "$v13_result" <<'PY'
import json
import sys
from pathlib import Path

v11 = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
v13 = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
assert v11["finalStatus"] == "PANORAMIC_POSEFIX_ACCEPTED_7K"
assert v11["sceneRevisionId"] == "360roam-base-posefix-r001"
assert v11["security"]["status"] == "PASS"
assert v13["finalStatus"] == "PHOTO_RELOCALIZATION_MULTIVIEW_PARTIAL_2_OF_3"
assert v13["photoRelocalization"]["queries"][1]["id"] == "val_1_0027__right"
assert v13["photoRelocalization"]["queries"][1]["ratioMatches"] == 56
assert v13["photoRelocalization"]["queries"][1]["pnpInliers"] == 0
assert v13["execution"]["officialFrozenRuns"] == 1
PY

export CUDA_VISIBLE_DEVICES=""
export PYTHONDONTWRITEBYTECODE=1
python3 "$gate_tests"
python3 "$candidate_tests"
mkdir -p "$work_dir/candidate" "$work_dir/index"
python3 "$prepare" --dataset "$dataset" --output "$challenge"

printf '\nv14 persistent goal setup is READY.\n'
printf 'Truth-free challenge: %s/challenge.json\n' "$challenge"
printf 'Read GOAL.md. Keep experiments under %s and publish only safe ledgers/code/reports through GitHub.\n' "$work_dir"
printf 'Setup did not train 3DGS, download a model, expose a port, call production or run the final gate.\n'
