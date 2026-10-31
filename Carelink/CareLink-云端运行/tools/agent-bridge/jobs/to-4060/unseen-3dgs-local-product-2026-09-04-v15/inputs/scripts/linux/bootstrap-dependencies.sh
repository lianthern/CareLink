#!/usr/bin/env bash
set -euo pipefail

if [[ -d /usr/lib/wsl/lib ]]; then
  export PATH="/usr/lib/wsl/lib:$PATH"
fi

confirm=""
install_root="/home/max/src/unseen-local-product"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-system-packages) confirm="yes"; shift ;;
    --install-root) install_root="${2:?missing --install-root value}"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [[ "$confirm" != yes ]]; then
  printf '%s\n' 'Bootstrap was not started.' >&2
  printf '%s\n' 'It changes Ubuntu packages and downloads pinned Python/npm/Node dependencies.' >&2
  printf 'After Windows host-disk preflight and explicit approval, rerun:\n  %q --confirm-system-packages --install-root %q\n' \
    "$0" "$install_root" >&2
  exit 2
fi

[[ "$(uname -s)" == Linux ]] || { printf 'Bootstrap supports Ubuntu 22.04 under WSL2 only.\n' >&2; exit 1; }
grep -Eqi 'microsoft.*WSL2|WSL2.*microsoft' /proc/sys/kernel/osrelease /proc/version 2>/dev/null || {
  printf 'WSL2 was not detected. No apt or network action was attempted.\n' >&2; exit 1;
}
[[ -r /etc/os-release ]] || { printf '/etc/os-release is unavailable. No apt or network action was attempted.\n' >&2; exit 1; }
if ! grep -q '^ID=ubuntu$' /etc/os-release || ! grep -Eq '^VERSION_ID="?22\.04"?$' /etc/os-release; then
  printf 'Exactly Ubuntu 22.04 is required. No apt or network action was attempted.\n' >&2
  exit 1
fi
[[ "$(uname -m)" == x86_64 ]] || {
  printf 'Exactly x86_64 is required for the frozen Python/Node artifacts. No apt or network action was attempted.\n' >&2; exit 1;
}
[[ "$EUID" -ne 0 ]] || {
  printf 'Run bootstrap as the normal WSL user, not root. sudo is used only for the explicit apt step.\n' >&2; exit 1;
}
command -v realpath >/dev/null 2>&1 || { printf 'realpath is required. No apt or network action was attempted.\n' >&2; exit 1; }
install_root=$(realpath -m -- "$install_root")
case "$install_root" in
  /home/*) ;;
  *) printf 'Install root must resolve to WSL ext4 under /home: %s\n' "$install_root" >&2; exit 2 ;;
esac

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
if [[ -f "$script_dir/../../dependencies/SHA256SUMS" ]]; then
  input_root=$(cd -- "$script_dir/../.." && pwd -P)
  installer="$script_dir/install-local-product.sh"
elif [[ -f "$script_dir/../dependencies/SHA256SUMS" ]]; then
  input_root=$(cd -- "$script_dir/.." && pwd -P)
  installer=""
else
  printf 'Frozen dependency bundle was not found next to this script. No apt or network action was attempted.\n' >&2
  exit 1
fi
dependencies="$input_root/dependencies"

for source_path in \
  "$dependencies/SHA256SUMS" \
  "$dependencies/python-cu121.lock" \
  "$dependencies/nerfstudio-1.1.5-py3-none-any.whl" \
  "$dependencies/splat-transform/package.json" \
  "$dependencies/splat-transform/package-lock.json"; do
  [[ -f "$source_path" ]] || { printf 'Frozen dependency is missing: %s. No apt or network action was attempted.\n' "$source_path" >&2; exit 1; }
done
command -v sha256sum >/dev/null 2>&1 || { printf 'sha256sum is required. No apt or network action was attempted.\n' >&2; exit 1; }
(
  cd -- "$dependencies"
  sha256sum --check --strict SHA256SUMS
) || { printf 'Frozen dependency hash check failed. No apt or network action was attempted.\n' >&2; exit 1; }

available_kib=$(df -Pk /home 2>/dev/null | awk 'NR==2 {print $4}')
if [[ ! "${available_kib:-}" =~ ^[0-9]+$ ]] || (( available_kib < 31457280 )); then
  printf 'At least 30 GiB free inside WSL ext4 is required before bootstrap. No apt or network action was attempted.\n' >&2
  exit 1
fi
command -v sudo >/dev/null 2>&1 || { printf 'sudo is required for the explicitly approved apt step.\n' >&2; exit 1; }
command -v apt-get >/dev/null 2>&1 || { printf 'apt-get is unavailable.\n' >&2; exit 1; }

printf 'CONFIRMED: installing the frozen Ubuntu prerequisite set; no Linux NVIDIA driver or firewall package is included.\n'
sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  python3.10 python3.10-dev python3.10-venv ffmpeg 'colmap=3.7-2' curl git xz-utils build-essential ninja-build ca-certificates iproute2

for command_name in python3.10 ffmpeg ffprobe colmap curl tar xz sha256sum ss; do
  command -v "$command_name" >/dev/null 2>&1 || { printf 'Required command is still missing after apt: %s\n' "$command_name" >&2; exit 1; }
done
installed_colmap=$(dpkg-query -W -f='${Version}' colmap 2>/dev/null || true)
[[ "$installed_colmap" == "3.7-2" ]] || {
  printf 'Ubuntu COLMAP must be exactly 3.7-2, found: %s\n' "${installed_colmap:-missing}" >&2
  exit 1
}
printf 'PASS Ubuntu COLMAP 3.7-2. R3 uses its headless CPU SIFT path; RTX CUDA is reserved for 3DGS training.\n'

if [[ -n "$installer" ]]; then
  bash "$installer" --confirm-install --install-root "$install_root"
fi
dependencies="$install_root/dependencies"
(
  cd -- "$dependencies"
  sha256sum --check --strict SHA256SUMS
) || { printf 'Installed dependency copy failed its hash check.\n' >&2; exit 1; }

umask 077
cache_dir="$install_root/.cache/bootstrap"
tools_dir="$install_root/.tools"
mkdir -p "$cache_dir" "$tools_dir"
download_tmp=""
node_tmp=""
cleanup() {
  if [[ -n "$download_tmp" && -f "$download_tmp" ]]; then rm -f -- "$download_tmp"; fi
  if [[ -n "$node_tmp" && -d "$node_tmp" ]]; then rm -rf -- "$node_tmp"; fi
}
trap cleanup EXIT

download_verified() {
  local url="$1" destination="$2" expected_sha="$3" expected_bytes="${4:-}"
  if [[ -f "$destination" ]]; then
    if [[ "$(sha256sum "$destination" | awk '{print $1}')" != "$expected_sha" ]]; then
      printf 'Cached download has the wrong SHA256; move it aside and rerun: %s\n' "$destination" >&2
      return 1
    fi
    if [[ -n "$expected_bytes" && "$(stat -c '%s' "$destination")" != "$expected_bytes" ]]; then
      printf 'Cached download has the wrong size: %s\n' "$destination" >&2
      return 1
    fi
    printf 'PASS cached download SHA256: %s\n' "$(basename -- "$destination")"
    return 0
  fi
  download_tmp=$(mktemp "$cache_dir/.download.XXXXXX")
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$download_tmp" "$url"
  [[ "$(sha256sum "$download_tmp" | awk '{print $1}')" == "$expected_sha" ]] || {
    printf 'Downloaded SHA256 mismatch for %s\n' "$url" >&2; return 1;
  }
  if [[ -n "$expected_bytes" && "$(stat -c '%s' "$download_tmp")" != "$expected_bytes" ]]; then
    printf 'Downloaded size mismatch for %s\n' "$url" >&2; return 1
  fi
  mv -- "$download_tmp" "$destination"
  download_tmp=""
  printf 'PASS downloaded and verified: %s\n' "$(basename -- "$destination")"
}

node_version="22.23.1"
node_archive="$cache_dir/node-v${node_version}-linux-x64.tar.xz"
node_sha="9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578"
node_url="https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz"
download_verified "$node_url" "$node_archive" "$node_sha"

node_dir="$tools_dir/node-v${node_version}-linux-x64"
if [[ -e "$node_dir" && ! -d "$node_dir" ]]; then
  printf 'Pinned Node target exists but is not a directory: %s\n' "$node_dir" >&2; exit 1
fi
if [[ -d "$node_dir" ]]; then
  [[ -x "$node_dir/bin/node" && "$("$node_dir/bin/node" --version)" == "v${node_version}" ]] || {
    printf 'Existing pinned Node directory is incomplete or the wrong version: %s\n' "$node_dir" >&2; exit 1;
  }
else
  node_tmp=$(mktemp -d "$tools_dir/.node-install.XXXXXX")
  tar -xJf "$node_archive" -C "$node_tmp" --strip-components=1
  [[ -x "$node_tmp/bin/node" && "$("$node_tmp/bin/node" --version)" == "v${node_version}" ]] || {
    printf 'Extracted Node runtime failed its version check.\n' >&2; exit 1;
  }
  mv -- "$node_tmp" "$node_dir"
  node_tmp=""
fi
node_link="$tools_dir/node"
if [[ -e "$node_link" && ! -L "$node_link" ]]; then
  printf 'Refusing to replace a non-symlink local Node path: %s\n' "$node_link" >&2; exit 1
fi
ln -sfn "$(basename -- "$node_dir")" "$node_link"
export PATH="$node_link/bin:$PATH"
[[ "$(node --version)" == "v${node_version}" ]] || { printf 'Pinned Node PATH activation failed.\n' >&2; exit 1; }

venv_dir="$install_root/.venv"
if [[ -e "$venv_dir" && ! -x "$venv_dir/bin/python3" ]]; then
  printf 'Existing .venv is incomplete; move it aside and rerun: %s\n' "$venv_dir" >&2; exit 1
fi
if [[ ! -d "$venv_dir" ]]; then
  python3.10 -m venv "$venv_dir"
fi
python_bin="$venv_dir/bin/python3"
[[ "$("$python_bin" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" == "3.10" ]] || {
  printf 'The local virtual environment is not Python 3.10: %s\n' "$venv_dir" >&2; exit 1;
}
export PYTHONNOUSERSITE=1
"$python_bin" -m pip --disable-pip-version-check install --upgrade 'pip==25.2' 'wheel==0.45.1'
"$python_bin" -m pip --disable-pip-version-check install \
  --index-url https://download.pytorch.org/whl/cu121 \
  'torch==2.1.2' 'torchvision==0.16.2'

gsplat_wheel="$cache_dir/gsplat-1.4.0+pt21cu121-cp310-cp310-linux_x86_64.whl"
gsplat_url="https://github.com/nerfstudio-project/gsplat/releases/download/v1.4.0/gsplat-1.4.0%2Bpt21cu121-cp310-cp310-linux_x86_64.whl"
gsplat_sha="19a1dc14f42c1fff4dc2409b7a0bace0f6b59d1dfa58f93cf4083d52a1cce5b4"
download_verified "$gsplat_url" "$gsplat_wheel" "$gsplat_sha" "14800006"

"$python_bin" -m pip --disable-pip-version-check install --no-deps \
  "$dependencies/nerfstudio-1.1.5-py3-none-any.whl" "$gsplat_wheel"
"$python_bin" -m pip --disable-pip-version-check install \
  --index-url https://pypi.org/simple \
  --requirement "$dependencies/python-cu121.lock"

npm ci --prefix "$install_root/tools/splat-transform" --no-audit --no-fund
[[ -x "$install_root/tools/splat-transform/node_modules/.bin/splat-transform" ]] || {
  printf 'Pinned splat-transform executable is missing after npm ci.\n' >&2; exit 1;
}

printf 'Bootstrap downloads and installs are complete. Running the read-only doctor now.\n'
bash "$install_root/app/doctor-local-product.sh" --product-root "$install_root"
printf 'BOOTSTRAP_COMPLETE. No Linux NVIDIA driver, firewall rule, service, token or media was installed.\n'
