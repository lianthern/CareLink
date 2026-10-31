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
  printf 'Read the v9 source and license boundary, then rerun with --confirm-research-canary.\n' >&2
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

for command_name in curl python3 sha256sum tar df; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing required command: %s. This script does not install packages.\n' "$command_name" >&2
    exit 2
  fi
done

available_kib=$(df -Pk "$project_root" | awk 'NR==2 {print $4}')
if [[ -z "$available_kib" || "$available_kib" -lt 2097152 ]]; then
  printf 'At least 2 GiB free is required in WSL ext4; available KiB: %s\n' "${available_kib:-unknown}" >&2
  exit 2
fi

source_url="https://huggingface.co/datasets/nerfbaselines/nerfbaselines-data/resolve/6a638951a007c8b47eb8a0301d48b04d18e955cf/tanksandtemples/meetingroom_2down.tar.gz"
expected_bytes="169378633"
expected_sha256="2e1f86fd7b25314fbc0361b42f16bf77ee222ac50294777995e8ab737aee8d33"
data_root="$project_root/data/tandt-meetingroom-v9"
download_dir="$data_root/download"
archive="$download_dir/meetingroom_2down.tar.gz"
part="$archive.part"
output="$data_root/prepared/meetingroom"
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
python_script="$script_dir/prepare_tandt_meetingroom_hf.py"

mkdir -p "$download_dir" "$data_root/prepared"
if [[ ! -f "$python_script" ]]; then
  printf 'Missing adjacent validator: %s\n' "$python_script" >&2
  exit 2
fi

verify_archive() {
  local candidate="$1"
  local bytes actual_sha
  bytes=$(stat -c '%s' "$candidate")
  if [[ "$bytes" != "$expected_bytes" ]]; then
    printf 'Archive byte mismatch: got %s, expected %s\n' "$bytes" "$expected_bytes" >&2
    return 1
  fi
  actual_sha=$(sha256sum "$candidate" | awk '{print $1}')
  if [[ "$actual_sha" != "$expected_sha256" ]]; then
    printf 'Archive SHA256 mismatch: got %s\n' "$actual_sha" >&2
    return 1
  fi
}

if [[ -f "$archive" ]]; then
  verify_archive "$archive"
else
  curl --fail --location --retry 2 --retry-delay 3 --continue-at - --output "$part" "$source_url"
  verify_archive "$part"
  mv -- "$part" "$archive"
fi

python3 "$python_script" --archive "$archive" --output "$output"

printf '\nPrepared full-room dataset in WSL ext4:\n%s\n' "$output"
printf 'No GPU training, upload, firewall change, package install, or production call was performed.\n'
