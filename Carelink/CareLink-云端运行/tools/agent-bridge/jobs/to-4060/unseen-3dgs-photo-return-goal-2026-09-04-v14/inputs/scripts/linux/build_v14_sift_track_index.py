#!/usr/bin/env python3
"""Build a training-only SIFT track index for the v14 truth-free challenge.

The builder never opens a query image.  It triangulates exact SIFT observations
between nearby training cameras, rejects matches with the known training-camera
epipolar geometry, and stores one best 3D point per reference keypoint.  The
result is intentionally ordinary NumPy data so the final candidate is easy to
audit and does not need a model download.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import tempfile
from typing import Any

import cv2
import numpy as np


CHALLENGE_ID = "v14-fixed-real-panorama-photo-q2"
CV_TO_GL = np.diag([1.0, -1.0, -1.0, 1.0])
HORIZONTAL_FACES = (
    "front", "front_right", "right", "back_right",
    "back", "back_left", "left", "front_left",
)
SIFT_FEATURES = 4200
PAIR_NEIGHBOURS = 3
RATIO = 0.86
MAX_SAMPSON_ERROR_PX2 = 2.25
MAX_REPROJECTION_PX = 2.5


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_path(root: Path, relative: str) -> Path:
    candidate = Path(relative)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError(f"unsafe challenge path: {relative}")
    resolved = (root / candidate).resolve()
    if root.resolve() not in resolved.parents:
        raise ValueError(f"challenge path escapes root: {relative}")
    return resolved


def intrinsics(manifest: dict[str, Any]) -> np.ndarray:
    values = manifest["intrinsics"]
    matrix = np.asarray([
        [float(values["flX"]), 0.0, float(values["cx"])],
        [0.0, float(values["flY"]), float(values["cy"])],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)
    if not np.isfinite(matrix).all() or matrix[0, 0] <= 0 or matrix[1, 1] <= 0:
        raise ValueError("invalid challenge intrinsics")
    return matrix


def camera_cv(frame: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    c2w_gl = np.asarray(frame["transformMatrixOpenGL"], dtype=np.float64)
    if c2w_gl.shape != (4, 4) or not np.isfinite(c2w_gl).all():
        raise ValueError("invalid training camera transform")
    c2w_cv = c2w_gl @ CV_TO_GL
    camera_to_world = c2w_cv[:3, :3]
    centre = c2w_cv[:3, 3]
    world_to_camera = camera_to_world.T
    translation = -world_to_camera @ centre
    return camera_to_world, centre, world_to_camera, translation


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
    dct = cv2.dct(small)[:12, :12].reshape(-1)
    norm = float(np.linalg.norm(dct))
    if norm > 1e-8:
        dct /= norm
    return dct.astype(np.float32)


def fundamental_from_poses(first: dict[str, Any], second: dict[str, Any], matrix: np.ndarray) -> np.ndarray:
    _, _, rotation_a, translation_a = camera_cv(first)
    _, _, rotation_b, translation_b = camera_cv(second)
    relative_rotation = rotation_b @ rotation_a.T
    relative_translation = translation_b - relative_rotation @ translation_a
    tx = np.asarray([
        [0.0, -relative_translation[2], relative_translation[1]],
        [relative_translation[2], 0.0, -relative_translation[0]],
        [-relative_translation[1], relative_translation[0], 0.0],
    ], dtype=np.float64)
    inverse = np.linalg.inv(matrix)
    fundamental = inverse.T @ tx @ relative_rotation @ inverse
    norm = float(np.linalg.norm(fundamental))
    if norm <= 1e-12:
        raise ValueError("degenerate training-camera baseline")
    return fundamental / norm


def sampson_errors(fundamental: np.ndarray, first: np.ndarray, second: np.ndarray) -> np.ndarray:
    first_h = np.column_stack([np.asarray(first, dtype=np.float64), np.ones(len(first))])
    second_h = np.column_stack([np.asarray(second, dtype=np.float64), np.ones(len(second))])
    fx = (fundamental @ first_h.T).T
    ftx = (fundamental.T @ second_h.T).T
    numerator = np.sum(second_h * fx, axis=1) ** 2
    denominator = fx[:, 0] ** 2 + fx[:, 1] ** 2 + ftx[:, 0] ** 2 + ftx[:, 1] ** 2
    return numerator / np.maximum(denominator, 1e-12)


def mutual_ratio_matches(first: np.ndarray, second: np.ndarray, ratio: float = RATIO) -> list[tuple[int, int, float]]:
    if len(first) < 2 or len(second) < 2:
        return []
    forward_matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=6), dict(checks=128))
    reverse_matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=6), dict(checks=128))
    forward = forward_matcher.knnMatch(first, second, k=2)
    reverse = reverse_matcher.knnMatch(second, first, k=2)
    reverse_best = {}
    for neighbours in reverse:
        if len(neighbours) >= 2:
            best, runner = neighbours[:2]
            if best.distance < ratio * runner.distance:
                reverse_best[best.queryIdx] = best.trainIdx
    matches = []
    for neighbours in forward:
        if len(neighbours) >= 2:
            best, runner = neighbours[:2]
            if best.distance < ratio * runner.distance and reverse_best.get(best.trainIdx) == best.queryIdx:
                matches.append((int(best.queryIdx), int(best.trainIdx), float(best.distance)))
    return matches


def triangulate_pair(
    first_frame: dict[str, Any],
    second_frame: dict[str, Any],
    first_points: np.ndarray,
    second_points: np.ndarray,
    matrix: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    _, _, rotation_a, translation_a = camera_cv(first_frame)
    _, _, rotation_b, translation_b = camera_cv(second_frame)
    projection_a = matrix @ np.column_stack([rotation_a, translation_a])
    projection_b = matrix @ np.column_stack([rotation_b, translation_b])
    homogeneous = cv2.triangulatePoints(projection_a, projection_b, first_points.T, second_points.T)
    valid_w = np.abs(homogeneous[3]) > 1e-10
    points = np.zeros((len(first_points), 3), dtype=np.float64)
    points[valid_w] = (homogeneous[:3, valid_w] / homogeneous[3, valid_w]).T
    camera_a = (rotation_a @ points.T + translation_a[:, None]).T
    camera_b = (rotation_b @ points.T + translation_b[:, None]).T
    valid = valid_w & (camera_a[:, 2] > 0.05) & (camera_b[:, 2] > 0.05)
    projected_a = np.full_like(first_points, np.nan, dtype=np.float64)
    projected_b = np.full_like(second_points, np.nan, dtype=np.float64)
    for camera, projected in ((camera_a, projected_a), (camera_b, projected_b)):
        projected[:, 0] = matrix[0, 0] * camera[:, 0] / np.maximum(camera[:, 2], 1e-12) + matrix[0, 2]
        projected[:, 1] = matrix[1, 1] * camera[:, 1] / np.maximum(camera[:, 2], 1e-12) + matrix[1, 2]
    error_a = np.linalg.norm(projected_a - first_points, axis=1)
    error_b = np.linalg.norm(projected_b - second_points, axis=1)
    return points, valid, error_a + error_b


def load_and_verify_image(challenge_root: Path, frame: dict[str, Any]) -> np.ndarray:
    path = safe_path(challenge_root, frame["path"])
    if not path.is_file() or path.stat().st_size != int(frame["bytes"]) or sha256(path) != frame["sha256"]:
        raise RuntimeError(f"training image failed manifest verification: {path}")
    image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise RuntimeError(f"cannot decode training image: {path}")
    return image


def verify_existing(index_dir: Path, challenge_sha: str) -> dict[str, Any]:
    manifest_path = index_dir / "INDEX.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"existing index is incomplete; preserve and investigate: {index_dir}")
    index = json.loads(manifest_path.read_text(encoding="utf-8"))
    if index.get("schemaVersion") != "1.0" or index.get("challengeManifestSha256") != challenge_sha:
        raise RuntimeError("existing index identity mismatch")
    for name, record in index.get("files", {}).items():
        path = index_dir / name
        if not path.is_file() or path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise RuntimeError(f"existing index file failed verification: {path}")
    return index


def build(challenge_manifest: Path, index_dir: Path) -> dict[str, Any]:
    challenge_manifest = challenge_manifest.resolve()
    challenge_root = challenge_manifest.parent
    challenge_sha = sha256(challenge_manifest)
    if index_dir.exists():
        return verify_existing(index_dir, challenge_sha)
    manifest = json.loads(challenge_manifest.read_text(encoding="utf-8"))
    if manifest.get("challengeId") != CHALLENGE_ID or manifest.get("queryGroundTruthIncluded") is not False:
        raise RuntimeError("unexpected or truth-bearing challenge")
    training = manifest.get("training", [])
    if len(training) != 450 or manifest.get("queryVariantCount") != 5:
        raise RuntimeError("v14 challenge must contain the frozen 450/5 split")
    matrix = intrinsics(manifest)
    references = []
    for reference_id, frame in enumerate(training):
        _, centre, _, _ = camera_cv(frame)
        references.append({
            "referenceId": reference_id,
            "path": frame["path"],
            "sourcePanorama": frame.get("sourcePanorama"),
            "virtualView": frame.get("virtualView"),
            "centre": centre.tolist(),
            "transformMatrixOpenGL": frame["transformMatrixOpenGL"],
            "globalDescriptor": None,
        })

    observations: dict[tuple[int, int], tuple[np.ndarray, np.ndarray, np.ndarray, float]] = {}
    attempted_pairs = 0
    descriptor_matches = 0
    epipolar_inliers = 0
    triangulated = 0

    for face in HORIZONTAL_FACES:
        ids = [index for index, row in enumerate(training) if row.get("virtualView") == face]
        if len(ids) != 50:
            raise RuntimeError(f"expected 50 training references for {face}, got {len(ids)}")
        features: dict[int, tuple[np.ndarray, np.ndarray]] = {}
        for reference_id in ids:
            image = load_and_verify_image(challenge_root, training[reference_id])
            references[reference_id]["globalDescriptor"] = global_descriptor(image).tolist()
            sift = cv2.SIFT_create(nfeatures=SIFT_FEATURES, contrastThreshold=0.006, edgeThreshold=20)
            keypoints, descriptors = sift.detectAndCompute(image, None)
            points = np.asarray([keypoint.pt for keypoint in keypoints], dtype=np.float32)
            features[reference_id] = (points, root_sift(descriptors))

        centres = {reference_id: np.asarray(references[reference_id]["centre"], dtype=np.float64) for reference_id in ids}
        pair_set: set[tuple[int, int]] = set()
        all_centres = np.asarray([centres[reference_id] for reference_id in ids])
        scene_extent = float(np.linalg.norm(all_centres.max(axis=0) - all_centres.min(axis=0)))
        min_baseline = max(scene_extent * 0.002, 1e-6)
        for reference_id in ids:
            neighbours = sorted(
                (other for other in ids if other != reference_id),
                key=lambda other: float(np.linalg.norm(centres[reference_id] - centres[other])),
            )
            selected = [other for other in neighbours if np.linalg.norm(centres[reference_id] - centres[other]) > min_baseline][
                :PAIR_NEIGHBOURS
            ]
            pair_set.update(tuple(sorted((reference_id, other))) for other in selected)

        for first_id, second_id in sorted(pair_set):
            attempted_pairs += 1
            first_points, first_descriptors = features[first_id]
            second_points, second_descriptors = features[second_id]
            matches = mutual_ratio_matches(first_descriptors, second_descriptors)
            descriptor_matches += len(matches)
            if len(matches) < 8:
                continue
            indices_a = np.asarray([row[0] for row in matches], dtype=np.int32)
            indices_b = np.asarray([row[1] for row in matches], dtype=np.int32)
            points_a = first_points[indices_a]
            points_b = second_points[indices_b]
            try:
                fundamental = fundamental_from_poses(training[first_id], training[second_id], matrix)
            except ValueError:
                continue
            errors = sampson_errors(fundamental, points_a, points_b)
            keep_epipolar = errors <= MAX_SAMPSON_ERROR_PX2
            epipolar_inliers += int(np.count_nonzero(keep_epipolar))
            if np.count_nonzero(keep_epipolar) < 8:
                continue
            kept_rows = np.where(keep_epipolar)[0]
            points_3d, valid, reprojection_sum = triangulate_pair(
                training[first_id], training[second_id], points_a[kept_rows], points_b[kept_rows], matrix
            )
            valid &= reprojection_sum <= (2.0 * MAX_REPROJECTION_PX)
            triangulated += int(np.count_nonzero(valid))
            for local_index in np.where(valid)[0]:
                original_row = int(kept_rows[local_index])
                query_index, train_index, match_distance = matches[original_row]
                point = points_3d[local_index].astype(np.float32)
                quality = float(reprojection_sum[local_index] + errors[original_row] + match_distance)
                for reference_id, keypoint_index, descriptor, pixel in (
                    (first_id, query_index, first_descriptors[query_index], first_points[query_index]),
                    (second_id, train_index, second_descriptors[train_index], second_points[train_index]),
                ):
                    key = (reference_id, keypoint_index)
                    prior = observations.get(key)
                    if prior is None or quality < prior[3]:
                        observations[key] = (point, descriptor.astype(np.float32), pixel.astype(np.float32), quality)
        del features

    if len(observations) < 2000:
        raise RuntimeError(f"training-only track index has only {len(observations)} observations")
    ordered = sorted(observations.items(), key=lambda row: (row[0][0], row[0][1]))
    reference_ids = np.asarray([key[0] for key, _ in ordered], dtype=np.int32)
    points_3d = np.asarray([value[0] for _, value in ordered], dtype=np.float32)
    descriptors = np.asarray([value[1] for _, value in ordered], dtype=np.float32)
    keypoints = np.asarray([value[2] for _, value in ordered], dtype=np.float32)
    quality = np.asarray([value[3] for _, value in ordered], dtype=np.float32)

    index_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="v14-sift-track-", dir=index_dir.parent) as temporary:
        staging = Path(temporary)
        np.save(staging / "points3d.npy", points_3d, allow_pickle=False)
        np.save(staging / "descriptors.npy", descriptors, allow_pickle=False)
        np.save(staging / "reference-ids.npy", reference_ids, allow_pickle=False)
        np.save(staging / "reference-keypoints.npy", keypoints, allow_pickle=False)
        np.save(staging / "quality.npy", quality, allow_pickle=False)
        index = {
            "schemaVersion": "1.0",
            "method": "training-pose-epipolar-sift-track-v1",
            "challengeId": CHALLENGE_ID,
            "challengeManifestSha256": challenge_sha,
            "queryImagesOpened": 0,
            "queryGroundTruthRead": False,
            "referenceCount": len(references),
            "horizontalReferenceCount": sum(row["virtualView"] in HORIZONTAL_FACES for row in references),
            "observationCount": len(observations),
            "attemptedTrainingPairs": attempted_pairs,
            "mutualRatioMatches": descriptor_matches,
            "knownPoseEpipolarInliers": epipolar_inliers,
            "triangulatedObservationsBeforeBestPerKeypoint": triangulated * 2,
            "parameters": {
                "siftFeatures": SIFT_FEATURES,
                "pairNeighbours": PAIR_NEIGHBOURS,
                "mutualRatio": RATIO,
                "maxSampsonErrorPx2": MAX_SAMPSON_ERROR_PX2,
                "maxReprojectionPx": MAX_REPROJECTION_PX,
            },
            "references": references,
            "files": {},
        }
        for name in ("points3d.npy", "descriptors.npy", "reference-ids.npy", "reference-keypoints.npy", "quality.npy"):
            path = staging / name
            index["files"][name] = {"bytes": path.stat().st_size, "sha256": sha256(path)}
        (staging / "INDEX.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
        staging.rename(index_dir)
    return index


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--challenge-manifest", required=True, type=Path)
    parser.add_argument("--index-dir", required=True, type=Path)
    args = parser.parse_args()
    index = build(args.challenge_manifest, args.index_dir.resolve())
    print(json.dumps({
        "status": "READY",
        "method": index["method"],
        "referenceCount": index["referenceCount"],
        "observationCount": index["observationCount"],
        "queryImagesOpened": index["queryImagesOpened"],
        "index": str(args.index_dir.resolve()),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
