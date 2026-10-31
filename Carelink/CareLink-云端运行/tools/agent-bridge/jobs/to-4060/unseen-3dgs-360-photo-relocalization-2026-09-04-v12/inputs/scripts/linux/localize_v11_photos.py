#!/usr/bin/env python3
"""Localize three held-out v11 photos without using their poses as input.

The reference map is rebuilt only from v11 training images and their published
poses. Query poses are hidden from feature matching and PnP, then revealed only
for scoring. This is an isolated research canary, not a production uploader.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import cv2
import numpy as np


HORIZONTAL_FACES = (
    "front", "front_right", "right", "back_right",
    "back", "back_left", "left", "front_left",
)
CV_TO_GL = np.diag([1.0, -1.0, -1.0, 1.0])
MIN_MAP_POINTS = 2000
MAX_MAP_POINTS = 80000
MIN_PNP_INLIERS = 20
MIN_PNP_INLIER_RATIO = 0.10
MAX_MEDIAN_REPROJECTION_PX = 3.5
MAX_TRANSLATION_ERROR_SCENE_FRACTION = 0.15
MAX_ROTATION_ERROR_DEGREES = 15.0


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def camera_cv(frame: dict[str, Any]) -> tuple[np.ndarray, np.ndarray]:
    c2w_gl = np.asarray(frame["transform_matrix"], dtype=np.float64)
    if c2w_gl.shape != (4, 4) or not np.isfinite(c2w_gl).all():
        raise ValueError(f"invalid camera transform for {frame.get('file_path')}")
    c2w_cv = c2w_gl @ CV_TO_GL
    return c2w_cv[:3, :3], c2w_cv[:3, 3]


def projection(frame: dict[str, Any], intrinsics: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rotation, centre = camera_cv(frame)
    world_to_camera_rotation = rotation.T
    world_to_camera_translation = -world_to_camera_rotation @ centre
    matrix = intrinsics @ np.column_stack([world_to_camera_rotation, world_to_camera_translation])
    return matrix, world_to_camera_rotation, world_to_camera_translation


def validate_and_index(transforms: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    frames = transforms.get("frames")
    train_names = transforms.get("train_filenames")
    val_names = transforms.get("val_filenames")
    if not isinstance(frames, list) or not isinstance(train_names, list) or not isinstance(val_names, list):
        raise ValueError("transforms.json is missing frames/train_filenames/val_filenames")
    if len(train_names) != 450 or len(val_names) != 90:
        raise ValueError(f"expected frozen v11 split 450/90, got {len(train_names)}/{len(val_names)}")
    if set(train_names) & set(val_names):
        raise ValueError("query leakage: train and held-out filenames overlap")
    by_path = {frame.get("file_path"): frame for frame in frames}
    if len(by_path) != len(frames):
        raise ValueError("duplicate or missing frame file_path")
    try:
        train_frames = [by_path[name] for name in train_names]
        val_frames = [by_path[name] for name in val_names]
    except KeyError as error:
        raise ValueError(f"split references missing frame: {error}") from error
    if any(frame.get("virtual_view") == "down" for frame in frames):
        raise ValueError("v12 requires the accepted v11 dataset with down excluded")
    return train_frames, val_frames


def group_by_panorama(frames: list[dict[str, Any]]) -> list[tuple[str, list[dict[str, Any]]]]:
    order: list[str] = []
    grouped: dict[str, list[dict[str, Any]]] = {}
    for frame in frames:
        panorama = frame.get("source_panorama")
        if not isinstance(panorama, str) or not panorama:
            raise ValueError("frame is missing source_panorama")
        if panorama not in grouped:
            order.append(panorama)
            grouped[panorama] = []
        grouped[panorama].append(frame)
    return [(name, grouped[name]) for name in order]


def select_queries(val_frames: list[dict[str, Any]]) -> list[dict[str, Any]]:
    groups = group_by_panorama(val_frames)
    if len(groups) != 10:
        raise ValueError(f"expected 10 held-out panoramas, got {len(groups)}")
    specs = ((1, "front"), (len(groups) // 2, "right"), (len(groups) - 2, "left"))
    selected: list[dict[str, Any]] = []
    for group_index, face_name in specs:
        panorama, frames = groups[group_index]
        candidates = [frame for frame in frames if frame.get("virtual_view") == face_name]
        if len(candidates) != 1:
            raise ValueError(f"held-out query {panorama}/{face_name} is not unique")
        selected.append(candidates[0])
    paths = [frame["file_path"] for frame in selected]
    if len(set(paths)) != 3:
        raise ValueError("query selection is not three unique images")
    return selected


def rotation_error_degrees(predicted: np.ndarray, expected: np.ndarray) -> float:
    relative = predicted.T @ expected
    cosine = float(np.clip((np.trace(relative) - 1.0) / 2.0, -1.0, 1.0))
    return math.degrees(math.acos(cosine))


def forward_world(frame: dict[str, Any]) -> np.ndarray:
    c2w_gl = np.asarray(frame["transform_matrix"], dtype=np.float64)
    direction = -c2w_gl[:3, 2]
    return direction / np.linalg.norm(direction)


def ratio_matches(
    matcher: cv2.DescriptorMatcher,
    first: np.ndarray | None,
    second: np.ndarray | None,
    ratio: float = 0.75,
) -> list[cv2.DMatch]:
    if first is None or second is None or len(first) < 2 or len(second) < 2:
        return []
    rows = matcher.knnMatch(first, second, k=2)
    return [best for best, runner_up in rows if best.distance < ratio * runner_up.distance]


def solve_pnp_correspondences(
    object_points: np.ndarray,
    image_points: np.ndarray,
    intrinsics: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray] | None:
    if len(object_points) < 8 or len(object_points) != len(image_points):
        return None
    success, rvec, tvec, inliers = cv2.solvePnPRansac(
        np.asarray(object_points, dtype=np.float32),
        np.asarray(image_points, dtype=np.float32),
        intrinsics,
        None,
        iterationsCount=2500,
        reprojectionError=5.0,
        confidence=0.999,
        flags=cv2.SOLVEPNP_EPNP,
    )
    if not success or inliers is None or len(inliers) < 4:
        return None
    inlier_indices = inliers.reshape(-1)
    object_inliers = np.asarray(object_points, dtype=np.float32)[inlier_indices]
    image_inliers = np.asarray(image_points, dtype=np.float32)[inlier_indices]
    if hasattr(cv2, "solvePnPRefineLM"):
        rvec, tvec = cv2.solvePnPRefineLM(object_inliers, image_inliers, intrinsics, None, rvec, tvec)
    projected, _ = cv2.projectPoints(object_inliers, rvec, tvec, intrinsics, None)
    reprojection_errors = np.linalg.norm(projected.reshape(-1, 2) - image_inliers, axis=1)
    return rvec, tvec, inlier_indices, reprojection_errors


def build_reference_map(
    dataset: Path,
    train_frames: list[dict[str, Any]],
    intrinsics: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    panorama_groups = group_by_panorama(train_frames)
    if len(panorama_groups) != 50:
        raise ValueError(f"expected 50 training panoramas, got {len(panorama_groups)}")
    panorama_centres = []
    for _, frames in panorama_groups:
        panorama_centres.append(camera_cv(frames[0])[1])
    centres = np.asarray(panorama_centres, dtype=np.float64)
    scene_extent = float(np.linalg.norm(centres.max(axis=0) - centres.min(axis=0)))
    if not math.isfinite(scene_extent) or scene_extent <= 1e-6:
        raise ValueError("training camera extent is degenerate")

    sift = cv2.SIFT_create(nfeatures=1800, contrastThreshold=0.02)
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    cache: dict[str, tuple[list[cv2.KeyPoint], np.ndarray | None]] = {}

    def features(frame: dict[str, Any]) -> tuple[list[cv2.KeyPoint], np.ndarray | None]:
        relative = frame["file_path"]
        if relative not in cache:
            image = cv2.imread(str(dataset / relative), cv2.IMREAD_GRAYSCALE)
            if image is None:
                raise ValueError(f"cannot read reference image: {relative}")
            cache[relative] = sift.detectAndCompute(image, None)
        return cache[relative]

    horizontal_groups = [
        [frame for frame in frames if frame.get("virtual_view") in HORIZONTAL_FACES]
        for _, frames in panorama_groups
    ]
    if any(len(frames) != len(HORIZONTAL_FACES) for frames in horizontal_groups):
        raise ValueError("every training panorama must have eight horizontal reference views")

    candidates: dict[tuple[int, int, int], tuple[np.ndarray, np.ndarray, float, str, str]] = {}
    voxel_size = max(scene_extent / 240.0, 1e-5)
    max_distance = max(scene_extent * 6.0, 10.0)
    attempted_pairs = 0
    useful_pairs = 0
    triangulated_before_dedup = 0

    for first_index, first_frames in enumerate(horizontal_groups):
        distances = np.linalg.norm(centres - centres[first_index], axis=1)
        neighbour_indices = [
            int(index) for index in np.argsort(distances)
            if int(index) != first_index and distances[int(index)] > scene_extent * 0.002
        ][:2]
        for second_index in neighbour_indices:
            second_frames = horizontal_groups[second_index]
            for first_frame in first_frames:
                first_direction = forward_world(first_frame)
                second_frame = max(second_frames, key=lambda frame: float(first_direction @ forward_world(frame)))
                pair_key = tuple(sorted((first_frame["file_path"], second_frame["file_path"])))
                if pair_key[0] == first_frame["file_path"]:
                    frame_a, frame_b = first_frame, second_frame
                else:
                    frame_a, frame_b = second_frame, first_frame
                attempted_pairs += 1
                keypoints_a, descriptors_a = features(frame_a)
                keypoints_b, descriptors_b = features(frame_b)
                matches = ratio_matches(matcher, descriptors_a, descriptors_b)
                if len(matches) < 18:
                    continue
                useful_pairs += 1
                points_a = np.asarray([keypoints_a[match.queryIdx].pt for match in matches], dtype=np.float64)
                points_b = np.asarray([keypoints_b[match.trainIdx].pt for match in matches], dtype=np.float64)
                projection_a, rotation_a, translation_a = projection(frame_a, intrinsics)
                projection_b, rotation_b, translation_b = projection(frame_b, intrinsics)
                homogeneous = cv2.triangulatePoints(projection_a, projection_b, points_a.T, points_b.T)
                valid_w = np.abs(homogeneous[3]) > 1e-10
                xyz = (homogeneous[:3, valid_w] / homogeneous[3, valid_w]).T
                valid_matches = [match for match, keep in zip(matches, valid_w) if keep]
                if not len(xyz):
                    continue
                camera_a = (rotation_a @ xyz.T + translation_a[:, None]).T
                camera_b = (rotation_b @ xyz.T + translation_b[:, None]).T
                depth_valid = (camera_a[:, 2] > 0.05) & (camera_b[:, 2] > 0.05)
                projected_a = camera_a[:, :2] / camera_a[:, 2:3]
                projected_b = camera_b[:, :2] / camera_b[:, 2:3]
                projected_a = projected_a @ np.diag([intrinsics[0, 0], intrinsics[1, 1]]) + intrinsics[:2, 2]
                projected_b = projected_b @ np.diag([intrinsics[0, 0], intrinsics[1, 1]]) + intrinsics[:2, 2]
                errors_a = np.linalg.norm(projected_a - points_a[valid_w], axis=1)
                errors_b = np.linalg.norm(projected_b - points_b[valid_w], axis=1)
                distance_valid = (
                    (np.linalg.norm(xyz - centres[first_index], axis=1) <= max_distance)
                    & (np.linalg.norm(xyz - centres[second_index], axis=1) <= max_distance)
                )
                keep_rows = np.where(depth_valid & distance_valid & (errors_a <= 2.5) & (errors_b <= 2.5))[0]
                triangulated_before_dedup += int(len(keep_rows))
                for row_index in keep_rows:
                    match = valid_matches[int(row_index)]
                    point = xyz[int(row_index)]
                    descriptor = np.asarray(descriptors_a[match.queryIdx], dtype=np.float32)
                    score = float(errors_a[int(row_index)] + errors_b[int(row_index)] + match.distance / 100.0)
                    voxel = tuple(int(value) for value in np.floor(point / voxel_size))
                    prior = candidates.get(voxel)
                    if prior is None or score < prior[2]:
                        candidates[voxel] = (
                            point.astype(np.float32), descriptor, score,
                            frame_a["file_path"], frame_b["file_path"],
                        )

    ordered = sorted(candidates.values(), key=lambda row: row[2])[:MAX_MAP_POINTS]
    if len(ordered) < MIN_MAP_POINTS:
        raise RuntimeError(f"reference map has only {len(ordered)} points; need {MIN_MAP_POINTS}")
    points = np.asarray([row[0] for row in ordered], dtype=np.float32)
    descriptors = np.asarray([row[1] for row in ordered], dtype=np.float32)
    summary = {
        "trainingPanoramas": len(panorama_groups),
        "referenceImages": len(cache),
        "attemptedImagePairs": attempted_pairs,
        "usefulImagePairs": useful_pairs,
        "triangulatedBeforeDedup": triangulated_before_dedup,
        "mapPoints": len(points),
        "minMapPoints": MIN_MAP_POINTS,
        "sceneExtent": scene_extent,
        "voxelSize": voxel_size,
        "usesHeldOutImages": False,
        "usesAuthorScenePly": False,
        "usesV11SogGeometry": False,
    }
    return points, descriptors, summary


def estimate_query_pose(
    dataset: Path,
    frame: dict[str, Any],
    map_points: np.ndarray,
    map_descriptors: np.ndarray,
    intrinsics: np.ndarray,
    scene_extent: float,
) -> tuple[dict[str, Any], np.ndarray | None]:
    image = cv2.imread(str(dataset / frame["file_path"]), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"cannot read held-out query: {frame['file_path']}")
    sift = cv2.SIFT_create(nfeatures=2600, contrastThreshold=0.015)
    keypoints, descriptors = sift.detectAndCompute(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY), None)
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
    if descriptors is None or len(descriptors) < 8:
        return {**base, "status": "FAIL", "reason": "insufficient-query-features"}, image

    flann = cv2.FlannBasedMatcher(dict(algorithm=1, trees=5), dict(checks=96))
    matches = ratio_matches(flann, np.asarray(descriptors, dtype=np.float32), map_descriptors, ratio=0.72)
    unique_by_map: dict[int, cv2.DMatch] = {}
    for match in matches:
        prior = unique_by_map.get(match.trainIdx)
        if prior is None or match.distance < prior.distance:
            unique_by_map[match.trainIdx] = match
    matches = list(unique_by_map.values())
    base["ratioMatches"] = len(matches)
    if len(matches) < 8:
        return {**base, "status": "FAIL", "reason": "insufficient-2d3d-matches"}, image

    object_points = np.asarray([map_points[match.trainIdx] for match in matches], dtype=np.float32)
    image_points = np.asarray([keypoints[match.queryIdx].pt for match in matches], dtype=np.float32)
    pose_result = solve_pnp_correspondences(object_points, image_points, intrinsics)
    if pose_result is None:
        return {**base, "status": "FAIL", "reason": "pnp-ransac-failed", "pnpInliers": 0}, image
    rvec, tvec, inlier_indices, reprojection_errors = pose_result

    world_to_camera_rotation, _ = cv2.Rodrigues(rvec)
    camera_to_world_rotation = world_to_camera_rotation.T
    camera_centre = -camera_to_world_rotation @ tvec.reshape(3)

    expected_rotation, expected_centre = camera_cv(frame)
    translation_error = float(np.linalg.norm(camera_centre - expected_centre))
    translation_fraction = translation_error / scene_extent
    rotation_error = rotation_error_degrees(camera_to_world_rotation, expected_rotation)
    median_reprojection = float(np.median(reprojection_errors))
    inlier_ratio = len(inlier_indices) / len(matches)
    passed = (
        len(inlier_indices) >= MIN_PNP_INLIERS
        and inlier_ratio >= MIN_PNP_INLIER_RATIO
        and median_reprojection <= MAX_MEDIAN_REPROJECTION_PX
        and translation_fraction <= MAX_TRANSLATION_ERROR_SCENE_FRACTION
        and rotation_error <= MAX_ROTATION_ERROR_DEGREES
    )
    estimated_c2w_cv = np.eye(4, dtype=np.float64)
    estimated_c2w_cv[:3, :3] = camera_to_world_rotation
    estimated_c2w_cv[:3, 3] = camera_centre
    estimated_c2w_gl = estimated_c2w_cv @ CV_TO_GL
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
    transforms = load_json(dataset / "transforms.json")
    train_frames, val_frames = validate_and_index(transforms)
    queries = select_queries(val_frames)
    intrinsics = np.asarray([
        [float(transforms["fl_x"]), 0.0, float(transforms["cx"])],
        [0.0, float(transforms["fl_y"]), float(transforms["cy"])],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)
    map_points, map_descriptors, map_summary = build_reference_map(dataset, train_frames, intrinsics)
    evidence_dir = args.local_evidence_dir.resolve()
    evidence_dir.mkdir(parents=True, exist_ok=True)
    query_rows = []
    for index, query in enumerate(queries, start=1):
        row, image = estimate_query_pose(
            dataset, query, map_points, map_descriptors, intrinsics, float(map_summary["sceneExtent"])
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
        "jobId": "unseen-3dgs-360-photo-relocalization-2026-09-04-v12",
        "sceneRevisionId": "360roam-base-posefix-r001",
        "status": status,
        "queriesExpected": 3,
        "queriesPassed": passed_count,
        "querySelection": "held-out panoramas 2/middle/penultimate with front/right/left faces",
        "trainingOrSogModification": False,
        "gpuRequired": False,
        "groundTruthPolicy": "held-out c2w is inaccessible to map building and estimation; used only after PnP for scoring",
        "referenceMap": map_summary,
        "thresholds": {
            "minPnpInliers": MIN_PNP_INLIERS,
            "minPnpInlierRatio": MIN_PNP_INLIER_RATIO,
            "maxMedianReprojectionPx": MAX_MEDIAN_REPROJECTION_PX,
            "maxTranslationErrorSceneFraction": MAX_TRANSLATION_ERROR_SCENE_FRACTION,
            "maxRotationErrorDegrees": MAX_ROTATION_ERROR_DEGREES,
        },
        "queries": query_rows,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "queriesPassed": passed_count, "report": str(args.report)}, indent=2))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
