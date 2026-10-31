#!/usr/bin/env python3
"""Truth-free coarse localization by geometrically verified image retrieval.

This is deliberately a different fallback from 3D PnP.  It retrieves training
cameras by image content, requires mutual local matches to survive a robust
homography or fundamental-matrix check, and returns the pose of the strongest
verified training camera.  The private scorer, not this candidate, decides
whether that coarse pose is close enough to the held-out camera.
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
RETRIEVAL_REFERENCES = 100
MATCH_RATIO = 0.90
GRID_COLUMNS = 8
GRID_ROWS = 6
GRID_QUOTA = 10


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
        raise RuntimeError("index was built for a different challenge")
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
    count = len(arrays["descriptors.npy"])
    if any(len(arrays[name]) != count for name in required):
        raise RuntimeError("index arrays have inconsistent lengths")
    if [row.get("referenceId") for row in index.get("references", [])] != list(range(len(index.get("references", [])))):
        raise RuntimeError("index reference ids are not contiguous")
    return index, arrays


def mutual_matches(query: np.ndarray, reference: np.ndarray, ratio: float = MATCH_RATIO) -> list[tuple[int, int, float]]:
    if len(query) < 2 or len(reference) < 2:
        return []
    forward_matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=6), dict(checks=160))
    reverse_matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=6), dict(checks=160))
    forward = forward_matcher.knnMatch(query, reference, k=2)
    reverse = reverse_matcher.knnMatch(reference, query, k=2)
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
    matches: list[tuple[int, int, float]],
    query_points: np.ndarray,
    reference_points: np.ndarray,
    width: int,
    height: int,
) -> list[tuple[int, int, float]]:
    selected = []
    counts: dict[tuple[int, int], int] = {}
    used_query: set[int] = set()
    used_reference: set[tuple[int, int]] = set()
    for row in sorted(matches, key=lambda value: value[2]):
        query_index, reference_index, _ = row
        if query_index in used_query:
            continue
        reference_key = tuple(int(round(value * 4.0)) for value in reference_points[reference_index])
        if reference_key in used_reference:
            continue
        x, y = query_points[query_index]
        cell = (
            min(GRID_COLUMNS - 1, max(0, int(x * GRID_COLUMNS / max(width, 1)))),
            min(GRID_ROWS - 1, max(0, int(y * GRID_ROWS / max(height, 1)))),
        )
        if counts.get(cell, 0) >= GRID_QUOTA:
            continue
        counts[cell] = counts.get(cell, 0) + 1
        used_query.add(query_index)
        used_reference.add(reference_key)
        selected.append(row)
    return selected


def sampson_errors(fundamental: np.ndarray, first: np.ndarray, second: np.ndarray) -> np.ndarray:
    first_h = np.column_stack([np.asarray(first, dtype=np.float64), np.ones(len(first))])
    second_h = np.column_stack([np.asarray(second, dtype=np.float64), np.ones(len(second))])
    fx = (fundamental @ first_h.T).T
    ftx = (fundamental.T @ second_h.T).T
    numerator = np.sum(second_h * fx, axis=1) ** 2
    denominator = fx[:, 0] ** 2 + fx[:, 1] ** 2 + ftx[:, 0] ** 2 + ftx[:, 1] ** 2
    return np.sqrt(numerator / np.maximum(denominator, 1e-12))


def homography_errors(homography: np.ndarray, reference: np.ndarray, query: np.ndarray) -> np.ndarray:
    projected = cv2.perspectiveTransform(reference.reshape(-1, 1, 2).astype(np.float64), homography).reshape(-1, 2)
    return np.linalg.norm(projected - query, axis=1)


def robust_geometry(reference: np.ndarray, query: np.ndarray) -> dict[str, Any] | None:
    if len(reference) < 8 or len(reference) != len(query):
        return None
    models = []
    homography, mask_h = cv2.findHomography(
        reference,
        query,
        method=cv2.RANSAC,
        ransacReprojThreshold=3.0,
        maxIters=10000,
        confidence=0.999,
    )
    if homography is not None and mask_h is not None:
        mask = mask_h.reshape(-1).astype(bool)
        errors = homography_errors(homography, reference, query)
        inlier_errors = errors[mask]
        if len(inlier_errors) >= 4 and np.isfinite(inlier_errors).all():
            models.append({
                "model": "homography-ransac",
                "inliers": int(len(inlier_errors)),
                "ratio": float(len(inlier_errors) / len(reference)),
                "medianErrorPx": float(np.median(inlier_errors)),
                "inlierIndices": np.where(mask)[0].tolist(),
            })
    fundamental, mask_f = cv2.findFundamentalMat(
        reference,
        query,
        method=cv2.FM_RANSAC,
        ransacReprojThreshold=1.5,
        confidence=0.999,
        maxIters=10000,
    )
    if fundamental is not None and mask_f is not None and fundamental.shape == (3, 3):
        mask = mask_f.reshape(-1).astype(bool)
        errors = sampson_errors(fundamental, reference, query)
        inlier_errors = errors[mask]
        if len(inlier_errors) >= 8 and np.isfinite(inlier_errors).all():
            models.append({
                "model": "fundamental-ransac",
                "inliers": int(len(inlier_errors)),
                "ratio": float(len(inlier_errors) / len(reference)),
                "medianErrorPx": float(np.median(inlier_errors)),
                "inlierIndices": np.where(mask)[0].tolist(),
            })
    if not models:
        return None
    return max(models, key=lambda row: (row["inliers"], row["ratio"], -row["medianErrorPx"]))


def finite_pose(value: Any) -> np.ndarray:
    pose = np.asarray(value, dtype=np.float64)
    if pose.shape != (4, 4) or not np.isfinite(pose).all():
        raise ValueError("selected training pose is invalid")
    if not np.allclose(pose[3], np.asarray([0.0, 0.0, 0.0, 1.0]), atol=1e-7):
        raise ValueError("selected training pose has invalid homogeneous row")
    rotation = pose[:3, :3]
    if not np.allclose(rotation.T @ rotation, np.eye(3), atol=2e-3) or np.linalg.det(rotation) < 0.99:
        raise ValueError("selected training rotation is invalid")
    return pose


def fixed_pose_reprojection(
    estimated_c2w_opengl: np.ndarray,
    points_3d: np.ndarray,
    query_points: np.ndarray,
    matrix: np.ndarray,
    robust_inlier_indices: list[int],
    max_error_px: float = 5.0,
) -> dict[str, Any] | None:
    if len(points_3d) != len(query_points) or len(robust_inlier_indices) < 4:
        return None
    c2w_cv = estimated_c2w_opengl @ CV_TO_GL
    camera_to_world = c2w_cv[:3, :3]
    centre = c2w_cv[:3, 3]
    world_to_camera = camera_to_world.T
    translation = -world_to_camera @ centre
    camera = (world_to_camera @ np.asarray(points_3d, dtype=np.float64).T + translation[:, None]).T
    projected = np.full((len(camera), 2), np.nan, dtype=np.float64)
    positive = camera[:, 2] > 0.05
    projected[positive, 0] = matrix[0, 0] * camera[positive, 0] / camera[positive, 2] + matrix[0, 2]
    projected[positive, 1] = matrix[1, 1] * camera[positive, 1] / camera[positive, 2] + matrix[1, 2]
    errors = np.linalg.norm(projected - np.asarray(query_points, dtype=np.float64), axis=1)
    robust = np.zeros(len(errors), dtype=bool)
    robust[np.asarray(robust_inlier_indices, dtype=np.int32)] = True
    inliers = robust & positive & np.isfinite(errors) & (errors <= max_error_px)
    if np.count_nonzero(inliers) < 4:
        return None
    inlier_errors = errors[inliers]
    return {
        "geometricInliers": int(len(inlier_errors)),
        "geometricInlierRatio": float(len(inlier_errors) / len(errors)),
        "medianReprojectionPx": float(np.median(inlier_errors)),
    }


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
    if (width, height) != (int(challenge["intrinsics"]["w"]), int(challenge["intrinsics"]["h"])):
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
    similarities = []
    for reference in references:
        descriptor = reference.get("globalDescriptor")
        if descriptor is not None:
            similarities.append((float(global_query @ np.asarray(descriptor, dtype=np.float32)), int(reference["referenceId"])))
    retrieved = sorted(similarities, reverse=True)[:RETRIEVAL_REFERENCES]
    descriptor_bank = arrays["descriptors.npy"]
    points_3d = arrays["points3d.npy"]
    reference_ids = arrays["reference-ids.npy"]
    reference_keypoints = arrays["reference-keypoints.npy"]
    candidates = []
    for similarity, reference_id in retrieved:
        start = int(np.searchsorted(reference_ids, reference_id, side="left"))
        stop = int(np.searchsorted(reference_ids, reference_id, side="right"))
        if stop - start < 8:
            continue
        local_descriptors = descriptor_bank[start:stop]
        local_keypoints = reference_keypoints[start:stop]
        matches = mutual_matches(query_descriptors, local_descriptors)
        matches = spatial_quota(matches, query_points, local_keypoints, width, height)
        if len(matches) < 8:
            continue
        reference_points = np.asarray([local_keypoints[row[1]] for row in matches], dtype=np.float32)
        matched_query_points = np.asarray([query_points[row[0]] for row in matches], dtype=np.float32)
        geometry = robust_geometry(reference_points, matched_query_points)
        if geometry is None:
            continue
        estimated_pose = finite_pose(references[reference_id]["transformMatrixOpenGL"])
        global_point_indices = np.asarray([start + row[1] for row in matches], dtype=np.int64)
        reprojection = fixed_pose_reprojection(
            estimated_pose,
            points_3d[global_point_indices],
            matched_query_points,
            matrix,
            geometry["inlierIndices"],
        )
        if reprojection is None:
            continue
        candidates.append({
            **geometry,
            **reprojection,
            "referenceId": reference_id,
            "globalSimilarity": similarity,
            "mutualMatches": len(matches),
        })
    if not candidates:
        raise RuntimeError("no retrieved training camera survived local geometric verification")
    best = max(
        candidates,
        key=lambda row: (
            row["geometricInliers"],
            row["geometricInlierRatio"],
            row["globalSimilarity"],
            -row["medianReprojectionPx"],
        ),
    )
    selected_reference = references[int(best["referenceId"])]
    estimated_pose = finite_pose(selected_reference["transformMatrixOpenGL"])
    report = {
        "schemaVersion": "1.0",
        "runId": args.run_id,
        "querySha256": query_record["sha256"],
        "groundTruthRead": False,
        "hardcodedPoseUsed": False,
        "cachedQueryPoseUsed": False,
        "method": "content-verified-nearest-training-camera-v1",
        "poseSource": "strongest-content-and-geometry-verified-training-camera",
        "queryKeypoints": len(query_points),
        "retrievedReferences": len(retrieved),
        "geometricallyVerifiedReferences": len(candidates),
        "selectedReferenceId": best["referenceId"],
        "selectedGeometryModel": best["model"],
        "selectedModelInliers": best["inliers"],
        "selectedModelInlierRatio": best["ratio"],
        "selectedModelMedianErrorPx": best["medianErrorPx"],
        "selectedGlobalSimilarity": best["globalSimilarity"],
        "selectedMutualMatches": best["mutualMatches"],
        "geometricInliers": best["geometricInliers"],
        "geometricInlierRatio": best["geometricInlierRatio"],
        "medianReprojectionPx": best["medianReprojectionPx"],
        "estimatedC2wOpenGL": estimated_pose.tolist(),
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    if args.report.exists():
        raise RuntimeError(f"refusing to overwrite candidate report: {args.report}")
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "estimatedC2wOpenGL"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
