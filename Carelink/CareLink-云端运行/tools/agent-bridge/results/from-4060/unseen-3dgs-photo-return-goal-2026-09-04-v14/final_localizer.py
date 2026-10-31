#!/usr/bin/env python3
"""Truth-free clean-process v14 localizer over an immutable learned index."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
import torch.nn.functional as functional
from torchvision.models import AlexNet_Weights, alexnet
from lightglue import LightGlue, SuperPoint
from lightglue.utils import rbd


CHALLENGE_ID = "v14-fixed-real-panorama-photo-q2"
CV_TO_GL = np.diag([1.0, -1.0, -1.0, 1.0])
MAX_KEYPOINTS = 2048
RETRIEVAL_REFERENCES = 30
SEED_REFERENCES = 12
CLUSTER_REFERENCES = 5
GRID_COLUMNS = 8
GRID_ROWS = 8
GRID_QUOTA = 8


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


def image_tensors(path: Path, device: torch.device) -> tuple[torch.Tensor, torch.Tensor]:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"cannot decode query: {path}")
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    local = torch.from_numpy(gray).float().div(255.0)[None].to(device)
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (256, 256), interpolation=cv2.INTER_AREA)[16:240, 16:240]
    global_value = torch.from_numpy(resized).permute(2, 0, 1).float().div(255.0)
    mean = torch.tensor([0.485, 0.456, 0.406])[:, None, None]
    std = torch.tensor([0.229, 0.224, 0.225])[:, None, None]
    return local, ((global_value - mean) / std)[None].to(device)


def verify_index(index_dir: Path, challenge_sha: str) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    manifest = json.loads((index_dir / "INDEX.json").read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != "1.0" or manifest.get("challengeId") != CHALLENGE_ID:
        raise RuntimeError("unexpected index identity")
    if manifest.get("challengeManifestSha256") != challenge_sha:
        raise RuntimeError("index was built for a different challenge")
    if manifest.get("queryImagesOpened") != 0 or manifest.get("queryGroundTruthRead") is not False:
        raise RuntimeError("index is not training-only")
    arrays = {}
    for name, record in manifest.get("files", {}).items():
        path = index_dir / name
        if not path.is_file() or path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise RuntimeError(f"index file failed verification: {path}")
        arrays[name] = np.load(path, allow_pickle=False)
    required = {
        "global-descriptors.npy", "reference-offsets.npy", "reference-keypoints.npy",
        "reference-descriptors.npy", "reference-scores.npy", "points3d.npy", "quality.npy",
    }
    if set(arrays) != required:
        raise RuntimeError("index file set is incomplete or unexpected")
    return manifest, arrays


def reference_features(arrays: dict[str, np.ndarray], reference_id: int, device: torch.device) -> dict[str, torch.Tensor]:
    offsets = arrays["reference-offsets.npy"]
    start, stop = int(offsets[reference_id]), int(offsets[reference_id + 1])
    return {
        "keypoints": torch.from_numpy(arrays["reference-keypoints.npy"][start:stop])[None].to(device),
        "descriptors": torch.from_numpy(arrays["reference-descriptors.npy"][start:stop].astype(np.float32))[None].to(device),
        "keypoint_scores": torch.from_numpy(arrays["reference-scores.npy"][start:stop].astype(np.float32))[None].to(device),
        "image_size": torch.tensor([[1024.0, 1024.0]], device=device),
    }


def spatial_quota(rows: list[tuple[int, int, float, int]], query_points: np.ndarray, width: int, height: int):
    selected = []
    used_query = set()
    used_point = set()
    cell_counts: dict[tuple[int, int], int] = {}
    for query_id, point_id, score, reference_id in sorted(rows, key=lambda row: row[2], reverse=True):
        if query_id in used_query:
            continue
        point_key = point_id
        if point_key in used_point:
            continue
        x, y = query_points[query_id]
        cell = (
            min(GRID_COLUMNS - 1, max(0, int(x * GRID_COLUMNS / width))),
            min(GRID_ROWS - 1, max(0, int(y * GRID_ROWS / height))),
        )
        if cell_counts.get(cell, 0) >= GRID_QUOTA:
            continue
        cell_counts[cell] = cell_counts.get(cell, 0) + 1
        used_query.add(query_id)
        used_point.add(point_key)
        selected.append((query_id, point_id, score, reference_id))
    return selected


def solve_pose(rows, query_points, points3d, matrix, width, height):
    selected = spatial_quota(rows, query_points, width, height)
    if len(selected) < 8:
        return None
    object_points = np.asarray([points3d[row[1]] for row in selected], dtype=np.float32)
    image_points = np.asarray([query_points[row[0]] for row in selected], dtype=np.float32)
    success, rvec, tvec, inliers = cv2.solvePnPRansac(
        object_points, image_points, matrix, None,
        iterationsCount=30000, reprojectionError=5.0, confidence=0.9999, flags=cv2.SOLVEPNP_EPNP,
    )
    if not success or inliers is None or len(inliers) < 4:
        return None
    chosen = inliers.ravel()
    if len(chosen) >= 6:
        rvec, tvec = cv2.solvePnPRefineLM(object_points[chosen], image_points[chosen], matrix, None, rvec, tvec)
    projected, _ = cv2.projectPoints(object_points[chosen], rvec, tvec, matrix, None)
    errors = np.linalg.norm(projected.reshape(-1, 2) - image_points[chosen], axis=1)
    rotation, _ = cv2.Rodrigues(rvec)
    c2w_cv = np.eye(4, dtype=np.float64)
    c2w_cv[:3, :3] = rotation.T
    c2w_cv[:3, 3] = -rotation.T @ tvec.reshape(3)
    return {
        "estimatedC2wOpenGL": c2w_cv @ CV_TO_GL,
        "geometricInliers": int(len(chosen)),
        "geometricInlierRatio": float(len(chosen) / len(selected)),
        "medianReprojectionPx": float(np.median(errors)),
        "correspondences": len(selected),
    }


def candidate_rank(row):
    return (row["geometricInliers"], row["geometricInlierRatio"], -row["medianReprojectionPx"])


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
    query_records = {safe_path(challenge_root, row["path"]): row for row in challenge.get("queryVariants", [])}
    record = query_records.get(query_path)
    if record is None or sha256(query_path) != record["sha256"] or args.run_id != record["runId"]:
        raise RuntimeError("query does not match the requested frozen truth-free variant")
    index, arrays = verify_index(args.index_dir.resolve(), sha256(challenge_path))
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        raise RuntimeError("learned candidate requires the approved local CUDA GPU")
    local_image, alex_image = image_tensors(query_path, device)
    extractor = SuperPoint(max_num_keypoints=MAX_KEYPOINTS).eval().to(device)
    matcher = LightGlue(features="superpoint").eval().to(device)
    alex = alexnet(weights=AlexNet_Weights.IMAGENET1K_V1).features.eval().to(device)
    with torch.inference_mode():
        query_features = extractor.extract(local_image)
        global_query = alex(alex_image)
        global_query = functional.adaptive_avg_pool2d(global_query, 1).flatten(1)
        global_query = functional.normalize(global_query, dim=1)[0].cpu().numpy()
    query_unbatched = rbd(query_features)
    query_points = query_unbatched["keypoints"].detach().cpu().numpy().astype(np.float32)
    similarities = arrays["global-descriptors.npy"] @ global_query
    offsets = arrays["reference-offsets.npy"]
    eligible = [i for i in range(len(index["references"])) if int(offsets[i + 1] - offsets[i]) >= 8]
    retrieved = sorted(eligible, key=lambda i: float(similarities[i]), reverse=True)[:RETRIEVAL_REFERENCES]
    matches_by_reference = {}
    points3d = arrays["points3d.npy"]
    for reference_id in retrieved:
        start, stop = int(offsets[reference_id]), int(offsets[reference_id + 1])
        reference = reference_features(arrays, reference_id, device)
        with torch.inference_mode():
            output = matcher({"image0": query_features, "image1": reference})
        unbatched = rbd(output)
        pairs = unbatched["matches"].detach().cpu().numpy().astype(np.int32)
        scores = unbatched["scores"].detach().cpu().numpy().astype(np.float32)
        rows = [
            (int(pair[0]), start + int(pair[1]), float(score), reference_id)
            for pair, score in zip(pairs, scores)
        ]
        if len(rows) >= 8:
            matches_by_reference[reference_id] = rows

    intrinsics = challenge["intrinsics"]
    matrix = np.asarray([
        [float(intrinsics["flX"]), 0.0, float(intrinsics["cx"])],
        [0.0, float(intrinsics["flY"]), float(intrinsics["cy"])],
        [0.0, 0.0, 1.0],
    ], dtype=np.float64)
    height, width = int(intrinsics["h"]), int(intrinsics["w"])
    candidates = []
    for reference_id, rows in matches_by_reference.items():
        pose = solve_pose(rows, query_points, points3d, matrix, width, height)
        if pose is not None:
            pose.update({"selection": "single-reference", "seedReferenceId": reference_id})
            candidates.append(pose)
    centres = {row["referenceId"]: np.asarray(row["centre"], dtype=np.float64) for row in index["references"]}
    seeds = sorted(matches_by_reference, key=lambda ref: len(matches_by_reference[ref]), reverse=True)[:SEED_REFERENCES]
    available = list(matches_by_reference)
    for seed in seeds:
        neighbours = sorted(available, key=lambda ref: float(np.linalg.norm(centres[seed] - centres[ref])))[:CLUSTER_REFERENCES]
        combined = [row for reference_id in neighbours for row in matches_by_reference[reference_id]]
        pose = solve_pose(combined, query_points, points3d, matrix, width, height)
        if pose is not None:
            pose.update({"selection": "local-reference-cluster", "seedReferenceId": seed, "clusterReferenceIds": neighbours})
            candidates.append(pose)
    if not candidates:
        raise RuntimeError("no PnP candidate survived learned truth-free matching")
    best = max(candidates, key=candidate_rank)
    report = {
        "schemaVersion": "1.0",
        "runId": args.run_id,
        "querySha256": record["sha256"],
        "groundTruthRead": False,
        "hardcodedPoseUsed": False,
        "cachedQueryPoseUsed": False,
        "method": index["method"],
        "queryKeypoints": len(query_points),
        "retrievedReferences": len(retrieved),
        "referencesWithMatches": len(matches_by_reference),
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
