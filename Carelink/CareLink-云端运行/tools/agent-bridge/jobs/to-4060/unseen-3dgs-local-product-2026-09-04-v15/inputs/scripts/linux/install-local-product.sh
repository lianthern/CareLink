#!/usr/bin/env bash
set -euo pipefail

confirm=""
install_root="/home/max/src/unseen-local-product"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-install) confirm="yes"; shift ;;
    --install-root) install_root="${2:?missing --install-root value}"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$confirm" == yes ]] || {
  printf 'This only copies packaged product files into WSL ext4. It does not use apt or the network. Rerun with --confirm-install.\n' >&2
  exit 2
}

command -v realpath >/dev/null 2>&1 || { printf 'realpath is required. No files were copied.\n' >&2; exit 1; }
install_root=$(realpath -m -- "$install_root")
case "$install_root" in
  /home/*) ;;
  *) printf 'Install root must resolve to WSL ext4 under /home: %s\n' "$install_root" >&2; exit 2 ;;
esac

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
input_root=$(cd -- "$script_dir/../.." && pwd -P)
job_root=$(cd -- "$input_root/.." && pwd -P)
dependencies="$input_root/dependencies"
viewer_source="$input_root/viewer"
schema_source="$input_root/schemas"
payload_verifier="$script_dir/verify_release_payload.py"
bridge_receipt="$job_root/.bridge-receipt.json"

# Verify the exact extracted Release tree before mkdir/install or any other
# filesystem mutation. The verifier is standard-library-only; -B ensures this
# read-only preflight cannot add __pycache__ to the transport payload.
[[ -f "$payload_verifier" && ! -L "$payload_verifier" ]] || {
  printf 'Packaged payload verifier is missing or is a symlink. Nothing was copied.\n' >&2
  exit 1
}
[[ -f "$bridge_receipt" && ! -L "$bridge_receipt" ]] || {
  printf 'Verified Bridge receipt is missing. Re-run Receive-BridgeJob.ps1; nothing was copied.\n' >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  printf 'python3 is required for the read-only payload verification. Nothing was copied.\n' >&2
  exit 1
}
verification_python=$(command -v python3)
payload_verification=$(
  cd -- "$job_root"
  PYTHONDONTWRITEBYTECODE=1 "$verification_python" -B \
    inputs/scripts/linux/verify_release_payload.py \
    --payload-root "$job_root" \
    --bridge-receipt "$bridge_receipt"
) || {
  printf 'Release payload verification failed. Nothing was copied.\n' >&2
  exit 1
}
printf 'PASS read-only Release payload verification: %s\n' "$payload_verification"

required_sources=(
  "$input_root/product/unseen_local_product.py"
  "$input_root/product/pipeline_runner.py"
  "$schema_source/job.schema.json"
  "$schema_source/result.schema.json"
  "$schema_source/queue-state.schema.json"
  "$input_root/fixtures/360roam/source-manifest.json"
  "$script_dir/install-local-product.sh"
  "$script_dir/start-local-product.sh"
  "$script_dir/stop-local-product.sh"
  "$script_dir/doctor-local-product.sh"
  "$script_dir/bootstrap-dependencies.sh"
  "$script_dir/cleanup-private-media.sh"
  "$script_dir/dry-run-local-product.sh"
  "$script_dir/download_360roam_fixture.py"
  "$script_dir/run-v15-integration-canary.sh"
  "$script_dir/run_v15_full_canary.py"
  "$script_dir/verify_release_payload.py"
  "$dependencies/SHA256SUMS"
  "$dependencies/DEPENDENCIES.md"
  "$dependencies/python-cu121.lock"
  "$dependencies/nerfstudio-1.1.5-py3-none-any.whl"
  "$dependencies/splat-transform/package.json"
  "$dependencies/splat-transform/package-lock.json"
  "$viewer_source/index.html"
  "$viewer_source/styles.css"
  "$viewer_source/app.js"
  "$viewer_source/scene.schema.json"
  "$viewer_source/vendor/playcanvas.min.mjs"
  "$viewer_source/vendor/PLAYCANVAS-LICENSE.txt"
)
for source_path in "${required_sources[@]}"; do
  [[ -f "$source_path" ]] || { printf 'Packaged input is missing: %s. Nothing was copied.\n' "$source_path" >&2; exit 1; }
done
command -v sha256sum >/dev/null 2>&1 || { printf 'sha256sum is required. Nothing was copied.\n' >&2; exit 1; }
(
  cd -- "$dependencies"
  sha256sum --check --strict SHA256SUMS
) || { printf 'Packaged dependency hash check failed. Nothing was copied.\n' >&2; exit 1; }

if [[ -x "$install_root/.venv/bin/python3" ]]; then
  python_bin="$install_root/.venv/bin/python3"
else
  python_bin="$verification_python"
fi

umask 077
mkdir -p \
  "$install_root/app" \
  "$install_root/runtime" \
  "$install_root/schemas" \
  "$install_root/fixtures/360roam" \
  "$install_root/dependencies/splat-transform" \
  "$install_root/tools/splat-transform" \
  "$install_root/viewer/vendor"

install -m 0700 "$input_root/product/unseen_local_product.py" "$install_root/app/unseen_local_product.py"
install -m 0700 "$input_root/product/pipeline_runner.py" "$install_root/app/pipeline_runner.py"
install -m 0600 "$input_root/fixtures/360roam/source-manifest.json" "$install_root/fixtures/360roam/source-manifest.json"
for schema_name in job.schema.json result.schema.json queue-state.schema.json; do
  install -m 0600 "$schema_source/$schema_name" "$install_root/schemas/$schema_name"
done
for script_name in \
  install-local-product.sh \
  start-local-product.sh \
  stop-local-product.sh \
  doctor-local-product.sh \
  bootstrap-dependencies.sh \
  cleanup-private-media.sh \
  dry-run-local-product.sh \
  download_360roam_fixture.py \
  run-v15-integration-canary.sh \
  run_v15_full_canary.py \
  verify_release_payload.py; do
  install -m 0700 "$script_dir/$script_name" "$install_root/app/$script_name"
done

install -m 0600 "$dependencies/SHA256SUMS" "$install_root/dependencies/SHA256SUMS"
install -m 0600 "$dependencies/DEPENDENCIES.md" "$install_root/dependencies/DEPENDENCIES.md"
install -m 0600 "$dependencies/python-cu121.lock" "$install_root/dependencies/python-cu121.lock"
install -m 0600 "$dependencies/nerfstudio-1.1.5-py3-none-any.whl" "$install_root/dependencies/nerfstudio-1.1.5-py3-none-any.whl"
install -m 0600 "$dependencies/splat-transform/package.json" "$install_root/dependencies/splat-transform/package.json"
install -m 0600 "$dependencies/splat-transform/package-lock.json" "$install_root/dependencies/splat-transform/package-lock.json"
install -m 0600 "$dependencies/splat-transform/package.json" "$install_root/tools/splat-transform/package.json"
install -m 0600 "$dependencies/splat-transform/package-lock.json" "$install_root/tools/splat-transform/package-lock.json"

for viewer_name in index.html styles.css app.js scene.schema.json; do
  install -m 0600 "$viewer_source/$viewer_name" "$install_root/viewer/$viewer_name"
done
install -m 0600 "$viewer_source/vendor/playcanvas.min.mjs" "$install_root/viewer/vendor/playcanvas.min.mjs"
install -m 0600 "$viewer_source/vendor/PLAYCANVAS-LICENSE.txt" "$install_root/viewer/vendor/PLAYCANVAS-LICENSE.txt"

"$python_bin" -m py_compile \
  "$install_root/app/unseen_local_product.py" \
  "$install_root/app/pipeline_runner.py" \
  "$install_root/app/verify_release_payload.py"
printf 'Installed packaged files without sudo, apt, network, firewall, services, tokens or media copies: %s\n' "$install_root"
if [[ ! -x "$install_root/.venv/bin/python3" ]]; then
  printf 'Dependencies are not installed yet. Explicit bootstrap command (uses apt and network):\n'
  printf '  %q --confirm-system-packages --install-root %q\n' "$install_root/app/bootstrap-dependencies.sh" "$install_root"
else
  printf 'Existing local virtual environment was preserved. Verify it with:\n'
  printf '  %q --product-root %q\n' "$install_root/app/doctor-local-product.sh" "$install_root"
fi
printf 'After DOCTOR_PASS, start with: %s/app/start-local-product.sh\n' "$install_root"
