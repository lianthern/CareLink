#!/usr/bin/env python3
"""Run and independently score five clean-process localizations of one photo."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

import numpy as np


V12_SHA256 = "a4c4d152695e9b8f1b335d5ff0cb83952aa1e1bd64cd0f269079eaa6c2bc3273"
MIN_GEOMETRIC_INLIERS = 20
MIN_GEOMETRIC_INLIER_RATIO = 0.10
MAX_MEDIAN_REPROJECTION_PX = 3.5
MAX_TRANSLATION_ERROR_SCENE_FRACTION = 0.15
MAX_ROTATION_ERROR_DEGREES = 15.0
EXPECTED_RUN_IDS = [f"final-{index:02d}" for index in range(1, 6)]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_v12_module() -> Any:
    repo_root = Path(__file__).resolve().parents[6]
    path = repo_root / "jobs/to-4060/unseen-3dgs-360-photo-relocalization-2026-09-04-v12/inputs/scripts/linux/localize_v11_photos.py"
    if not path.is_file() or sha256(path) != V12_SHA256:
        raise RuntimeError(f"frozen v12 localizer missing or changed: {path}")
    spec = importlib.util.spec_from_file_location("frozen_v12_scorer_v14", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import frozen v12 scorer: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


V12 = load_v12_module()


def tree_sha256(root: Path) -> str:
    digest = hashlib.sha256()
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(bytes.fromhex(sha256(path)))
    return digest.hexdigest()


def rotation_error_degrees(predicted: np.ndarray, expected: np.ndarray) -> float:
    relative = predicted.T @ expected
    cosine = float(np.clip((np.trace(relative) - 1.0) / 2.0, -1.0, 1.0))
    return math.degrees(math.acos(cosine))


def score_pose(
    estimated_c2w_opengl: np.ndarray,
    expected_c2w_opengl: np.ndarray,
    scene_extent: float,
) -> dict[str, float]:
    translation_error = float(np.linalg.norm(estimated_c2w_opengl[:3, 3] - expected_c2w_opengl[:3, 3]))
    return {
        "translationError": translation_error,
        "translationErrorSceneFraction": translation_error / scene_extent,
        "rotationErrorDegrees": rotation_error_degrees(
            estimated_c2w_opengl[:3, :3], expected_c2w_opengl[:3, :3]
        ),
    }


def finite_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value))


def timeout_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    return value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value


def validate_estimate(estimate: dict[str, Any], run_id: str, query_sha256: str) -> np.ndarray:
    if estimate.get("schemaVersion") != "1.0" or estimate.get("runId") != run_id:
        raise ValueError("candidate report identity mismatch")
    if estimate.get("querySha256") != query_sha256:
        raise ValueError("candidate report query hash mismatch")
    if estimate.get("groundTruthRead") is not False or estimate.get("hardcodedPoseUsed") is not False:
        raise ValueError("candidate did not attest truth-free estimation")
    if estimate.get("cachedQueryPoseUsed") is not False:
        raise ValueError("candidate used a cached query pose")
    for key in ("geometricInliers", "geometricInlierRatio", "medianReprojectionPx"):
        if not finite_number(estimate.get(key)):
            raise ValueError(f"candidate metric missing or non-finite: {key}")
    pose = np.asarray(estimate.get("estimatedC2wOpenGL"), dtype=np.float64)
    if pose.shape != (4, 4) or not np.all(np.isfinite(pose)):
        raise ValueError("estimatedC2wOpenGL must be a finite 4x4 matrix")
    if not np.allclose(pose[3], np.asarray([0.0, 0.0, 0.0, 1.0]), atol=1e-7):
        raise ValueError("estimatedC2wOpenGL has an invalid homogeneous row")
    rotation = pose[:3, :3]
    if not np.allclose(rotation.T @ rotation, np.eye(3), atol=2e-3) or np.linalg.det(rotation) < 0.99:
        raise ValueError("estimated rotation is not a proper orthonormal rotation")
    return pose


def load_truth(dataset: Path) -> tuple[np.ndarray, float, str]:
    transforms_path = dataset / "transforms.json"
    transforms = json.loads(transforms_path.read_text(encoding="utf-8"))
    train_frames, val_frames = V12.validate_and_index(transforms)
    queries = V12.select_queries(val_frames)
    hard_query = queries[1]
    if Path(hard_query["file_path"]).stem != "val_1_0027__right":
        raise RuntimeError("frozen hard query identity changed")
    centres = np.asarray([V12.camera_cv(frame)[1] for frame in train_frames], dtype=np.float64)
    scene_extent = float(np.linalg.norm(centres.max(axis=0) - centres.min(axis=0)))
    return np.asarray(hard_query["transform_matrix"], dtype=np.float64), scene_extent, sha256(transforms_path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True, type=Path, help="Private scorer input; never passed to candidate")
    parser.add_argument("--challenge", required=True, type=Path)
    parser.add_argument("--implementation", required=True, type=Path)
    parser.add_argument("--implementation-sha256", required=True)
    parser.add_argument("--index-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    args = parser.parse_args()
    dataset = args.dataset.resolve()
    challenge_path = args.challenge.resolve()
    implementation = args.implementation.resolve()
    index_dir = args.index_dir.resolve()
    output = args.output.resolve()
    if output.exists():
        raise RuntimeError(f"refusing to overwrite an existing final gate: {output}")
    if not implementation.is_file() or sha256(implementation) != args.implementation_sha256:
        raise RuntimeError("candidate implementation is missing or does not match its frozen SHA256")
    if not index_dir.is_dir():
        raise RuntimeError("candidate index must be completely built and frozen before the final gate")
    if args.timeout_seconds < 30 or args.timeout_seconds > 3600:
        raise ValueError("timeout must be between 30 and 3600 seconds per clean run")

    challenge = json.loads(challenge_path.read_text(encoding="utf-8"))
    if challenge.get("challengeId") != "v14-fixed-real-panorama-photo-q2":
        raise RuntimeError("unexpected challenge identity")
    if challenge.get("queryGroundTruthIncluded") is not False:
        raise RuntimeError("challenge contains query ground truth")
    variants = challenge.get("queryVariants", [])
    if [row.get("runId") for row in variants] != EXPECTED_RUN_IDS:
        raise RuntimeError("final challenge must contain the five frozen variants in order")
    expected_pose, scene_extent, transforms_sha = load_truth(dataset)
    if transforms_sha != challenge.get("sourceTransformsSha256"):
        raise RuntimeError("challenge and private scorer dataset fingerprints differ")

    output.mkdir(parents=True)
    index_hash_before = tree_sha256(index_dir)
    runs = []
    environment = dict(os.environ)
    environment.pop("V14_SOURCE_DATASET", None)
    environment.pop("V14_QUERY_GROUND_TRUTH", None)
    environment["V14_QUERY_TRUTH_UNAVAILABLE"] = "1"
    environment["PYTHONHASHSEED"] = "0"

    for variant in variants:
        run_id = variant["runId"]
        query_path = (challenge_path.parent / variant["path"]).resolve()
        if challenge_path.parent not in query_path.parents:
            raise RuntimeError(f"challenge query path escapes the challenge root: {query_path}")
        if not query_path.is_file() or sha256(query_path) != variant["sha256"]:
            raise RuntimeError(f"challenge query failed SHA256 verification: {query_path}")
        run_dir = output / run_id
        run_dir.mkdir()
        estimate_path = run_dir / "estimate.json"
        command = [
            sys.executable,
            str(implementation),
            "--challenge-manifest", str(challenge_path),
            "--query", str(query_path),
            "--index-dir", str(index_dir),
            "--report", str(estimate_path),
            "--run-id", run_id,
        ]
        try:
            completed = subprocess.run(
                command,
                cwd=run_dir,
                env=environment,
                capture_output=True,
                text=True,
                timeout=args.timeout_seconds,
                check=False,
            )
            (run_dir / "stdout.log").write_text(completed.stdout, encoding="utf-8")
            (run_dir / "stderr.log").write_text(completed.stderr, encoding="utf-8")
            return_code = completed.returncode
            failure = None
        except subprocess.TimeoutExpired as exc:
            (run_dir / "stdout.log").write_text(timeout_text(exc.stdout), encoding="utf-8")
            (run_dir / "stderr.log").write_text(timeout_text(exc.stderr), encoding="utf-8")
            return_code = None
            failure = "timeout"

        record: dict[str, Any] = {
            "runId": run_id,
            "querySha256": variant["sha256"],
            "operation": variant["operation"],
            "processReturnCode": return_code,
            "failure": failure,
            "status": "FAIL",
        }
        try:
            if return_code != 0 or not estimate_path.is_file():
                raise ValueError("candidate process failed or did not write estimate.json")
            estimate = json.loads(estimate_path.read_text(encoding="utf-8"))
            pose = validate_estimate(estimate, run_id, variant["sha256"])
            score = score_pose(pose, expected_pose, scene_extent)
            record.update({
                "geometricInliers": int(estimate["geometricInliers"]),
                "geometricInlierRatio": float(estimate["geometricInlierRatio"]),
                "medianReprojectionPx": float(estimate["medianReprojectionPx"]),
                **score,
            })
            passed = (
                record["geometricInliers"] >= MIN_GEOMETRIC_INLIERS
                and record["geometricInlierRatio"] >= MIN_GEOMETRIC_INLIER_RATIO
                and record["medianReprojectionPx"] <= MAX_MEDIAN_REPROJECTION_PX
                and record["translationErrorSceneFraction"] <= MAX_TRANSLATION_ERROR_SCENE_FRACTION
                and record["rotationErrorDegrees"] <= MAX_ROTATION_ERROR_DEGREES
            )
            record["status"] = "PASS" if passed else "FAIL"
            if not passed:
                record["failure"] = "unchanged-threshold-not-met"
        except (ValueError, KeyError, json.JSONDecodeError) as exc:
            record["failure"] = str(exc)
        runs.append(record)

    index_hash_after = tree_sha256(index_dir)
    index_unchanged = index_hash_after == index_hash_before
    passed_count = sum(row["status"] == "PASS" for row in runs)
    all_passed = passed_count == 5 and index_unchanged
    report = {
        "schemaVersion": "1.0",
        "jobId": "unseen-3dgs-photo-return-goal-2026-09-04-v14",
        "challengeId": challenge["challengeId"],
        "implementationSha256": args.implementation_sha256,
        "indexSha256Before": index_hash_before,
        "indexSha256After": index_hash_after,
        "indexUnchanged": index_unchanged,
        "cleanProcessRunsExpected": 5,
        "cleanProcessRunsPassed": passed_count,
        "allPassed": all_passed,
        "thresholds": {
            "minGeometricInliers": MIN_GEOMETRIC_INLIERS,
            "minGeometricInlierRatio": MIN_GEOMETRIC_INLIER_RATIO,
            "maxMedianReprojectionPx": MAX_MEDIAN_REPROJECTION_PX,
            "maxTranslationErrorSceneFraction": MAX_TRANSLATION_ERROR_SCENE_FRACTION,
            "maxRotationErrorDegrees": MAX_ROTATION_ERROR_DEGREES,
        },
        "sceneExtent": scene_extent,
        "queryGroundTruthPassedToCandidate": False,
        "runs": runs,
    }
    (output / "FINAL-GATE.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"allPassed": all_passed, "runsPassed": passed_count, "report": str(output / 'FINAL-GATE.json')}, indent=2))
    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
