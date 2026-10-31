#!/usr/bin/env python3
"""Fail-closed image/pose alignment gate and source-derived sparse seed builder.

This uses only the frozen panorama-derived views and published camera poses. It
does not download or read the 360Roam author point cloud. A known-pose essential
matrix must agree with SIFT matches before any GPU work is allowed.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import cv2
import numpy as np


FACES = ("front", "right", "back", "left")
CV_TO_GL = np.diag([1.0, -1.0, -1.0, 1.0])
MAX_MEDIAN_EPIPOLAR_PX = 2.5
MAX_INLIER_EPIPOLAR_PX = 2.0
MIN_RATIO_MATCHES = 24
MIN_EVALUABLE_PAIRS = 12
MIN_POSE_INLIERS = 12
MIN_POSE_INLIER_RATIO = 0.10
MIN_CORRECT_TO_V10_RATIO = 2.0
MIN_SEED_POINTS = 3000


def camera_cv(frame: dict) -> tuple[np.ndarray, np.ndarray]:
    c2w_gl = np.asarray(frame["transform_matrix"], dtype=np.float64)
    c2w_cv = c2w_gl @ CV_TO_GL
    return c2w_cv[:3, :3], c2w_cv[:3, 3]


def fundamental(frame1: dict, frame2: dict, intrinsics: np.ndarray) -> np.ndarray:
    r1, c1 = camera_cv(frame1)
    r2, c2 = camera_cv(frame2)
    relative_r = r2.T @ r1
    relative_t = r2.T @ (c1 - c2)
    tx = np.array(
        [[0.0, -relative_t[2], relative_t[1]],
         [relative_t[2], 0.0, -relative_t[0]],
         [-relative_t[1], relative_t[0], 0.0]],
        dtype=np.float64,
    )
    essential = tx @ relative_r
    inv_k = np.linalg.inv(intrinsics)
    return inv_k.T @ essential @ inv_k


def sampson_distance(fundamental_matrix: np.ndarray, points1: np.ndarray, points2: np.ndarray) -> np.ndarray:
    ones = np.ones((len(points1), 1), dtype=np.float64)
    x1 = np.concatenate([points1, ones], axis=1)
    x2 = np.concatenate([points2, ones], axis=1)
    fx1 = (fundamental_matrix @ x1.T).T
    ftx2 = (fundamental_matrix.T @ x2.T).T
    numerator = np.sum(x2 * fx1, axis=1) ** 2
    denominator = fx1[:, 0] ** 2 + fx1[:, 1] ** 2 + ftx2[:, 0] ** 2 + ftx2[:, 1] ** 2
    return np.sqrt(numerator / np.maximum(denominator, 1e-12))


def projection(frame: dict, intrinsics: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    rotation, centre = camera_cv(frame)
    world_to_camera_r = rotation.T
    world_to_camera_t = -world_to_camera_r @ centre
    return intrinsics @ np.column_stack([world_to_camera_r, world_to_camera_t]), world_to_camera_r, world_to_camera_t


def v10_wrong_frame(frame: dict) -> dict:
    """Recreate the rejected v10 pose for a discriminative control score."""
    yaw = math.radians(-float(frame["virtual_yaw_degrees"]))
    pitch = math.radians(float(frame["virtual_pitch_degrees"]))
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    rotate_y = np.array(
        [[cy, 0.0, sy, 0.0], [0.0, 1.0, 0.0, 0.0], [-sy, 0.0, cy, 0.0], [0.0, 0.0, 0.0, 1.0]]
    )
    rotate_x = np.array(
        [[1.0, 0.0, 0.0, 0.0], [0.0, cp, -sp, 0.0], [0.0, sp, cp, 0.0], [0.0, 0.0, 0.0, 1.0]]
    )
    source_c2w_cv = np.asarray(frame["source_transform_matrix_opencv"], dtype=np.float64)
    return {"transform_matrix": (source_c2w_cv @ rotate_y @ rotate_x).tolist()}


def write_ply(path: Path, points: list[tuple[np.ndarray, tuple[int, int, int]]]) -> None:
    with path.open("w", encoding="ascii", newline="\n") as handle:
        handle.write("ply\nformat ascii 1.0\n")
        handle.write(f"element vertex {len(points)}\n")
        handle.write("property float x\nproperty float y\nproperty float z\n")
        handle.write("property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n")
        for xyz, rgb in points:
            handle.write(f"{xyz[0]:.7f} {xyz[1]:.7f} {xyz[2]:.7f} {rgb[0]} {rgb[1]} {rgb[2]}\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    dataset = args.dataset.resolve()
    transforms_path = dataset / "transforms.json"
    transforms = json.loads(transforms_path.read_text(encoding="utf-8"))
    focal_x, focal_y = float(transforms["fl_x"]), float(transforms["fl_y"])
    centre_x, centre_y = float(transforms["cx"]), float(transforms["cy"])
    intrinsics = np.array([[focal_x, 0.0, centre_x], [0.0, focal_y, centre_y], [0.0, 0.0, 1.0]])

    train_paths = set(transforms["train_filenames"])
    panorama_order: list[str] = []
    by_panorama: dict[str, dict[str, dict]] = {}
    for frame in transforms["frames"]:
        if frame["file_path"] not in train_paths or frame["virtual_view"] not in FACES:
            continue
        panorama = frame["source_panorama"]
        if panorama not in by_panorama:
            panorama_order.append(panorama)
            by_panorama[panorama] = {}
        by_panorama[panorama][frame["virtual_view"]] = frame

    sift = cv2.SIFT_create(nfeatures=1800)
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    feature_cache: dict[str, tuple[list, np.ndarray | None, np.ndarray]] = {}

    def features(frame: dict) -> tuple[list, np.ndarray | None, np.ndarray]:
        relative = frame["file_path"]
        if relative not in feature_cache:
            image = cv2.imread(str(dataset / relative), cv2.IMREAD_COLOR)
            if image is None:
                raise ValueError(f"cannot read prepared view: {relative}")
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            keypoints, descriptors = sift.detectAndCompute(gray, None)
            feature_cache[relative] = (keypoints, descriptors, image)
        return feature_cache[relative]

    pair_rows: list[dict] = []
    seed_candidates: list[tuple[np.ndarray, tuple[int, int, int], float]] = []
    camera_centres = np.asarray([camera_cv(frame)[1] for frame in transforms["frames"]], dtype=np.float64)
    scene_extent = float(np.linalg.norm(camera_centres.max(axis=0) - camera_centres.min(axis=0)))
    max_distance = max(10.0, scene_extent * 5.0)

    for first_name, second_name in zip(panorama_order, panorama_order[1:]):
        best = None
        for first_face in FACES:
            for second_face in FACES:
                frame1 = by_panorama[first_name][first_face]
                frame2 = by_panorama[second_name][second_face]
                keypoints1, descriptors1, image1 = features(frame1)
                keypoints2, descriptors2, _ = features(frame2)
                if descriptors1 is None or descriptors2 is None or len(descriptors1) < 2 or len(descriptors2) < 2:
                    continue
                candidates = matcher.knnMatch(descriptors1, descriptors2, k=2)
                matches = [first for first, second in candidates if first.distance < 0.75 * second.distance]
                if len(matches) < MIN_RATIO_MATCHES:
                    continue
                points1 = np.float64([keypoints1[match.queryIdx].pt for match in matches])
                points2 = np.float64([keypoints2[match.trainIdx].pt for match in matches])
                errors = sampson_distance(fundamental(frame1, frame2, intrinsics), points1, points2)
                wrong_errors = sampson_distance(
                    fundamental(v10_wrong_frame(frame1), v10_wrong_frame(frame2), intrinsics), points1, points2
                )
                keep = errors <= MAX_INLIER_EPIPOLAR_PX
                wrong_keep = wrong_errors <= MAX_INLIER_EPIPOLAR_PX
                inliers = int(np.count_nonzero(keep))
                candidate = {
                    "score": (inliers, -float(np.median(errors[keep])) if inliers else -math.inf),
                    "frame1": frame1,
                    "frame2": frame2,
                    "firstFace": first_face,
                    "secondFace": second_face,
                    "keypoints1": keypoints1,
                    "image1": image1,
                    "matches": matches,
                    "points1": points1,
                    "points2": points2,
                    "errors": errors,
                    "keep": keep,
                    "wrongInliers": int(np.count_nonzero(wrong_keep)),
                    "wrongMedian": float(np.median(wrong_errors)),
                }
                if best is None or candidate["score"] > best["score"]:
                    best = candidate
        if best is None:
            continue
        inliers = best["score"][0]
        inlier_ratio = inliers / len(best["matches"])
        wrong_inliers = best["wrongInliers"]
        control_ratio = inliers / max(wrong_inliers, 1)
        median_inlier = float(np.median(best["errors"][best["keep"]])) if inliers else math.inf
        pair_pass = (
            inliers >= MIN_POSE_INLIERS
            and inlier_ratio >= MIN_POSE_INLIER_RATIO
            and median_inlier <= MAX_MEDIAN_EPIPOLAR_PX
            and control_ratio >= MIN_CORRECT_TO_V10_RATIO
        )
        pair_rows.append({
            "first": first_name,
            "second": second_name,
            "firstFace": best["firstFace"],
            "secondFace": best["secondFace"],
            "ratioMatches": len(best["matches"]),
            "poseInliers": inliers,
            "poseInlierRatio": inlier_ratio,
            "medianInlierEpipolarPx": None if not math.isfinite(median_inlier) else median_inlier,
            "v10WrongConventionInliers": wrong_inliers,
            "correctToV10InlierRatio": control_ratio,
            "v10WrongMedianEpipolarPx": best["wrongMedian"],
            "pass": pair_pass,
        })
        if pair_pass:
            frame1, frame2 = best["frame1"], best["frame2"]
            keypoints1, image1 = best["keypoints1"], best["image1"]
            matches, errors, keep = best["matches"], best["errors"], best["keep"]
            points1, points2 = best["points1"], best["points2"]
            inlier_points1 = points1[keep]
            inlier_points2 = points2[keep]
            inlier_matches = [match for match, selected in zip(matches, keep) if selected]
            p1, r1, t1 = projection(frame1, intrinsics)
            p2, r2, t2 = projection(frame2, intrinsics)
            homogeneous = cv2.triangulatePoints(p1, p2, inlier_points1.T, inlier_points2.T)
            valid_w = np.abs(homogeneous[3]) > 1e-9
            xyz = (homogeneous[:3, valid_w] / homogeneous[3:4, valid_w]).T
            point_matches = [match for match, selected in zip(inlier_matches, valid_w) if selected]
            if not len(xyz):
                continue
            depth1 = (r1 @ xyz.T + t1[:, None])[2]
            depth2 = (r2 @ xyz.T + t2[:, None])[2]
            centre1 = camera_cv(frame1)[1]
            distances = np.linalg.norm(xyz - centre1, axis=1)
            good = (depth1 > 0.05) & (depth2 > 0.05) & (distances < max_distance)
            for point, match, error in zip(xyz[good], np.asarray(point_matches, dtype=object)[good], errors[keep][valid_w][good]):
                x, y = keypoints1[match.queryIdx].pt
                bgr = image1[min(max(round(y), 0), image1.shape[0] - 1), min(max(round(x), 0), image1.shape[1] - 1)]
                seed_candidates.append((point, (int(bgr[2]), int(bgr[1]), int(bgr[0])), float(error)))

    passing_rows = [row for row in pair_rows if row["pass"]]
    all_pair_median = float(np.median([row["medianInlierEpipolarPx"] for row in passing_rows])) if passing_rows else math.inf
    pose_gate = (
        len(pair_rows) >= MIN_EVALUABLE_PAIRS
        and all_pair_median <= MAX_MEDIAN_EPIPOLAR_PX
        and len(passing_rows) >= max(MIN_EVALUABLE_PAIRS, math.ceil(0.5 * len(pair_rows)))
    )

    voxel_size = max(scene_extent * 0.0015, 0.01)
    voxels: dict[tuple[int, int, int], tuple[np.ndarray, tuple[int, int, int], float]] = {}
    for point, color, error in seed_candidates:
        key = tuple(int(round(value / voxel_size)) for value in point)
        if key not in voxels or error < voxels[key][2]:
            voxels[key] = (point, color, error)
    seed_points = [(point, color) for point, color, _ in voxels.values()]
    seed_gate = len(seed_points) >= MIN_SEED_POINTS
    status = "PASS" if pose_gate and seed_gate else "FAIL"
    report = {
        "schemaVersion": "1.0",
        "status": status,
        "sourcePoseConvention": "opencv-c2w-x-right-y-down-z-forward",
        "outputPoseConvention": "opengl-c2w-x-right-y-up-z-back",
        "evaluablePairs": len(pair_rows),
        "passingPairs": len(passing_rows),
        "medianPassingInlierEpipolarPx": None if not math.isfinite(all_pair_median) else all_pair_median,
        "maxMedianEpipolarPx": MAX_MEDIAN_EPIPOLAR_PX,
        "minPoseInliersPerPair": MIN_POSE_INLIERS,
        "minCorrectToV10InlierRatio": MIN_CORRECT_TO_V10_RATIO,
        "seedPoints": len(seed_points),
        "minSeedPoints": MIN_SEED_POINTS,
        "voxelSize": voxel_size,
        "usesAuthorScenePly": False,
        "checks": {"imagePoseAlignment": pose_gate, "sourceDerivedSparseSeed": seed_gate},
        "pairs": pair_rows,
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if status != "PASS":
        raise SystemExit(
            f"image/pose gate failed: pairs={len(pair_rows)} passing={len(passing_rows)} median={all_pair_median:.3f}px seed={len(seed_points)}"
        )

    write_ply(dataset / "sparse_pc.ply", seed_points)
    transforms["ply_file_path"] = "sparse_pc.ply"
    transforms_path.write_text(json.dumps(transforms, indent=2) + "\n", encoding="utf-8")
    prepared_path = dataset / ".prepared.json"
    prepared = json.loads(prepared_path.read_text(encoding="utf-8"))
    prepared["imagePoseAlignment"] = report
    prepared["sparseSeed"] = {"path": "sparse_pc.ply", "points": len(seed_points), "sourceDerived": True}
    prepared["checks"].update({"imagePoseAlignment": True, "sourceDerivedSparseSeed": True})
    prepared_path.write_text(json.dumps(prepared, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in report.items() if key != "pairs"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
