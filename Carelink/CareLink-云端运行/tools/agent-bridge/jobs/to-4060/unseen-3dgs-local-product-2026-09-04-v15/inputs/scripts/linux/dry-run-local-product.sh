#!/usr/bin/env bash
set -euo pipefail

install_root="/home/max/src/unseen-local-product"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-root) install_root="${2:?missing --install-root value}"; shift 2 ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

runner="$install_root/app/pipeline_runner.py"
if [[ ! -f "$runner" ]]; then
  script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
  runner=$(cd -- "$script_dir/../../product" && pwd -P)/pipeline_runner.py
fi
[[ -f "$runner" ]] || { printf 'Missing pipeline runner: %s\n' "$runner" >&2; exit 1; }
if [[ -x "$install_root/.venv/bin/python3" ]]; then
  runtime_python="$install_root/.venv/bin/python3"
elif [[ -x /home/max/src/unseen-3dgs-sceneworker/.venv/bin/python3 ]]; then
  runtime_python=/home/max/src/unseen-3dgs-sceneworker/.venv/bin/python3
else
  printf 'Missing the product or verified PoC Python environment; jsonschema 4.26.0 validation cannot be bypassed.\n' >&2
  exit 1
fi

scratch=$(mktemp -d /tmp/unseen-v15-dry-run.XXXXXX)
cleanup() {
  case "$scratch" in /tmp/unseen-v15-dry-run.*) rm -rf -- "$scratch" ;; esac
}
trap cleanup EXIT
printf 'dry-run fixture only\n' > "$scratch/input.mp4"
input_sha=$(sha256sum "$scratch/input.mp4" | awk '{print $1}')
"$runtime_python" - "$scratch/job.json" "$scratch" "$input_sha" <<'PY'
import json
import sys
from pathlib import Path

job_path, root, digest = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
spec = {
    "schemaVersion": "1.0",
    "jobId": "job-deadbeef0001",
    "kind": "scene_preview",
    "scene": {
        "id": "scene-deadbeef0001",
        "revision_id": "scene-deadbeef0001-r001",
        "display_name": "static-dry-run.mp4",
        "source_path": str(root / "input.mp4"),
        "source_sha256": digest,
        "bytes": (root / "input.mp4").stat().st_size,
        "width": 4096,
        "height": 2048,
        "duration_seconds": 79.5,
        "state": "queued",
        "result": None,
        "error": None,
        "created_at": "1970-01-01T00:00:00Z",
        "updated_at": "1970-01-01T00:00:00Z",
    },
    "inputPath": str(root / "input.mp4"),
    "inputSha256": digest,
    "productRoot": str(root / "product"),
    "workDir": str(root / "work"),
    "progressPath": str(root / "progress.json"),
    "resultPath": str(root / "result.json"),
}
job_path.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")
PY

"$runtime_python" "$runner" --job-spec "$scratch/job.json" --dry-run | tee "$scratch/dry-run.log"
awk 'found || /^\{/ {found=1; print}' "$scratch/dry-run.log" > "$scratch/commands.json"
"$runtime_python" - "$scratch/commands.json" <<'PY'
import json
import sys

result = json.load(open(sys.argv[1], encoding="utf-8"))
commands = result["commands"]
flat = [" ".join(command) for command in commands]
required = {
    "ffmpeg v360 projection": lambda row: "v360=input=equirect:output=flat" in row,
    "fixed 100-degree PINHOLE intrinsics": lambda row: "feature_extractor" in row and "PINHOLE" in row and "429.619011" in row,
    "unknown-pose exhaustive matching": lambda row: "exhaustive_matcher" in row,
    "largest-model Nerfstudio conversion": lambda row: "ns-process-data" in row and "--skip-colmap" in row,
    "fixed 7000 preview": lambda row: "ns-train" in row and "--max-num-iterations 7000" in row,
    "gaussian export": lambda row: "ns-export gaussian-splat" in row,
    "bounded SOG conversion": lambda row: "splat-transform" in row and "-g cpu -H 1 -i 2" in row,
}
missing = [name for name, predicate in required.items() if not any(predicate(row) for row in flat)]
if missing:
    raise SystemExit("DRY_RUN_FAILED: " + ", ".join(missing))
print(f"DRY_RUN_PASS: {len(commands)} commands; no CUDA, media decode, training or network call executed")
PY
