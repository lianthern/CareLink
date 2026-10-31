#!/usr/bin/env python3
"""Truth-free ALIKED+LightGlue matching into immutable training-only 3D tracks."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

import cv2
import numpy as np


CHALLENGE_ID = "v14-fixed-real-panorama-photo-q2"
METHOD = "aliked-lightglue-to-training-sift-tracks-v1"
CV_TO_GL = np.diag([1.0, -1.0, -1.0, 1.0])
LIGHTGLUE_COMMIT = "eb42fee2d71449efb0aa5c10549752b5d75384d8"
LIGHTGLUE_LICENSE_SHA256 = "0e6031ed3e62dc91dc8b1c8f240abd200b1083f60773362e64e339fe01d1bf18"
KORNIA_COMMIT = "bfb2a8370de15813ddaa4846979c47cd2198f8b3"
KORNIA_LICENSE_SHA256 = "a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9"
ALIKED_WEIGHT_SHA256 = "5be8704840ed662d9d8c561bf7279c222092674e7eb05fd0feab94899e9d82f2"
LIGHTGLUE_WEIGHT_SHA256 = "d975e965b105311a6143194852297dff4f02aea5cc2e10cecfed966ca0e22503"
GLOBAL_TOP = 80
PER_VIEW_TOP = 28
MAX_RETRIEVED = 280
ASSOCIATION_RADII_PX = (3.0, 5.0, 8.0)
SEED_REFERENCES = 24
CLUSTER_REFERENCES = 9
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
        raise ValueError(f"unsafe relative path: {relative}")
    resolved = (root / path).resolve()
    if root.resolve() not in resolved.parents:
        raise ValueError(f"path escapes root: {relative}")
    return resolved


def global_descriptor(gray: np.ndarray) -> np.ndarray:
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    small -= float(np.mean(small))
    deviation = float(np.std(small))
    if deviation > 1e-6:
        small /= deviation
    values = cv2.dct(small)[:12, :12].reshape(-1)
    norm = float(np.linalg.norm(values))
    return (values / norm if norm > 1e-8 else values).astype(np.float32)


def retrieve_balanced(references: list[dict[str, Any]], query_descriptor: np.ndarray) -> list[int]:
    scored = []
    by_view: dict[str, list[tuple[float, int]]] = {}
    for reference in references:
        descriptor = reference.get("globalDescriptor")
        if descriptor is None:
            continue
        similarity = float(query_descriptor @ np.asarray(descriptor, dtype=np.float32))
        reference_id = int(reference["referenceId"])
        row = (similarity, reference_id)
        scored.append(row)
        by_view.setdefault(str(reference.get("virtualView", "unknown")), []).append(row)
    selected: list[int] = []
    seen: set[int] = set()
    for _, reference_id in sorted(scored, reverse=True)[:GLOBAL_TOP]:
        selected.append(reference_id)
        seen.add(reference_id)
    for rows in by_view.values():
        for _, reference_id in sorted(rows, reverse=True)[:PER_VIEW_TOP]:
            if reference_id not in seen:
                selected.append(reference_id)
                seen.add(reference_id)
    return selected[:MAX_RETRIEVED]


def nearest_track_associations(
    learned_points: np.ndarray,
    track_points: np.ndarray,
    radius_px: float,
) -> tuple[np.ndarray, np.ndarray]:
    if len(learned_points) == 0 or len(track_points) == 0:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.float32)
    chosen = np.full(len(learned_points), -1, dtype=np.int64)
    distances = np.full(len(learned_points), np.inf, dtype=np.float32)
    for start in range(0, len(learned_points), 512):
        block = learned_points[start:start + 512].astype(np.float32)
        squared = np.sum((block[:, None, :] - track_points[None, :, :].astype(np.float32)) ** 2, axis=2)
        indices = np.argmin(squared, axis=1)
        values = squared[np.arange(len(indices)), indices]
        valid = values <= radius_px * radius_px
        positions = np.arange(start, start + len(block))[valid]
        chosen[positions] = indices[valid]
        distances[positions] = np.sqrt(values[valid])
    return chosen, distances


def spatial_quota(
    rows: list[tuple[int, int, float, int]],
    query_points: np.ndarray,
    points_3d: np.ndarray,
    width: int,
    height: int,
) -> list[tuple[int, int, float, int]]:
    selected = []
    counts: dict[tuple[int, int], int] = {}
    used_query: set[int] = set()
    used_point: set[tuple[int, int, int]] = set()
    for row in sorted(rows, key=lambda value: value[2]):
        query_index, point_index, _, _ = row
        point_key = tuple(int(round(value * 1000.0)) for value in points_3d[point_index])
        if query_index in used_query or point_key in used_point:
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
        iterationsCount=10000,
        reprojectionError=5.0,
        confidence=0.999,
        flags=cv2.SOLVEPNP_EPNP,
    )
    if not success or inliers is None or len(inliers) < 4:
        return None
    indices = inliers.reshape(-1)
    object_inliers = object_points[indices]
    image_inliers = image_points[indices]
    if hasattr(cv2, "solvePnPRefineLM") and len(indices) >= 6:
        rvec, tvec = cv2.solvePnPRefineLM(object_inliers, image_inliers, matrix, None, rvec, tvec)
    projected, _ = cv2.projectPoints(object_inliers, rvec, tvec, matrix, None)
    errors = np.linalg.norm(projected.reshape(-1, 2) - image_inliers, axis=1)
    world_to_camera, _ = cv2.Rodrigues(rvec)
    camera_to_world = world_to_camera.T
    centre = -camera_to_world @ tvec.reshape(3)
    c2w_cv = np.eye(4, dtype=np.float64)
    c2w_cv[:3, :3] = camera_to_world
    c2w_cv[:3, 3] = centre
    return {
        "estimatedC2wOpenGL": c2w_cv @ CV_TO_GL,
        "geometricInliers": int(len(indices)),
        "geometricInlierRatio": float(len(indices) / len(selected)),
        "medianReprojectionPx": float(np.median(errors)),
        "correspondences": int(len(selected)),
    }


def verify_index(index_dir: Path, challenge_sha: str) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    index = json.loads((index_dir / "INDEX.json").read_text(encoding="utf-8"))
    if index.get("method") != METHOD or index.get("challengeManifestSha256") != challenge_sha:
        raise RuntimeError("learned index identity mismatch")
    if index.get("queryImagesOpened") != 0 or index.get("queryGroundTruthRead") is not False:
        raise RuntimeError("learned index is not training-only")
    arrays = {}
    for name in ("points3d.npy", "reference-ids.npy", "reference-keypoints.npy"):
        record = index.get("files", {}).get(name)
        path = index_dir / name
        if not record or not path.is_file() or path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise RuntimeError(f"core index file failed verification: {path}")
        arrays[name] = np.load(path, allow_pickle=False)
    if len(arrays["points3d.npy"]) != len(arrays["reference-ids.npy"]) or len(arrays["points3d.npy"]) != len(arrays["reference-keypoints.npy"]):
        raise RuntimeError("core index arrays have inconsistent lengths")
    return index, arrays


def dependency_paths(index_dir: Path) -> tuple[Path, Path, Path]:
    work_dir = index_dir.resolve().parent.parent
    lightglue_root = Path(os.environ.get(
        "V14_LIGHTGLUE_ROOT", work_dir / "deps" / "LightGlue-eb42fee"
    )).resolve()
    kornia_root = Path(os.environ.get(
        "V14_KORNIA_ROOT", work_dir / "deps" / "kornia-v0.6.12"
    )).resolve()
    torch_home = Path(os.environ.get(
        "TORCH_HOME", work_dir / "deps" / "torch-cache"
    )).resolve()
    return lightglue_root, kornia_root, torch_home


def load_stack(index_dir: Path):
    root, kornia_root, torch_home = dependency_paths(index_dir)
    sources = (
        (root, LIGHTGLUE_COMMIT, LIGHTGLUE_LICENSE_SHA256, "LightGlue"),
        (kornia_root, KORNIA_COMMIT, KORNIA_LICENSE_SHA256, "Kornia"),
    )
    for source_root, expected_revision, expected_license, name in sources:
        revision = subprocess.run(
            ["git", "-C", str(source_root), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
        ).stdout.strip()
        if revision != expected_revision or sha256(source_root / "LICENSE") != expected_license:
            raise RuntimeError(f"{name} source revision/license verification failed")
    checkpoint_dir = torch_home / "hub" / "checkpoints"
    weights = {
        "aliked-n16.pth": ALIKED_WEIGHT_SHA256,
        "aliked_lightglue_v0-1_arxiv.pth": LIGHTGLUE_WEIGHT_SHA256,
    }
    for name, digest in weights.items():
        path = checkpoint_dir / name
        if not path.is_file() or sha256(path) != digest:
            raise RuntimeError(f"model weight verification failed: {path}")
    sys.path.insert(0, str(kornia_root))
    sys.path.insert(0, str(root))
    os.environ["TORCH_HOME"] = str(torch_home)
    import torch
    from lightglue import ALIKED, LightGlue
    from lightglue.utils import load_image, rbd

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this learned-feature candidate")
    torch.set_grad_enabled(False)
    extractor = ALIKED(
        model_name="aliked-n16", max_num_keypoints=4096, detection_threshold=0.1, nms_radius=2
    ).eval().cuda()
    matcher = LightGlue(
        features="aliked",
        depth_confidence=-1,
        width_confidence=-1,
        filter_threshold=0.05,
    ).eval().cuda()
    return torch, extractor, matcher, load_image, rbd


def feature_tensors(record: dict[str, np.ndarray], torch):
    return {
        "keypoints": torch.from_numpy(record["keypoints"].astype(np.float32)).cuda()[None],
        "descriptors": torch.from_numpy(record["descriptors"].astype(np.float32)).cuda()[None],
        "image_size": torch.from_numpy(record["image_size"].astype(np.float32)).cuda()[None],
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
    if query_record is None or sha256(query_path) != query_record["sha256"] or args.run_id != query_record["runId"]:
        raise RuntimeError("query does not match the frozen run identity")
    index_dir = args.index_dir.resolve()
    index, arrays = verify_index(index_dir, sha256(challenge_path))

    image_gray = cv2.imread(str(query_path), cv2.IMREAD_GRAYSCALE)
    if image_gray is None:
        raise RuntimeError("cannot decode query")
    height, width = image_gray.shape[:2]
    intrinsics = challenge["intrinsics"]
    if (width, height) != (int(intrinsics["w"]), int(intrinsics["h"])):
        raise RuntimeError("query dimensions differ from frozen intrinsics")
    matrix = np.asarray([
        [float(intrinsics["flX"]), 0.0, float(intrinsics["cx"])],
        [0.0, float(intrinsics["flY"]), float(intrinsics["cy"])],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)

    torch, extractor, matcher, load_image, rbd = load_stack(index_dir)
    with torch.inference_mode():
        query_features_batched = extractor.extract(load_image(query_path).cuda())
        query_features = rbd(query_features_batched)
        query_points = query_features["keypoints"].detach().cpu().numpy().astype(np.float32)
        retrieved = retrieve_balanced(index["references"], global_descriptor(image_gray))
        points_3d = arrays["points3d.npy"]
        reference_ids = arrays["reference-ids.npy"]
        reference_keypoints = arrays["reference-keypoints.npy"]
        matches_by_reference: dict[int, dict[float, list[tuple[int, int, float, int]]]] = {}
        raw_matches_by_reference: dict[int, int] = {}

        for reference_id in retrieved:
            reference = index["references"][reference_id]
            relative = reference["featurePath"]
            feature_path = safe_path(index_dir, relative)
            record = index["files"].get(relative)
            if not record or feature_path.stat().st_size != record["bytes"] or sha256(feature_path) != record["sha256"]:
                raise RuntimeError(f"learned reference feature failed verification: {feature_path}")
            with np.load(feature_path, allow_pickle=False) as loaded:
                learned = {name: loaded[name] for name in ("keypoints", "descriptors", "image_size")}
            reference_features = feature_tensors(learned, torch)
            matched = rbd(matcher({"image0": query_features_batched, "image1": reference_features}))
            match_indices = matched["matches"].detach().cpu().numpy().astype(np.int64)
            match_scores = matched["scores"].detach().cpu().numpy().astype(np.float32)
            raw_matches_by_reference[reference_id] = int(len(match_indices))
            if len(match_indices) < 8:
                continue
            start = int(np.searchsorted(reference_ids, reference_id, side="left"))
            stop = int(np.searchsorted(reference_ids, reference_id, side="right"))
            if stop - start < 8:
                continue
            local_track_points = reference_keypoints[start:stop]
            learned_to_track: dict[float, tuple[np.ndarray, np.ndarray]] = {}
            matched_reference_points = learned["keypoints"][match_indices[:, 1]]
            for radius in ASSOCIATION_RADII_PX:
                learned_to_track[radius] = nearest_track_associations(
                    matched_reference_points, local_track_points, radius
                )
            radius_rows: dict[float, list[tuple[int, int, float, int]]] = {}
            for radius, (local_indices, pixel_distances) in learned_to_track.items():
                rows = []
                for match_offset, local_index in enumerate(local_indices):
                    if local_index < 0:
                        continue
                    query_index = int(match_indices[match_offset, 0])
                    point_index = start + int(local_index)
                    cost = float(1.0 - match_scores[match_offset] + 0.02 * pixel_distances[match_offset])
                    rows.append((query_index, point_index, cost, reference_id))
                if rows:
                    radius_rows[radius] = rows
            if radius_rows:
                matches_by_reference[reference_id] = radius_rows

        candidates: list[dict[str, Any]] = []
        for reference_id, radius_rows in matches_by_reference.items():
            for radius, rows in radius_rows.items():
                candidate = solve_pose(rows, query_points, points_3d, matrix, width, height)
                if candidate is not None:
                    candidate.update({
                        "selection": "single-reference",
                        "seedReferenceId": reference_id,
                        "clusterReferenceIds": [reference_id],
                        "associationRadiusPx": radius,
                    })
                    candidates.append(candidate)

        centres = {
            int(reference["referenceId"]): np.asarray(reference["centre"], dtype=np.float64)
            for reference in index["references"]
        }
        seeds = sorted(
            matches_by_reference,
            key=lambda value: max(len(rows) for rows in matches_by_reference[value].values()),
            reverse=True,
        )[:SEED_REFERENCES]
        available = list(matches_by_reference)
        for seed in seeds:
            seed_view = index["references"][seed].get("virtualView")
            same_view = [value for value in available if index["references"][value].get("virtualView") == seed_view]
            neighbours = sorted(
                same_view,
                key=lambda value: float(np.linalg.norm(centres[seed] - centres[value])),
            )[:CLUSTER_REFERENCES]
            for radius in ASSOCIATION_RADII_PX:
                rows = [
                    row
                    for reference_id in neighbours
                    for row in matches_by_reference[reference_id].get(radius, [])
                ]
                candidate = solve_pose(rows, query_points, points_3d, matrix, width, height)
                if candidate is not None:
                    candidate.update({
                        "selection": "same-view-covisibility-cluster",
                        "seedReferenceId": seed,
                        "clusterReferenceIds": neighbours,
                        "associationRadiusPx": radius,
                    })
                    candidates.append(candidate)

    if not candidates:
        raise RuntimeError("ALIKED+LightGlue produced no truth-free PnP candidate")
    best = max(candidates, key=pose_rank)
    report = {
        "schemaVersion": "1.0",
        "runId": args.run_id,
        "querySha256": query_record["sha256"],
        "groundTruthRead": False,
        "hardcodedPoseUsed": False,
        "cachedQueryPoseUsed": False,
        "method": METHOD,
        "dependencyCommit": LIGHTGLUE_COMMIT,
        "gpuFeatureExtractionImages": 1,
        "gpuMatcherPairs": int(len(retrieved)),
        "gpuTrainingRuns": 0,
        "queryKeypoints": int(len(query_points)),
        "retrievedReferences": int(len(retrieved)),
        "referencesWithRawMatches": int(sum(value >= 8 for value in raw_matches_by_reference.values())),
        "referencesWithTrackAssociations": int(len(matches_by_reference)),
        "poseCandidates": int(len(candidates)),
        "selection": best["selection"],
        "seedReferenceId": int(best["seedReferenceId"]),
        "clusterReferenceIds": [int(value) for value in best["clusterReferenceIds"]],
        "associationRadiusPx": float(best["associationRadiusPx"]),
        "geometricInliers": int(best["geometricInliers"]),
        "geometricInlierRatio": float(best["geometricInlierRatio"]),
        "medianReprojectionPx": float(best["medianReprojectionPx"]),
        "correspondences": int(best["correspondences"]),
        "estimatedC2wOpenGL": best["estimatedC2wOpenGL"].tolist(),
    }
    if not all(math.isfinite(float(report[key])) for key in ("geometricInlierRatio", "medianReprojectionPx")):
        raise RuntimeError("candidate metrics are non-finite")
    args.report.parent.mkdir(parents=True, exist_ok=True)
    if args.report.exists():
        raise RuntimeError(f"refusing to overwrite candidate report: {args.report}")
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "estimatedC2wOpenGL"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
