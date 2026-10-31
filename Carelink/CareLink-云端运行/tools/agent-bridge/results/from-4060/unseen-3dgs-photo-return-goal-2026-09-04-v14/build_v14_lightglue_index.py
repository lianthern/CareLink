#!/usr/bin/env python3
"""Build a query-blind SuperPoint/LightGlue 2D-3D index for v14.

Only challenge training images and their public training poses are opened.  Pair
selection uses ImageNet AlexNet descriptors and camera-centre proximity; exact
SuperPoint observations are accepted only when they satisfy the known-pose
epipolar and triangulation checks.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from typing import Any

import cv2
import numpy as np
import torch
import torch.nn.functional as functional
from torchvision.models import AlexNet_Weights, alexnet
from lightglue import LightGlue, SuperPoint
from lightglue.utils import rbd


CHALLENGE_ID = "v14-fixed-real-panorama-photo-q2"
HORIZONTAL_FACES = {
    "front", "front_right", "right", "back_right",
    "back", "back_left", "left", "front_left",
}
MAX_KEYPOINTS = 2048
CONTENT_NEIGHBOURS = 5
SPATIAL_NEIGHBOURS = 2
MAX_SAMPSON_ERROR_PX2 = 2.25
MAX_REPROJECTION_SUM_PX = 5.0


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


def load_geometry(path: Path):
    spec = importlib.util.spec_from_file_location("v14_training_geometry", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import geometry module: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verified_color(root: Path, frame: dict[str, Any]) -> np.ndarray:
    path = safe_path(root, frame["path"])
    if not path.is_file() or path.stat().st_size != int(frame["bytes"]) or sha256(path) != frame["sha256"]:
        raise RuntimeError(f"training image failed manifest verification: {path}")
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"cannot decode training image: {path}")
    return image


def alex_tensor(image: np.ndarray) -> torch.Tensor:
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (256, 256), interpolation=cv2.INTER_AREA)[16:240, 16:240]
    value = torch.from_numpy(resized).permute(2, 0, 1).float().div(255.0)
    mean = torch.tensor([0.485, 0.456, 0.406])[:, None, None]
    std = torch.tensor([0.229, 0.224, 0.225])[:, None, None]
    return (value - mean) / std


def gray_tensor(image: np.ndarray, device: torch.device) -> torch.Tensor:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return torch.from_numpy(gray).float().div(255.0)[None].to(device)


def cpu_features(value: dict[str, torch.Tensor]) -> dict[str, np.ndarray]:
    data = rbd(value)
    return {
        "keypoints": data["keypoints"].detach().cpu().numpy().astype(np.float32),
        "descriptors": data["descriptors"].detach().cpu().numpy().astype(np.float16),
        "keypoint_scores": data["keypoint_scores"].detach().cpu().numpy().astype(np.float16),
        "image_size": data["image_size"].detach().cpu().numpy().astype(np.float32),
    }


def gpu_features(value: dict[str, np.ndarray], device: torch.device) -> dict[str, torch.Tensor]:
    return {
        "keypoints": torch.from_numpy(value["keypoints"])[None].to(device),
        "descriptors": torch.from_numpy(value["descriptors"].astype(np.float32))[None].to(device),
        "keypoint_scores": torch.from_numpy(value["keypoint_scores"].astype(np.float32))[None].to(device),
        "image_size": torch.from_numpy(value["image_size"])[None].to(device),
    }


def match_pair(
    matcher: LightGlue,
    first: dict[str, np.ndarray],
    second: dict[str, np.ndarray],
    device: torch.device,
) -> np.ndarray:
    with torch.inference_mode():
        output = matcher({"image0": gpu_features(first, device), "image1": gpu_features(second, device)})
    return rbd(output)["matches"].detach().cpu().numpy().astype(np.int32)


def verify_existing(index_dir: Path, challenge_sha: str) -> dict[str, Any]:
    manifest_path = index_dir / "INDEX.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"existing index is incomplete: {index_dir}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("challengeManifestSha256") != challenge_sha:
        raise RuntimeError("existing index identity mismatch")
    for name, record in manifest.get("files", {}).items():
        path = index_dir / name
        if not path.is_file() or path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise RuntimeError(f"existing index file failed verification: {path}")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--challenge-manifest", required=True, type=Path)
    parser.add_argument("--index-dir", required=True, type=Path)
    parser.add_argument("--geometry-module", required=True, type=Path)
    args = parser.parse_args()
    challenge_path = args.challenge_manifest.resolve()
    challenge_root = challenge_path.parent
    index_dir = args.index_dir.resolve()
    challenge_sha = sha256(challenge_path)
    if index_dir.exists():
        existing = verify_existing(index_dir, challenge_sha)
        print(json.dumps({"status": "READY", "existing": True, "observations": existing["observationCount"]}))
        return 0

    challenge = json.loads(challenge_path.read_text(encoding="utf-8"))
    if challenge.get("challengeId") != CHALLENGE_ID or challenge.get("queryGroundTruthIncluded") is not False:
        raise RuntimeError("unexpected or truth-bearing challenge")
    training = challenge.get("training", [])
    if len(training) != 450 or challenge.get("queryVariantCount") != 5:
        raise RuntimeError("v14 challenge must contain the frozen 450/5 split")
    geometry = load_geometry(args.geometry_module.resolve())
    matrix = geometry.intrinsics(challenge)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda":
        raise RuntimeError("this indexed learned-feature method requires the approved local CUDA GPU")

    print("phase=verify-and-alexnet training=450 queriesOpened=0", flush=True)
    images: list[np.ndarray] = []
    centres = []
    references = []
    for reference_id, frame in enumerate(training):
        image = verified_color(challenge_root, frame)
        images.append(image)
        _, centre, _, _ = geometry.camera_cv(frame)
        centres.append(centre)
        references.append({
            "referenceId": reference_id,
            "path": frame["path"],
            "sourcePanorama": frame.get("sourcePanorama"),
            "virtualView": frame.get("virtualView"),
            "centre": centre.tolist(),
        })
        if (reference_id + 1) % 50 == 0:
            print(f"verified={reference_id + 1}/450", flush=True)

    alex = alexnet(weights=AlexNet_Weights.IMAGENET1K_V1).features.eval().to(device)
    global_rows = []
    for start in range(0, len(images), 32):
        batch = torch.stack([alex_tensor(image) for image in images[start:start + 32]]).to(device)
        with torch.inference_mode():
            values = alex(batch)
            values = functional.adaptive_avg_pool2d(values, 1).flatten(1)
            values = functional.normalize(values, dim=1)
        global_rows.append(values.cpu().numpy().astype(np.float32))
    global_descriptors = np.concatenate(global_rows, axis=0)
    del alex, batch, global_rows
    torch.cuda.empty_cache()

    print("phase=superpoint horizontalReferences=400", flush=True)
    extractor = SuperPoint(max_num_keypoints=MAX_KEYPOINTS).eval().to(device)
    local_features: dict[int, dict[str, np.ndarray]] = {}
    horizontal_ids = [i for i, frame in enumerate(training) if frame.get("virtualView") in HORIZONTAL_FACES]
    if len(horizontal_ids) != 400:
        raise RuntimeError(f"expected 400 horizontal references, got {len(horizontal_ids)}")
    for number, reference_id in enumerate(horizontal_ids, start=1):
        with torch.inference_mode():
            value = extractor.extract(gray_tensor(images[reference_id], device))
        local_features[reference_id] = cpu_features(value)
        if number % 40 == 0:
            print(f"superpoint={number}/400", flush=True)
    del extractor, images
    torch.cuda.empty_cache()

    centre_array = np.asarray(centres, dtype=np.float64)
    scene_extent = float(np.linalg.norm(centre_array.max(axis=0) - centre_array.min(axis=0)))
    min_baseline = max(scene_extent * 0.002, 1e-4)
    similarities = global_descriptors @ global_descriptors.T
    pair_set: set[tuple[int, int]] = set()
    for reference_id in horizontal_ids:
        eligible = [
            other for other in horizontal_ids
            if other != reference_id and np.linalg.norm(centre_array[reference_id] - centre_array[other]) > min_baseline
        ]
        content = sorted(eligible, key=lambda other: float(similarities[reference_id, other]), reverse=True)[
            :CONTENT_NEIGHBOURS
        ]
        spatial = sorted(eligible, key=lambda other: float(np.linalg.norm(
            centre_array[reference_id] - centre_array[other]
        )))[:SPATIAL_NEIGHBOURS]
        for other in content + spatial:
            pair_set.add(tuple(sorted((reference_id, other))))
    del similarities
    print(f"phase=lightglue trainingPairs={len(pair_set)} queriesOpened=0", flush=True)

    matcher = LightGlue(features="superpoint").eval().to(device)
    observations: dict[tuple[int, int], tuple[np.ndarray, float]] = {}
    raw_matches = 0
    epipolar_inliers = 0
    triangulated = 0
    pair_reports = []
    for pair_number, (first_id, second_id) in enumerate(sorted(pair_set), start=1):
        first = local_features[first_id]
        second = local_features[second_id]
        pairs = match_pair(matcher, first, second, device)
        raw_matches += len(pairs)
        accepted = 0
        if len(pairs) >= 8:
            points_a = first["keypoints"][pairs[:, 0]]
            points_b = second["keypoints"][pairs[:, 1]]
            try:
                fundamental = geometry.fundamental_from_poses(training[first_id], training[second_id], matrix)
            except ValueError:
                fundamental = None
            if fundamental is not None:
                errors = geometry.sampson_errors(fundamental, points_a, points_b)
                epipolar_keep = errors <= MAX_SAMPSON_ERROR_PX2
                epipolar_inliers += int(epipolar_keep.sum())
                kept = np.where(epipolar_keep)[0]
                if len(kept):
                    points_3d, valid, reprojection = geometry.triangulate_pair(
                        training[first_id], training[second_id], points_a[kept], points_b[kept], matrix
                    )
                    valid &= reprojection <= MAX_REPROJECTION_SUM_PX
                    accepted = int(valid.sum())
                    triangulated += accepted
                    for local_row in np.where(valid)[0]:
                        original_row = int(kept[local_row])
                        point = points_3d[local_row].astype(np.float32)
                        quality = float(reprojection[local_row] + errors[original_row])
                        for ref_id, keypoint_id in (
                            (first_id, int(pairs[original_row, 0])),
                            (second_id, int(pairs[original_row, 1])),
                        ):
                            key = (ref_id, keypoint_id)
                            prior = observations.get(key)
                            if prior is None or quality < prior[1]:
                                observations[key] = (point, quality)
        if accepted >= 8:
            pair_reports.append({"first": first_id, "second": second_id, "matches": len(pairs), "tracks": accepted})
        if pair_number % 100 == 0 or pair_number == len(pair_set):
            print(
                f"matchedPairs={pair_number}/{len(pair_set)} observations={len(observations)} "
                f"triangulated={triangulated}", flush=True
            )

    if len(observations) < 2000:
        raise RuntimeError(f"learned training-only index has only {len(observations)} observations")
    ordered = sorted(observations.items(), key=lambda row: (row[0][0], row[0][1]))
    offsets = [0]
    all_keypoints = []
    all_descriptors = []
    all_scores = []
    all_points = []
    all_quality = []
    cursor = 0
    by_reference: dict[int, list[tuple[int, np.ndarray, float]]] = {}
    for (reference_id, keypoint_id), (point, quality) in ordered:
        by_reference.setdefault(reference_id, []).append((keypoint_id, point, quality))
    for reference_id in range(len(training)):
        feature = local_features.get(reference_id)
        rows = by_reference.get(reference_id, [])
        if feature is not None and rows:
            indices = np.asarray([row[0] for row in rows], dtype=np.int32)
            all_keypoints.append(feature["keypoints"][indices])
            all_descriptors.append(feature["descriptors"][indices])
            all_scores.append(feature["keypoint_scores"][indices])
            all_points.append(np.asarray([row[1] for row in rows], dtype=np.float32))
            all_quality.append(np.asarray([row[2] for row in rows], dtype=np.float32))
            cursor += len(rows)
        offsets.append(cursor)

    arrays = {
        "global-descriptors.npy": global_descriptors.astype(np.float32),
        "reference-offsets.npy": np.asarray(offsets, dtype=np.int64),
        "reference-keypoints.npy": np.concatenate(all_keypoints).astype(np.float32),
        "reference-descriptors.npy": np.concatenate(all_descriptors).astype(np.float16),
        "reference-scores.npy": np.concatenate(all_scores).astype(np.float16),
        "points3d.npy": np.concatenate(all_points).astype(np.float32),
        "quality.npy": np.concatenate(all_quality).astype(np.float32),
    }
    index_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="v14-lightglue-index-", dir=index_dir.parent))
    for name, value in arrays.items():
        np.save(staging / name, value, allow_pickle=False)
    manifest = {
        "schemaVersion": "1.0",
        "method": "alexnet-superpoint-lightglue-training-track-v1",
        "challengeId": CHALLENGE_ID,
        "challengeManifestSha256": challenge_sha,
        "queryImagesOpened": 0,
        "queryGroundTruthRead": False,
        "device": str(device),
        "referenceCount": len(training),
        "horizontalReferenceCount": len(horizontal_ids),
        "observationCount": len(observations),
        "attemptedTrainingPairs": len(pair_set),
        "rawLightGlueMatches": raw_matches,
        "knownPoseEpipolarInliers": epipolar_inliers,
        "triangulatedBeforeBestPerKeypoint": triangulated * 2,
        "parameters": {
            "maxKeypoints": MAX_KEYPOINTS,
            "contentNeighbours": CONTENT_NEIGHBOURS,
            "spatialNeighbours": SPATIAL_NEIGHBOURS,
            "maxSampsonErrorPx2": MAX_SAMPSON_ERROR_PX2,
            "maxReprojectionSumPx": MAX_REPROJECTION_SUM_PX,
        },
        "references": references,
        "successfulPairSample": sorted(pair_reports, key=lambda row: row["tracks"], reverse=True)[:50],
        "files": {},
    }
    for name in arrays:
        path = staging / name
        manifest["files"][name] = {"bytes": path.stat().st_size, "sha256": sha256(path)}
    (staging / "INDEX.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    staging.rename(index_dir)
    print(json.dumps({
        "status": "READY",
        "method": manifest["method"],
        "referenceCount": manifest["referenceCount"],
        "observationCount": manifest["observationCount"],
        "attemptedTrainingPairs": manifest["attemptedTrainingPairs"],
        "queryImagesOpened": 0,
        "index": str(index_dir),
    }, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
