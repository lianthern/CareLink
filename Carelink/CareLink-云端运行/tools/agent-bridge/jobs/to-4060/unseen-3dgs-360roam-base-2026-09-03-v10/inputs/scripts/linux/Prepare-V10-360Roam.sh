#!/usr/bin/env bash
set -euo pipefail

confirm=""
project_root="/home/max/src/unseen-3dgs-sceneworker"
mode="prepare"

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
    --download-only)
      mode="download"
      shift
      ;;
    --list-only)
      mode="list"
      shift
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ "$confirm" != "yes" ]]; then
  printf 'Read the v10 source/license boundary, then rerun with --confirm-research-canary.\n' >&2
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
manifest="$script_dir/../../source-manifest.json"
destination="$project_root/data/360roam-base-v10"
[[ -f "$python_script" ]] || { printf 'Missing adapter: %s\n' "$python_script" >&2; exit 2; }
[[ -f "$manifest" ]] || { printf 'Missing source manifest: %s\n' "$manifest" >&2; exit 2; }

args=(--destination "$destination" --manifest "$manifest")
if [[ "$mode" == "download" ]]; then
  args+=(--download-only)
elif [[ "$mode" == "list" ]]; then
  args+=(--list-only)
fi
python3 "$python_script" "${args[@]}"

printf '\nv10 source step complete in WSL ext4: %s\n' "$destination"
printf 'No GPU training, upload, firewall change, package install, production call, or author scene.ply use occurred.\n'
