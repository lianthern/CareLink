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
  printf 'Read the v11 pose-fix contract, then rerun with --confirm-research-canary.\n' >&2
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
export PATH="/usr/lib/wsl/lib:$PATH"
if [[ -f "$project_root/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$project_root/.venv/bin/activate"
fi
for command_name in python3 ffmpeg df; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. This script does not install packages.\n' "$command_name" >&2
    exit 2
  fi
done
available_kib=$(df -Pk "$project_root" | awk 'NR==2 {print $4}')
if [[ -z "$available_kib" || "$available_kib" -lt 6291456 ]]; then
  printf 'At least 6 GiB free is required in WSL ext4; available KiB: %s\n' "${available_kib:-unknown}" >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
python_script="$script_dir/prepare_360roam_base.py"
alignment_script="$script_dir/validate_and_seed.py"
manifest="$script_dir/../../source-manifest.json"
destination="$project_root/data/360roam-base-v11"
reuse_download="$project_root/data/360roam-base-v10/download"
reuse_views="$project_root/data/360roam-base-v10/prepared/base-erp10/images"
[[ -f "$python_script" ]] || { printf 'Missing adapter: %s\n' "$python_script" >&2; exit 2; }
[[ -f "$alignment_script" ]] || { printf 'Missing image/pose gate: %s\n' "$alignment_script" >&2; exit 2; }
[[ -f "$manifest" ]] || { printf 'Missing source manifest: %s\n' "$manifest" >&2; exit 2; }
[[ -d "$reuse_download/panos" ]] || { printf 'v10 verified download cache is missing; do not redownload automatically: %s\n' "$reuse_download" >&2; exit 2; }
[[ -d "$reuse_views" ]] || { printf 'v10 prepared view cache is missing; preserve evidence and report BLOCKED: %s\n' "$reuse_views" >&2; exit 2; }
python3 -c 'import cv2; assert hasattr(cv2, "SIFT_create")' || { printf 'Existing venv must provide OpenCV SIFT; this script does not install packages.\n' >&2; exit 2; }

args=(--destination "$destination" --manifest "$manifest" --offline-reuse --reuse-download-root "$reuse_download" --reuse-view-root "$reuse_views")
python3 "$python_script" "${args[@]}"
dataset="$destination/prepared/base-erp9-posefix"
python3 "$alignment_script" --dataset "$dataset" --report "$destination/pose-image-gate.json"

printf '\nv11 pose-fix source step complete in WSL ext4: %s\n' "$destination"
printf 'The v10 cache was verified/reused; no source redownload, GPU training, upload, firewall change, package install, production call, or author scene.ply use occurred.\n'
