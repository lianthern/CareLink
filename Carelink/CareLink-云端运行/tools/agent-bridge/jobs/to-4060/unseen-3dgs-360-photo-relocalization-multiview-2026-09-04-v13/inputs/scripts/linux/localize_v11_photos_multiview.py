#!/usr/bin/env python3
"""v13 multiview-descriptor relocalization over the unchanged v12 queries.

The v12 geometry and pass thresholds remain frozen. This revision adds richer
training-only descriptor coverage: each 3D landmark can retain observations
from several reference views, descriptors use RootSIFT, and the ratio test
compares different landmarks rather than duplicate observations of one point.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np


BASE_SHA256 = "a4c4d152695e9b8f1b335d5ff0cb83952aa1e1bd64cd0f269079eaa6c2bc3273"
MAX_OBSERVATIONS_PER_LANDMARK = 6
ASSOCIATION_RADIUS_PX = 3.5
QUERY_RATIO = 0.82
QUERY_KNN = 32


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_v12_module() -> Any:
    repo_root = Path(__file__).resolve().parents[6]
    path = repo_root / "jobs/to-4060/unseen-3dgs-360-photo-relocalization-2026-09-04-v12/inputs/scripts/linux/localize_v11_photos.py"
    if not path.is_file() or sha256(path) != BASE_SHA256:
        raise RuntimeError(f"frozen v12 localizer missing or changed: {path}")
    spec = importlib.util.spec_from_file_location("frozen_v12_localizer", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import frozen v12 localizer: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


V12 = load_v12_module()


def root_sift(descriptors: np.ndarray | None) -> np.ndarray | None:
    if descriptors is None or len(descriptors) == 0:
        return None
    values = np.asarray(descriptors, dtype=np.float32)
    l1 = np.sum(np.abs(values), axis=1, keepdims=True)
    return np.sqrt(values / np.maximum(l1, 1e-12)).astype(np.float32)


def project_points(
    frame: dict[str, Any],
    points: np.ndarray,
    intrinsics: np.ndarray,
    width: int,
    height: int,
) -> tuple[np.ndarray, np.ndarray]:
    _, rotation, translation = V12.projection(frame, intrinsics)
    camera = (rotation @ np.asarray(points, dtype=np.float64).T + translation[:, None]).T
    valid = camera[:, 2] > 0.05
    pixels = np.full((len(points), 2), np.nan, dtype=np.float64)
    pixels[valid, 0] = intrinsics[0, 0] * camera[valid, 0] / camera[valid, 2] + intrinsics[0, 2]
    pixels[valid, 1] = intrinsics[1, 1] * camera[valid, 1] / camera[valid, 2] + intrinsics[1, 2]
    valid &= (
        (pixels[:, 0] >= 0.0) & (pixels[:, 0] < width)
        & (pixels[:, 1] >= 0.0) & (pixels[:, 1] < height)
    )
    return pixels, valid


def build_multiview_bank(
    dataset: Path,
    train_frames: list[dict[str, Any]],
    map_points: np.ndarray,
    base_descriptors: np.ndarray,
    intrinsics: np.ndarray,
    width: int,
    height: int,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    descriptor_sets: list[list[np.ndarray]] = [
        [descriptor] for descriptor in root_sift(base_descriptors)
    ]
    sift = cv2.SIFT_create(nfeatures=5000, contrastThreshold=0.006, edgeThreshold=20)
    processed_images = 0
    associated_observations = 0
    candidate_keypoints = 0
    cell_size = ASSOCIATION_RADIUS_PX

    for frame in train_frames:
        if frame.get("virtual_view") not in V12.HORIZONTAL_FACES:
            continue
        relative = frame["file_path"]
        image = cv2.imread(str(dataset / relative), cv2.IMREAD_GRAYSCALE)
        if image is None:
            raise ValueError(f"cannot read training reference image: {relative}")
        keypoints, descriptors = sift.detectAndCompute(image, None)
        descriptors = root_sift(descriptors)
        processed_images += 1
        candidate_keypoints += len(keypoints)
        if descriptors is None or not keypoints:
            continue

        pixels, visible = project_points(frame, map_points, intrinsics, width, height)
        visible_indices = np.where(visible)[0]
        grid: dict[tuple[int, int], list[int]] = {}
        for landmark_index in visible_indices:
            x, y = pixels[landmark_index]
            cell = (int(x // cell_size), int(y // cell_size))
            grid.setdefault(cell, []).append(int(landmark_index))

        seen_in_image: set[int] = set()
        for keypoint_index, keypoint in enumerate(keypoints):
            x, y = keypoint.pt
            cell_x, cell_y = int(x // cell_size), int(y // cell_size)
            nearby: list[int] = []
            for offset_y in (-1, 0, 1):
                for offset_x in (-1, 0, 1):
                    nearby.extend(grid.get((cell_x + offset_x, cell_y + offset_y), ()))
            if not nearby:
                continue
            nearby_array = np.asarray(nearby, dtype=np.int32)
            distances = np.linalg.norm(pixels[nearby_array] - np.asarray([x, y]), axis=1)
            best_offset = int(np.argmin(distances))
            if float(distances[best_offset]) > ASSOCIATION_RADIUS_PX:
                continue
            landmark = int(nearby_array[best_offset])
            if landmark in seen_in_image or len(descriptor_sets[landmark]) >= MAX_OBSERVATIONS_PER_LANDMARK:
                continue
            descriptor = descriptors[keypoint_index]
            if min(float(np.linalg.norm(descriptor - prior)) for prior in descriptor_sets[landmark]) < 0.025:
                continue
            descriptor_sets[landmark].append(descriptor)
            seen_in_image.add(landmark)
            associated_observations += 1

    bank_descriptors: list[np.ndarray] = []
    bank_landmarks: list[int] = []
    counts = []
    for landmark, descriptors in enumerate(descriptor_sets):
        counts.append(len(descriptors))
        for descriptor in descriptors:
            bank_descriptors.append(descriptor)
            bank_landmarks.append(landmark)
    descriptor_bank = np.asarray(bank_descriptors, dtype=np.float32)
    landmark_ids = np.asarray(bank_landmarks, dtype=np.int32)
    summary = {
        "trainingImagesProcessed": processed_images,
        "candidateTrainingKeypoints": candidate_keypoints,
        "associatedAdditionalObservations": associated_observations,
        "descriptorEntries": len(descriptor_bank),
        "landmarks": len(map_points),
        "multiViewLandmarks": sum(count > 1 for count in counts),
        "meanDescriptorsPerLandmark": float(np.mean(counts)),
        "maxDescriptorsPerLandmark": max(counts),
        "rootSift": True,
        "distinctLandmarkRatioTest": True,
        "associationRadiusPx": ASSOCIATION_RADIUS_PX,
        "maxObservationsPerLandmark": MAX_OBSERVATIONS_PER_LANDMARK,
        "usesHeldOutImages": False,
    }
    return descriptor_bank, landmark_ids, summary


def choose_distinct_landmark_match(
    neighbours: list[Any],
    landmark_ids: np.ndarray,
    ratio: float,
) -> tuple[int, float, float] | None:
    """Apply Lowe's ratio test against the nearest *different* landmark."""
    if len(neighbours) < 2:
        return None
    best = neighbours[0]
    best_landmark = int(landmark_ids[best.trainIdx])
    runner = next(
        (candidate for candidate in neighbours[1:] if int(landmark_ids[candidate.trainIdx]) != best_landmark),
        None,
    )
    if runner is None or not (best.distance < ratio * runner.distance):
        return None
    return best_landmark, float(best.distance), float(runner.distance)


def distinct_landmark_matches(
    query_descriptors: np.ndarray,
    bank_descriptors: np.ndarray,
    landmark_ids: np.ndarray,
    ratio: float = QUERY_RATIO,
) -> list[tuple[int, int, float, float]]:
    if len(query_descriptors) < 2 or len(bank_descriptors) < 2:
        return []
    matcher = cv2.FlannBasedMatcher(dict(algorithm=1, trees=8), dict(checks=160))
    rows = matcher.knnMatch(
        np.asarray(query_descriptors, dtype=np.float32),
        np.asarray(bank_descriptors, dtype=np.float32),
        k=min(QUERY_KNN, len(bank_descriptors)),
    )
    best_by_landmark: dict[int, tuple[int, int, float, float]] = {}
    for query_index, neighbours in enumerate(rows):
        selected = choose_distinct_landmark_match(neighbours, landmark_ids, ratio)
        if selected is None:
            continue
        best_landmark, best_distance, runner_distance = selected
        row = (query_index, best_landmark, best_distance, runner_distance)
        prior = best_by_landmark.get(best_landmark)
        if prior is None or row[2] < prior[2]:
            best_by_landmark[best_landmark] = row
    return sorted(best_by_landmark.values(), key=lambda row: row[2])


def estimate_query(
    dataset: Path,
    frame: dict[str, Any],
    map_points: np.ndarray,
    descriptor_bank: np.ndarray,
    landmark_ids: np.ndarray,
    intrinsics: np.ndarray,
    scene_extent: float,
) -> tuple[dict[str, Any], np.ndarray | None]:
    image = cv2.imread(str(dataset / frame["file_path"]), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"cannot read held-out query: {frame['file_path']}")
    sift = cv2.SIFT_create(nfeatures=5000, contrastThreshold=0.006, edgeThreshold=20)
    keypoints, raw_descriptors = sift.detectAndCompute(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), None)
    query_descriptors = root_sift(raw_descriptors)
    base = {
        "id": Path(frame["file_path"]).stem,
        "filePath": frame["file_path"],
        "sourcePanorama": frame["source_panorama"],
        "virtualView": frame["virtual_view"],
        "split": "held-out",
        "groundTruthUsedForFeatureMap": False,
        "groundTruthUsedForEstimate": False,
        "queryKeypoints": len(keypoints),
    }
    if query_descriptors is None or len(query_descriptors) < 8:
        return {**base, "status": "FAIL", "reason": "insufficient-query-features"}, image
    matches = distinct_landmark_matches(query_descriptors, descriptor_bank, landmark_ids)
    base["ratioMatches"] = len(matches)
    if len(matches) < 8:
        return {**base, "status": "FAIL", "reason": "insufficient-2d3d-matches"}, image

    object_points = np.asarray([map_points[row[1]] for row in matches], dtype=np.float32)
    image_points = np.asarray([keypoints[row[0]].pt for row in matches], dtype=np.float32)
    pose_result = V12.solve_pnp_correspondences(object_points, image_points, intrinsics)
    if pose_result is None:
        return {**base, "status": "FAIL", "reason": "pnp-ransac-failed", "pnpInliers": 0}, image
    rvec, tvec, inlier_indices, reprojection_errors = pose_result
    world_to_camera_rotation, _ = cv2.Rodrigues(rvec)
    camera_to_world_rotation = world_to_camera_rotation.T
    camera_centre = -camera_to_world_rotation @ tvec.reshape(3)
    expected_rotation, expected_centre = V12.camera_cv(frame)
    translation_error = float(np.linalg.norm(camera_centre - expected_centre))
    translation_fraction = translation_error / scene_extent
    rotation_error = V12.rotation_error_degrees(camera_to_world_rotation, expected_rotation)
    median_reprojection = float(np.median(reprojection_errors))
    inlier_ratio = len(inlier_indices) / len(matches)
    passed = (
        len(inlier_indices) >= V12.MIN_PNP_INLIERS
        and inlier_ratio >= V12.MIN_PNP_INLIER_RATIO
        and median_reprojection <= V12.MAX_MEDIAN_REPROJECTION_PX
        and translation_fraction <= V12.MAX_TRANSLATION_ERROR_SCENE_FRACTION
        and rotation_error <= V12.MAX_ROTATION_ERROR_DEGREES
    )
    estimated_c2w_cv = np.eye(4, dtype=np.float64)
    estimated_c2w_cv[:3, :3] = camera_to_world_rotation
    estimated_c2w_cv[:3, 3] = camera_centre
    estimated_c2w_gl = estimated_c2w_cv @ V12.CV_TO_GL
    return {
        **base,
        "status": "PASS" if passed else "FAIL",
        "reason": None if passed else "threshold-not-met",
        "pnpInliers": int(len(inlier_indices)),
        "pnpInlierRatio": float(inlier_ratio),
        "medianReprojectionPx": median_reprojection,
        "translationError": translation_error,
        "translationErrorSceneFraction": float(translation_fraction),
        "rotationErrorDegrees": float(rotation_error),
        "estimatedC2wOpenGL": estimated_c2w_gl.tolist(),
    }, image


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--local-evidence-dir", required=True, type=Path)
    args = parser.parse_args()
    dataset = args.dataset.resolve()
    transforms = V12.load_json(dataset / "transforms.json")
    train_frames, val_frames = V12.validate_and_index(transforms)
    queries = V12.select_queries(val_frames)
    intrinsics = np.asarray([
        [float(transforms["fl_x"]), 0.0, float(transforms["cx"])],
        [0.0, float(transforms["fl_y"]), float(transforms["cy"])],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)
    map_points, base_descriptors, map_summary = V12.build_reference_map(dataset, train_frames, intrinsics)
    descriptor_bank, landmark_ids, bank_summary = build_multiview_bank(
        dataset,
        train_frames,
        map_points,
        base_descriptors,
        intrinsics,
        int(transforms["w"]),
        int(transforms["h"]),
    )
    evidence_dir = args.local_evidence_dir.resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    query_rows = []
    for index, query in enumerate(queries, start=1):
        row, image = estimate_query(
            dataset,
            query,
            map_points,
            descriptor_bank,
            landmark_ids,
            intrinsics,
            float(map_summary["sceneExtent"]),
        )
        if image is not None:
            thumbnail = cv2.resize(image, (384, 384), interpolation=cv2.INTER_AREA)
            thumbnail_path = evidence_dir / f"query-{index}.jpg"
            if not cv2.imwrite(str(thumbnail_path), thumbnail, [cv2.IMWRITE_JPEG_QUALITY, 86]):
                raise RuntimeError(f"failed to write local query thumbnail: {thumbnail_path}")
            row["localThumbnail"] = str(thumbnail_path)
        query_rows.append(row)
        print(json.dumps({key: value for key, value in row.items() if key != "estimatedC2wOpenGL"}), flush=True)

    passed_count = sum(row["status"] == "PASS" for row in query_rows)
    status = "PASS" if passed_count == 3 else ("PARTIAL" if passed_count == 2 else "FAIL")
    report = {
        "schemaVersion": "1.0",
        "jobId": "unseen-3dgs-360-photo-relocalization-multiview-2026-09-04-v13",
        "sceneRevisionId": "360roam-base-posefix-r001",
        "status": status,
        "queriesExpected": 3,
        "queriesPassed": passed_count,
        "querySetIdenticalToV12": True,
        "passThresholdsIdenticalToV12": True,
        "trainingOrSogModification": False,
        "gpuRequired": False,
        "groundTruthPolicy": "held-out c2w is unavailable to map/descriptor construction and estimation; score only",
        "v12BaseMap": map_summary,
        "v13DescriptorBank": bank_summary,
        "matcher": {
            "queryFeatures": "RootSIFT up to 5000",
            "ratio": QUERY_RATIO,
            "knn": QUERY_KNN,
            "runnerUpMustBeDifferentLandmark": True,
        },
        "thresholds": {
            "minPnpInliers": V12.MIN_PNP_INLIERS,
            "minPnpInlierRatio": V12.MIN_PNP_INLIER_RATIO,
            "maxMedianReprojectionPx": V12.MAX_MEDIAN_REPROJECTION_PX,
            "maxTranslationErrorSceneFraction": V12.MAX_TRANSLATION_ERROR_SCENE_FRACTION,
            "maxRotationErrorDegrees": V12.MAX_ROTATION_ERROR_DEGREES,
        },
        "queries": query_rows,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "queriesPassed": passed_count, "report": str(args.report)}, indent=2))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
