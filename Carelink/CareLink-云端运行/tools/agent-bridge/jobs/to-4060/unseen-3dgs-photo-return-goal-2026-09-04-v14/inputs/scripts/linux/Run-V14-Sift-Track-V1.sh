#!/usr/bin/env bash
set -euo pipefail

confirm=""
project_root="/home/max/src/unseen-3dgs-sceneworker"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm-sift-track-v1)
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
  printf 'Rerun with --confirm-sift-track-v1 after reading GOAL.md.\n' >&2
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
builder="$script_dir/build_v14_sift_track_index.py"
candidate_source="$script_dir/localize_v14_sift_track.py"
challenge="$project_root/work/v14-photo-return-goal/challenge/challenge.json"
work_dir="$project_root/work/v14-photo-return-goal"
candidate_dir="$work_dir/candidate"
candidate="$candidate_dir/localize_v14_sift_track.py"
index_dir="$work_dir/index/sift-track-v1"
ledger="$work_dir/EXPERIMENTS.json"
state="$work_dir/STATE.json"

for required in "$builder" "$candidate_source" "$challenge" "$job_root/inputs/templates/EXPERIMENTS.json" "$job_root/inputs/templates/STATE.json"; do
  [[ -f "$required" ]] || { printf 'Missing required v14 starter input: %s\n' "$required" >&2; exit 2; }
done
if [[ -f "$project_root/.venv/bin/activate" ]]; then
  # shellcheck disable=SC1091
  source "$project_root/.venv/bin/activate"
fi
python3 -c 'import cv2, numpy; assert hasattr(cv2, "SIFT_create")' || {
  printf 'Existing v11 environment must provide NumPy and OpenCV SIFT. No package was installed.\n' >&2
  exit 2
}

mkdir -p "$candidate_dir" "$work_dir/index" "$work_dir/experiments"
if [[ -e "$candidate" ]] && ! cmp -s "$candidate_source" "$candidate"; then
  printf 'Preserving a different existing candidate: %s\nCopy the supplied method under a new versioned name.\n' "$candidate" >&2
  exit 2
fi
if [[ ! -e "$candidate" ]]; then
  cp "$candidate_source" "$candidate"
fi
[[ -f "$ledger" ]] || cp "$job_root/inputs/templates/EXPERIMENTS.json" "$ledger"
[[ -f "$state" ]] || cp "$job_root/inputs/templates/STATE.json" "$state"

export CUDA_VISIBLE_DEVICES=""
export PYTHONDONTWRITEBYTECODE=1
python3 "$builder" --challenge-manifest "$challenge" --index-dir "$index_dir"

experiment_id="sift-track-v1-$(date -u '+%Y%m%dT%H%M%SZ')"
experiment_dir="$work_dir/experiments/$experiment_id"
mkdir "$experiment_dir"

while IFS=$'\t' read -r run_id query_relative; do
  report="$experiment_dir/$run_id.json"
  set +e
  python3 "$candidate" \
    --challenge-manifest "$challenge" \
    --query "$(dirname "$challenge")/$query_relative" \
    --index-dir "$index_dir" \
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

python3 - "$experiment_dir" "$candidate" "$index_dir" "$ledger" "$state" <<'PY'
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
        internally_ready = (
            report.get("geometricInliers", 0) >= 20
            and report.get("geometricInlierRatio", 0.0) >= 0.10
            and report.get("medianReprojectionPx", math.inf) <= 3.5
        )
        runs.append({
            "runId": run_id,
            "returnCode": codes.get(run_id),
            "status": "INTERNAL_GEOMETRY_READY" if internally_ready else "INTERNAL_GEOMETRY_FAIL",
            "geometricInliers": report.get("geometricInliers"),
            "geometricInlierRatio": report.get("geometricInlierRatio"),
            "medianReprojectionPx": report.get("medianReprojectionPx"),
            "reportSha256": sha256(path),
        })
    else:
        runs.append({"runId": run_id, "returnCode": codes.get(run_id), "status": "NO_ESTIMATE"})
ready = len(runs) == 5 and all(row["status"] == "INTERNAL_GEOMETRY_READY" for row in runs)
next_decision = (
    "run the independent private-truth final gate; internal geometry alone does not prove pose accuracy"
    if ready else
    "inspect retrieval/per-reference match logs, then try a genuinely different covisibility or learned local-feature method"
)
summary = {
    "schemaVersion": "1.0",
    "experimentId": experiment_dir.name,
    "method": "training-pose-epipolar-sift-track-v1",
    "hypothesis": "exact training keypoint tracks plus known-pose epipolar filtering remove the false 2D-3D associations seen in v13",
    "status": "READY_FOR_PRIVATE_FINAL_GATE" if ready else "METHOD_MISS_CONTINUE_GOAL",
    "implementationSha256": sha256(candidate),
    "indexTreeSha256": tree_sha256(index_dir),
    "gpuInferenceRuns": 0,
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
    "algorithmFinalGate": "READY_TO_RUN" if ready else "PENDING",
    "lastExperimentId": summary["experimentId"],
    "nextDecision": next_decision,
})
state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"status": summary["status"], "experiment": str(experiment_dir), "nextDecision": next_decision}, indent=2))
PY

printf '\nSIFT track v1 evidence is recorded. The goal remains RUNNING until private scoring 5/5 and Viewer 5/5.\n'
printf 'Safe ledgers to review and push: %s and %s\n' "$ledger" "$state"
