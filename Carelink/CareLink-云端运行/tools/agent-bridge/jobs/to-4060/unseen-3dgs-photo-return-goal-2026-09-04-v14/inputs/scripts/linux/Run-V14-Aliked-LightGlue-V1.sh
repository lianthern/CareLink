#!/usr/bin/env bash
set -euo pipefail

confirm=""
project_root="/home/max/src/unseen-3dgs-sceneworker"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-learned-local-feature)
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
  printf 'Rerun with --confirm-learned-local-feature after reading GOAL.md.\n' >&2
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
  printf 'Project root must be a real WSL ext4 directory: %s\n' "$project_root" >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
job_root=$(cd -- "$script_dir/../../.." && pwd -P)
work_dir="$project_root/work/v14-photo-return-goal"
challenge="$work_dir/challenge/challenge.json"
sift_index="$work_dir/index/sift-track-v1"
learned_index="$work_dir/index/aliked-lightglue-v1"
deps_dir="$work_dir/deps"
lightglue_root="$deps_dir/LightGlue-eb42fee"
kornia_root="$deps_dir/kornia-v0.6.12"
torch_home="$deps_dir/torch-cache"
checkpoint_dir="$torch_home/hub/checkpoints"
builder="$script_dir/build_v14_aliked_lightglue_index.py"
candidate_source="$script_dir/localize_v14_aliked_lightglue.py"
candidate_dir="$work_dir/candidate"
candidate="$candidate_dir/localize_v14_aliked_lightglue.py"
ledger="$work_dir/EXPERIMENTS.json"
state="$work_dir/STATE.json"

for required in "$challenge" "$sift_index/INDEX.json" "$builder" "$candidate_source" "$job_root/inputs/templates/EXPERIMENTS.json" "$job_root/inputs/templates/STATE.json"; do
  [[ -e "$required" ]] || { printf 'Missing required v14 learned-method input: %s\n' "$required" >&2; exit 2; }
done
if [[ -f "$project_root/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$project_root/.venv/bin/activate"
fi
python3 -c 'import cv2, numpy, torch, torchvision; assert torch.cuda.is_available()' || {
  printf 'Existing v11 environment must provide NumPy, OpenCV, torchvision and CUDA-enabled PyTorch. No system package was changed.\n' >&2
  exit 2
}

mkdir -p "$deps_dir" "$checkpoint_dir" "$candidate_dir" "$work_dir/experiments"
if [[ ! -e "$lightglue_root" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/cvg/LightGlue.git "$lightglue_root"
  git -C "$lightglue_root" fetch --depth 1 origin eb42fee2d71449efb0aa5c10549752b5d75384d8
  git -C "$lightglue_root" checkout --detach eb42fee2d71449efb0aa5c10549752b5d75384d8
fi
[[ "$(git -C "$lightglue_root" rev-parse HEAD)" == "eb42fee2d71449efb0aa5c10549752b5d75384d8" ]] || {
  printf 'Existing LightGlue checkout is not the pinned commit: %s\n' "$lightglue_root" >&2
  exit 2
}
printf '0e6031ed3e62dc91dc8b1c8f240abd200b1083f60773362e64e339fe01d1bf18  %s\n' "$lightglue_root/LICENSE" | sha256sum --check --status || {
  printf 'Pinned LightGlue LICENSE hash mismatch.\n' >&2
  exit 2
}
if [[ ! -e "$kornia_root" ]]; then
  git clone --filter=blob:none --no-checkout https://github.com/kornia/kornia.git "$kornia_root"
  git -C "$kornia_root" fetch --depth 1 origin bfb2a8370de15813ddaa4846979c47cd2198f8b3
  git -C "$kornia_root" checkout --detach bfb2a8370de15813ddaa4846979c47cd2198f8b3
fi
[[ "$(git -C "$kornia_root" rev-parse HEAD)" == "bfb2a8370de15813ddaa4846979c47cd2198f8b3" ]] || {
  printf 'Existing Kornia checkout is not the pinned commit: %s\n' "$kornia_root" >&2
  exit 2
}
printf 'a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9  %s\n' "$kornia_root/LICENSE" | sha256sum --check --status || {
  printf 'Pinned Kornia LICENSE hash mismatch.\n' >&2
  exit 2
}

download_weight() {
  local url="$1"
  local output="$2"
  local expected="$3"
  if [[ -f "$output" ]] && printf '%s  %s\n' "$expected" "$output" | sha256sum --check --status; then
    return
  fi
  if [[ -e "$output" ]]; then
    printf 'Refusing to overwrite an unverified weight: %s\n' "$output" >&2
    exit 2
  fi
  curl --proto '=https' --tlsv1.2 --fail --location --show-error --output "$output.download" "$url"
  printf '%s  %s\n' "$expected" "$output.download" | sha256sum --check --status || {
    printf 'Downloaded weight hash mismatch: %s\n' "$url" >&2
    exit 2
  }
  mv "$output.download" "$output"
}

download_weight \
  https://github.com/Shiaoming/ALIKED/raw/main/models/aliked-n16.pth \
  "$checkpoint_dir/aliked-n16.pth" \
  5be8704840ed662d9d8c561bf7279c222092674e7eb05fd0feab94899e9d82f2
download_weight \
  https://github.com/cvg/LightGlue/releases/download/v0.1_arxiv/aliked_lightglue.pth \
  "$checkpoint_dir/aliked_lightglue_v0-1_arxiv.pth" \
  d975e965b105311a6143194852297dff4f02aea5cc2e10cecfed966ca0e22503

if [[ -e "$candidate" ]] && ! cmp -s "$candidate_source" "$candidate"; then
  printf 'Preserving a different existing candidate: %s\n' "$candidate" >&2
  exit 2
fi
[[ -e "$candidate" ]] || cp "$candidate_source" "$candidate"
[[ -f "$ledger" ]] || cp "$job_root/inputs/templates/EXPERIMENTS.json" "$ledger"
[[ -f "$state" ]] || cp "$job_root/inputs/templates/STATE.json" "$state"

export V14_LIGHTGLUE_ROOT="$lightglue_root"
export V14_KORNIA_ROOT="$kornia_root"
export TORCH_HOME="$torch_home"
export PYTHONPATH="$lightglue_root:$kornia_root${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1
export CUDA_VISIBLE_DEVICES=0

python3 "$builder" \
  --challenge-manifest "$challenge" \
  --sift-index-dir "$sift_index" \
  --index-dir "$learned_index" \
  --lightglue-root "$lightglue_root" \
  --kornia-root "$kornia_root" \
  --device cuda

experiment_id="aliked-lightglue-v1-$(date -u '+%Y%m%dT%H%M%SZ')"
experiment_dir="$work_dir/experiments/$experiment_id"
mkdir "$experiment_dir"

while IFS=$'\t' read -r run_id query_relative; do
  report="$experiment_dir/$run_id.json"
  set +e
  python3 "$candidate" \
    --challenge-manifest "$challenge" \
    --query "$(dirname "$challenge")/$query_relative" \
    --index-dir "$learned_index" \
    --report "$report" \
    --run-id "$run_id" \
    >"$experiment_dir/$run_id.stdout.log" \
    2>"$experiment_dir/$run_id.stderr.log"
  return_code=$?
  set -e
  printf '%s\t%s\n' "$run_id" "$return_code" >>"$experiment_dir/return-codes.tsv"
done < <(python3 - "$challenge" <<'PY'
import json
import sys
from pathlib import Path

manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
for row in manifest["queryVariants"]:
    print(f'{row["runId"]}\t{row["path"]}')
PY
)

python3 - "$experiment_dir" "$candidate" "$learned_index" "$ledger" "$state" <<'PY'
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

experiment_dir, candidate, index_dir, ledger_path, state_path = map(Path, sys.argv[1:])

def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def tree_sha256(root):
    digest = hashlib.sha256()
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix().encode()
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(bytes.fromhex(sha256(path)))
    return digest.hexdigest()

codes = {}
for line in (experiment_dir / "return-codes.tsv").read_text(encoding="utf-8").splitlines():
    run_id, value = line.split("\t")
    codes[run_id] = int(value)
runs = []
for index in range(1, 6):
    run_id = f"final-{index:02d}"
    path = experiment_dir / f"{run_id}.json"
    if path.is_file():
        report = json.loads(path.read_text(encoding="utf-8"))
        ready = (
            report.get("geometricInliers", 0) >= 20
            and report.get("geometricInlierRatio", 0.0) >= 0.10
            and report.get("medianReprojectionPx", math.inf) <= 3.5
        )
        runs.append({
            "runId": run_id,
            "returnCode": codes.get(run_id),
            "status": "INTERNAL_GEOMETRY_READY" if ready else "INTERNAL_GEOMETRY_FAIL",
            "selection": report.get("selection"),
            "seedReferenceId": report.get("seedReferenceId"),
            "clusterReferenceIds": report.get("clusterReferenceIds"),
            "associationRadiusPx": report.get("associationRadiusPx"),
            "geometricInliers": report.get("geometricInliers"),
            "geometricInlierRatio": report.get("geometricInlierRatio"),
            "medianReprojectionPx": report.get("medianReprojectionPx"),
            "gpuFeatureExtractionImages": report.get("gpuFeatureExtractionImages"),
            "gpuMatcherPairs": report.get("gpuMatcherPairs"),
            "reportSha256": sha256(path),
        })
    else:
        runs.append({"runId": run_id, "returnCode": codes.get(run_id), "status": "NO_ESTIMATE"})
all_ready = len(runs) == 5 and all(row["status"] == "INTERNAL_GEOMETRY_READY" for row in runs)
next_decision = (
    "freeze this implementation/index and run the independent private final gate"
    if all_ready else
    "inspect learned-match association/PnP evidence and continue the active goal with dense matching or a learned-map rebuild"
)
summary = {
    "schemaVersion": "1.0",
    "experimentId": experiment_dir.name,
    "method": "aliked-lightglue-to-training-sift-tracks-v1",
    "hypothesis": "learned ALIKED+LightGlue query/reference correspondences can recover the low-texture query when classical descriptor matching cannot, while PnP still uses immutable training-only triangulated tracks",
    "status": "READY_FOR_PRIVATE_FINAL_GATE" if all_ready else "METHOD_MISS_CONTINUE_GOAL",
    "implementationSha256": sha256(candidate),
    "indexTreeSha256": tree_sha256(index_dir),
    "dependencies": [{
        "name": "cvg/LightGlue + ALIKED",
        "commit": "eb42fee2d71449efb0aa5c10549752b5d75384d8",
        "license": "Apache-2.0; ALIKED BSD-3-Clause per upstream README",
        "alikedWeightSha256": "5be8704840ed662d9d8c561bf7279c222092674e7eb05fd0feab94899e9d82f2",
        "lightglueWeightSha256": "d975e965b105311a6143194852297dff4f02aea5cc2e10cecfed966ca0e22503",
    }],
    "gpuInferenceProcesses": 6,
    "gpuFeatureExtractionImages": 450 + sum(int(row.get("gpuFeatureExtractionImages") or 0) for row in runs),
    "gpuMatcherPairs": sum(int(row.get("gpuMatcherPairs") or 0) for row in runs),
    "gpuTrainingRuns": 0,
    "groundTruthRead": False,
    "hardcodedPoseUsed": False,
    "runs": runs,
    "nextDecision": next_decision,
    "createdAt": datetime.now(timezone.utc).isoformat(),
}
(experiment_dir / "DEV-SUMMARY.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
if any(row.get("experimentId") == summary["experimentId"] for row in ledger.get("experiments", [])):
    raise RuntimeError("experiment id already exists in ledger")
ledger.setdefault("experiments", []).append(summary)
ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
state = json.loads(state_path.read_text(encoding="utf-8"))
state.update({
    "state": "RUNNING",
    "currentMethod": summary["method"],
    "algorithmFinalGate": "READY_TO_RUN" if all_ready else "PENDING",
    "lastExperimentId": summary["experimentId"],
    "nextDecision": next_decision,
})
state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": summary["status"], "experiment": str(experiment_dir), "nextDecision": next_decision}, indent=2))
PY

printf '\nALIKED+LightGlue evidence is recorded. If internally 5/5, run the private scorer before Viewer.\n'
printf 'If it misses, preserve the evidence and continue the Goal with a genuinely different dense/learned-map method.\n'
