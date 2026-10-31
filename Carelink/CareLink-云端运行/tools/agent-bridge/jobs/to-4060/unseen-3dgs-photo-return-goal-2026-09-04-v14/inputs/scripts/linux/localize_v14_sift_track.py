#!/usr/bin/env python3
"""Truth-free v14 candidate using retrieved reference tracks and local PnP.

This program conforms to the final-gate CLI.  It reads only the challenge
manifest, one query image, and a training-only index.  Candidate selection is
based on geometric inliers and reprojection error; no scorer input or expected
query pose is available here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np


CHALLENGE_ID = "v14-fixed-real-panorama-photo-q2"
CV_TO_GL = np.diag([1.0, -1.0, -1.0, 1.0])
QUERY_FEATURES = 6000
RETRIEVAL_REFERENCES = 80
SEED_REFERENCES = 16
CLUSTER_REFERENCES = 7
MATCH_RATIO = 0.90
GRID_COLUMNS = 6
GRID_ROWS = 6
GRID_QUOTA = 8


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_path(root: Path, relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe challenge path: {relative}")
    resolved = (root / path).resolve()
    if root.resolve() not in resolved.parents:
        raise ValueError(f"challenge path escapes root: {relative}")
    return resolved


def root_sift(descriptors: np.ndarray | None) -> np.ndarray:
    if descriptors is None or not len(descriptors):
        return np.empty((0, 128), dtype=np.float32)
    values = np.asarray(descriptors, dtype=np.float32)
    l1 = np.sum(np.abs(values), axis=1, keepdims=True)
    return np.sqrt(values / np.maximum(l1, 1e-12)).astype(np.float32)


def global_descriptor(gray: np.ndarray) -> np.ndarray:
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    small -= float(np.mean(small))
    deviation = float(np.std(small))
    if deviation > 1e-6:
        small /= deviation
    values = cv2.dct(small)[:12, :12].reshape(-1)
    norm = float(np.linalg.norm(values))
    if norm > 1e-8:
        values /= norm
    return values.astype(np.float32)


def verify_index(index_dir: Path, challenge_sha: str) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    index_path = index_dir / "INDEX.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if index.get("schemaVersion") != "1.0" or index.get("challengeId") != CHALLENGE_ID:
        raise RuntimeError("unexpected index identity")
    if index.get("challengeManifestSha256") != challenge_sha:
        raise RuntimeError("index was built for a different challenge manifest")
    if index.get("queryImagesOpened") != 0 or index.get("queryGroundTruthRead") is not False:
        raise RuntimeError("index is not training-only")
    arrays = {}
    for name, record in index.get("files", {}).items():
        path = index_dir / name
        if not path.is_file() or path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise RuntimeError(f"index file failed verification: {path}")
        arrays[name] = np.load(path, allow_pickle=False)
    required = {"points3d.npy", "descriptors.npy", "reference-ids.npy", "reference-keypoints.npy", "quality.npy"}
    if set(arrays) != required:
        raise RuntimeError("index file set is incomplete or unexpected")
    count = len(arrays["points3d.npy"])
    if any(len(arrays[name]) != count for name in required):
        raise RuntimeError("index arrays have inconsistent lengths")
    return index, arrays


def mutual_matches(query: np.ndarray, reference: np.ndarray, ratio: float = MATCH_RATIO) -> list[tuple[int, int, float]]:
    if len(query) < 2 or len(reference) < 2:
        return []
    matcher_forward = cv2.FlannBasedMatcher(dict(algorithm=1, trees=6), dict(checks=160))
    matcher_reverse = cv2.FlannBasedMatcher(dict(algorithm=1, trees=6), dict(checks=160))
    forward = matcher_forward.knnMatch(query, reference, k=2)
    reverse = matcher_reverse.knnMatch(reference, query, k=2)
    reverse_best = {}
    for neighbours in reverse:
        if len(neighbours) >= 2:
            best, runner = neighbours[:2]
            if best.distance < ratio * runner.distance:
                reverse_best[best.queryIdx] = best.trainIdx
    rows = []
    for neighbours in forward:
        if len(neighbours) >= 2:
            best, runner = neighbours[:2]
            if best.distance < ratio * runner.distance and reverse_best.get(best.trainIdx) == best.queryIdx:
                rows.append((int(best.queryIdx), int(best.trainIdx), float(best.distance)))
    return rows


def spatial_quota(
    rows: list[tuple[int, int, float, int]],
    query_points: np.ndarray,
    points_3d: np.ndarray,
    width: int,
    height: int,
    quota: int = GRID_QUOTA,
) -> list[tuple[int, int, float, int]]:
    selected = []
    counts: dict[tuple[int, int], int] = {}
    used_query: set[int] = set()
    used_point: set[tuple[int, int, int]] = set()
    for row in sorted(rows, key=lambda value: value[2]):
        query_index, point_index, _, _ = row
        if query_index in used_query:
            continue
        point_key = tuple(int(round(value * 1000.0)) for value in points_3d[point_index])
        if point_key in used_point:
            continue
        x, y = query_points[query_index]
        cell = (
            min(GRID_COLUMNS - 1, max(0, int(x * GRID_COLUMNS / max(width, 1)))),
            min(GRID_ROWS - 1, max(0, int(y * GRID_ROWS / max(height, 1)))),
        )
        if counts.get(cell, 0) >= quota:
            continue
        counts[cell] = counts.get(cell, 0) + 1
        used_query.add(query_index)
        used_point.add(point_key)
        selected.append(row)
    return selected


def solve_pose(
    rows: list[tuple[int, int, float, int]],
    query_points: np.ndarray,
    points_3d: np.ndarray,
    matrix: np.ndarray,
    width: int,
    height: int,
) -> dict[str, Any] | None:
    selected = spatial_quota(rows, query_points, points_3d, width, height)
    if len(selected) < 8:
        return None
    object_points = np.asarray([points_3d[row[1]] for row in selected], dtype=np.float32)
    image_points = np.asarray([query_points[row[0]] for row in selected], dtype=np.float32)
    success, rvec, tvec, inliers = cv2.solvePnPRansac(
        object_points,
        image_points,
        matrix,
        None,
        iterationsCount=6000,
        reprojectionError=5.0,
        confidence=0.999,
        flags=cv2.SOLVEPNP_EPNP,
    )
    if not success or inliers is None or len(inliers) < 4:
        return None
    inlier_indices = inliers.reshape(-1)
    object_inliers = object_points[inlier_indices]
    image_inliers = image_points[inlier_indices]
    if hasattr(cv2, "solvePnPRefineLM") and len(inlier_indices) >= 6:
        rvec, tvec = cv2.solvePnPRefineLM(object_inliers, image_inliers, matrix, None, rvec, tvec)
    projected, _ = cv2.projectPoints(object_inliers, rvec, tvec, matrix, None)
    errors = np.linalg.norm(projected.reshape(-1, 2) - image_inliers, axis=1)
    world_to_camera, _ = cv2.Rodrigues(rvec)
    camera_to_world = world_to_camera.T
    centre = -camera_to_world @ tvec.reshape(3)
    c2w_cv = np.eye(4, dtype=np.float64)
    c2w_cv[:3, :3] = camera_to_world
    c2w_cv[:3, 3] = centre
    c2w_gl = c2w_cv @ CV_TO_GL
    return {
        "estimatedC2wOpenGL": c2w_gl,
        "geometricInliers": int(len(inlier_indices)),
        "geometricInlierRatio": float(len(inlier_indices) / len(selected)),
        "medianReprojectionPx": float(np.median(errors)),
        "correspondences": len(selected),
    }


def pose_rank(candidate: dict[str, Any]) -> tuple[float, float, float, float]:
    return (
        float(candidate["geometricInliers"]),
        float(candidate["geometricInlierRatio"]),
        -float(candidate["medianReprojectionPx"]),
        float(candidate["correspondences"]),
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--challenge-manifest", required=True, type=Path)
    parser.add_argument("--query", required=True, type=Path)
    parser.add_argument("--index-dir", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()

    challenge_path = args.challenge_manifest.resolve()
    challenge_root = challenge_path.parent
    challenge = json.loads(challenge_path.read_text(encoding="utf-8"))
    if challenge.get("challengeId") != CHALLENGE_ID or challenge.get("queryGroundTruthIncluded") is not False:
        raise RuntimeError("unexpected or truth-bearing challenge")
    query_path = args.query.resolve()
    if challenge_root not in query_path.parents:
        raise RuntimeError("query is outside the truth-free challenge")
    query_records = {safe_path(challenge_root, row["path"]): row for row in challenge.get("queryVariants", [])}
    query_record = query_records.get(query_path)
    if query_record is None or sha256(query_path) != query_record["sha256"]:
        raise RuntimeError("query does not match a frozen challenge variant")
    if args.run_id != query_record["runId"]:
        raise RuntimeError("run id and query variant identity differ")

    index, arrays = verify_index(args.index_dir.resolve(), sha256(challenge_path))
    image = cv2.imread(str(query_path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise RuntimeError("cannot decode query")
    height, width = image.shape[:2]
    expected_width = int(challenge["intrinsics"]["w"])
    expected_height = int(challenge["intrinsics"]["h"])
    if (width, height) != (expected_width, expected_height):
        raise RuntimeError("query dimensions differ from frozen intrinsics")
    matrix = np.asarray([
        [float(challenge["intrinsics"]["flX"]), 0.0, float(challenge["intrinsics"]["cx"])],
        [0.0, float(challenge["intrinsics"]["flY"]), float(challenge["intrinsics"]["cy"])],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)

    sift = cv2.SIFT_create(nfeatures=QUERY_FEATURES, contrastThreshold=0.004, edgeThreshold=24)
    keypoints, raw_descriptors = sift.detectAndCompute(image, None)
    query_points = np.asarray([keypoint.pt for keypoint in keypoints], dtype=np.float32)
    query_descriptors = root_sift(raw_descriptors)
    if len(query_descriptors) < 8:
        raise RuntimeError("query has fewer than eight local features")

    references = index["references"]
    global_query = global_descriptor(image)
    global_rows = []
    for reference in references:
        descriptor = reference.get("globalDescriptor")
        if descriptor is None:
            continue
        similarity = float(global_query @ np.asarray(descriptor, dtype=np.float32))
        global_rows.append((similarity, int(reference["referenceId"])))
    retrieved = [row[1] for row in sorted(global_rows, reverse=True)[:RETRIEVAL_REFERENCES]]

    points_3d = arrays["points3d.npy"]
    bank = arrays["descriptors.npy"]
    reference_ids = arrays["reference-ids.npy"]
    matches_by_reference: dict[int, list[tuple[int, int, float, int]]] = {}
    for reference_id in retrieved:
        start = int(np.searchsorted(reference_ids, reference_id, side="left"))
        stop = int(np.searchsorted(reference_ids, reference_id, side="right"))
        indices = np.arange(start, stop, dtype=np.int64)
        if len(indices) < 8:
            continue
        matches = mutual_matches(query_descriptors, bank[indices])
        if matches:
            matches_by_reference[reference_id] = [
                (query_index, int(indices[local_index]), distance, reference_id)
                for query_index, local_index, distance in matches
            ]

    candidates: list[dict[str, Any]] = []
    for reference_id, rows in matches_by_reference.items():
        candidate = solve_pose(rows, query_points, points_3d, matrix, width, height)
        if candidate is not None:
            candidate["selection"] = "single-reference"
            candidate["seedReferenceId"] = reference_id
            candidates.append(candidate)

    centres = {
        int(reference["referenceId"]): np.asarray(reference["centre"], dtype=np.float64)
        for reference in references
    }
    seeds = sorted(matches_by_reference, key=lambda value: len(matches_by_reference[value]), reverse=True)[:SEED_REFERENCES]
    available = list(matches_by_reference)
    for seed in seeds:
        neighbours = sorted(available, key=lambda value: float(np.linalg.norm(centres[seed] - centres[value])))[:CLUSTER_REFERENCES]
        rows = [row for reference_id in neighbours for row in matches_by_reference[reference_id]]
        candidate = solve_pose(rows, query_points, points_3d, matrix, width, height)
        if candidate is not None:
            candidate["selection"] = "local-reference-cluster"
            candidate["seedReferenceId"] = seed
            candidate["clusterReferenceIds"] = neighbours
            candidates.append(candidate)

    if not candidates:
        raise RuntimeError("no PnP candidate survived truth-free geometric matching")
    best = max(candidates, key=pose_rank)
    report = {
        "schemaVersion": "1.0",
        "runId": args.run_id,
        "querySha256": query_record["sha256"],
        "groundTruthRead": False,
        "hardcodedPoseUsed": False,
        "cachedQueryPoseUsed": False,
        "method": "training-pose-epipolar-sift-track-v1",
        "queryKeypoints": len(query_points),
        "retrievedReferences": len(retrieved),
        "referencesWithMutualMatches": len(matches_by_reference),
        "poseCandidates": len(candidates),
        "selection": best["selection"],
        "seedReferenceId": best["seedReferenceId"],
        "clusterReferenceIds": best.get("clusterReferenceIds", [best["seedReferenceId"]]),
        "geometricInliers": best["geometricInliers"],
        "geometricInlierRatio": best["geometricInlierRatio"],
        "medianReprojectionPx": best["medianReprojectionPx"],
        "correspondences": best["correspondences"],
        "estimatedC2wOpenGL": best["estimatedC2wOpenGL"].tolist(),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    if args.report.exists():
        raise RuntimeError(f"refusing to overwrite candidate report: {args.report}")
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "estimatedC2wOpenGL"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
