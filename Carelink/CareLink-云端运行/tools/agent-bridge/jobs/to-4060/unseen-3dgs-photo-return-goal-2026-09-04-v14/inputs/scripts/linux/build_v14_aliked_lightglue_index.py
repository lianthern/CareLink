#!/usr/bin/env python3
"""Build a query-blind ALIKED feature cache over the immutable SIFT 3D tracks."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any

import numpy as np


CHALLENGE_ID = "v14-fixed-real-panorama-photo-q2"
METHOD = "aliked-lightglue-to-training-sift-tracks-v1"
LIGHTGLUE_COMMIT = "eb42fee2d71449efb0aa5c10549752b5d75384d8"
LIGHTGLUE_LICENSE_SHA256 = "0e6031ed3e62dc91dc8b1c8f240abd200b1083f60773362e64e339fe01d1bf18"
KORNIA_COMMIT = "bfb2a8370de15813ddaa4846979c47cd2198f8b3"
KORNIA_LICENSE_SHA256 = "a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9"
ALIKED_WEIGHT_SHA256 = "5be8704840ed662d9d8c561bf7279c222092674e7eb05fd0feab94899e9d82f2"
LIGHTGLUE_WEIGHT_SHA256 = "d975e965b105311a6143194852297dff4f02aea5cc2e10cecfed966ca0e22503"


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


def verify_source(root: Path, expected_revision: str, license_sha: str, name: str) -> None:
    if not (root / ".git").is_dir():
        raise RuntimeError(f"{name} checkout is missing: {root}")
    revision = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if revision != expected_revision:
        raise RuntimeError(f"unexpected {name} revision: {revision}")
    if sha256(root / "LICENSE") != license_sha:
        raise RuntimeError(f"{name} LICENSE hash mismatch")


def verify_weights() -> None:
    torch_home = Path(os.environ.get("TORCH_HOME", Path.home() / ".cache" / "torch"))
    checkpoint_dir = torch_home / "hub" / "checkpoints"
    expected = {
        "aliked-n16.pth": ALIKED_WEIGHT_SHA256,
        "aliked_lightglue_v0-1_arxiv.pth": LIGHTGLUE_WEIGHT_SHA256,
    }
    for name, digest in expected.items():
        path = checkpoint_dir / name
        if not path.is_file() or sha256(path) != digest:
            raise RuntimeError(f"missing or unverified model weight: {path}")


def load_stack(lightglue_root: Path, kornia_root: Path, device: str):
    verify_source(lightglue_root, LIGHTGLUE_COMMIT, LIGHTGLUE_LICENSE_SHA256, "LightGlue")
    verify_source(kornia_root, KORNIA_COMMIT, KORNIA_LICENSE_SHA256, "Kornia")
    verify_weights()
    sys.path.insert(0, str(kornia_root))
    sys.path.insert(0, str(lightglue_root))
    import torch
    from lightglue import ALIKED
    from lightglue.utils import load_image, rbd

    if device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for the supplied learned-feature method")
    torch.set_grad_enabled(False)
    extractor = ALIKED(
        model_name="aliked-n16",
        max_num_keypoints=4096,
        detection_threshold=0.1,
        nms_radius=2,
    ).eval().to(device)
    return torch, extractor, load_image, rbd


def verify_sift_index(index_dir: Path, challenge_sha: str) -> tuple[dict[str, Any], dict[str, Path]]:
    index_path = index_dir / "INDEX.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if index.get("challengeId") != CHALLENGE_ID or index.get("challengeManifestSha256") != challenge_sha:
        raise RuntimeError("SIFT track index belongs to another challenge")
    if index.get("queryImagesOpened") != 0 or index.get("queryGroundTruthRead") is not False:
        raise RuntimeError("SIFT track index is not training-only")
    paths: dict[str, Path] = {}
    for name, record in index.get("files", {}).items():
        path = index_dir / name
        if not path.is_file() or path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise RuntimeError(f"SIFT track index file failed verification: {path}")
        paths[name] = path
    expected = {"points3d.npy", "descriptors.npy", "reference-ids.npy", "reference-keypoints.npy", "quality.npy"}
    if set(paths) != expected:
        raise RuntimeError("unexpected SIFT track index file set")
    return index, paths


def verify_existing(output: Path, challenge_sha: str) -> dict[str, Any]:
    index_path = output / "INDEX.json"
    if not index_path.is_file():
        raise RuntimeError(f"existing learned index is incomplete: {output}")
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if index.get("method") != METHOD or index.get("challengeManifestSha256") != challenge_sha:
        raise RuntimeError("existing learned index identity mismatch")
    if index.get("queryImagesOpened") != 0 or index.get("queryGroundTruthRead") is not False:
        raise RuntimeError("existing learned index is not query-blind")
    for relative, record in index.get("files", {}).items():
        path = safe_path(output, relative)
        if not path.is_file() or path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise RuntimeError(f"existing learned index file failed verification: {path}")
    return index


def build(
    challenge_path: Path,
    sift_index_dir: Path,
    output: Path,
    lightglue_root: Path,
    kornia_root: Path,
    device: str,
) -> dict[str, Any]:
    challenge_path = challenge_path.resolve()
    challenge_root = challenge_path.parent
    challenge_sha = sha256(challenge_path)
    challenge = json.loads(challenge_path.read_text(encoding="utf-8"))
    if challenge.get("challengeId") != CHALLENGE_ID or challenge.get("queryGroundTruthIncluded") is not False:
        raise RuntimeError("unexpected or truth-bearing challenge")
    if output.exists():
        return verify_existing(output, challenge_sha)
    sift_index, sift_files = verify_sift_index(sift_index_dir.resolve(), challenge_sha)
    training = challenge.get("training", [])
    references = sift_index.get("references", [])
    if len(training) != len(references) or len(training) != 450:
        raise RuntimeError("training/reference count mismatch")
    torch, extractor, load_image, rbd = load_stack(lightglue_root.resolve(), kornia_root.resolve(), device)

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="v14-aliked-index-", dir=output.parent) as temporary:
        staging = Path(temporary)
        feature_dir = staging / "features"
        feature_dir.mkdir()
        files: dict[str, dict[str, Any]] = {}
        for name, source in sift_files.items():
            destination = staging / name
            shutil.copy2(source, destination)
            files[name] = {"bytes": destination.stat().st_size, "sha256": sha256(destination)}

        learned_references = []
        with torch.inference_mode():
            for reference_id, (frame, reference) in enumerate(zip(training, references)):
                if int(reference.get("referenceId", -1)) != reference_id:
                    raise RuntimeError("SIFT reference ids are not contiguous")
                image_path = safe_path(challenge_root, frame["path"])
                if not image_path.is_file() or sha256(image_path) != frame["sha256"]:
                    raise RuntimeError(f"training image failed verification: {image_path}")
                image = load_image(image_path).to(device)
                features = rbd(extractor.extract(image))
                keypoints = features["keypoints"].detach().cpu().numpy().astype(np.float32)
                descriptors = features["descriptors"].detach().cpu().numpy().astype(np.float16)
                image_size = features["image_size"].detach().cpu().numpy().astype(np.float32)
                relative = f"features/ref-{reference_id:04d}.npz"
                feature_path = staging / relative
                np.savez(feature_path, keypoints=keypoints, descriptors=descriptors, image_size=image_size)
                files[relative] = {"bytes": feature_path.stat().st_size, "sha256": sha256(feature_path)}
                learned_references.append({
                    **reference,
                    "featurePath": relative,
                    "featureCount": int(len(keypoints)),
                    "trainingImageSha256": frame["sha256"],
                })
                del image, features

        index = {
            "schemaVersion": "1.0",
            "method": METHOD,
            "challengeId": CHALLENGE_ID,
            "challengeManifestSha256": challenge_sha,
            "queryImagesOpened": 0,
            "queryGroundTruthRead": False,
            "referenceCount": len(learned_references),
            "siftObservationCount": int(sift_index.get("observationCount", 0)),
            "dependency": {
                "name": "cvg/LightGlue",
                "sourceUrl": "https://github.com/cvg/LightGlue.git",
                "commit": LIGHTGLUE_COMMIT,
                "license": "Apache-2.0; ALIKED model/inference BSD-3-Clause per upstream README",
                "licenseSha256": LIGHTGLUE_LICENSE_SHA256,
                "alikedWeightUrl": "https://github.com/Shiaoming/ALIKED/raw/main/models/aliked-n16.pth",
                "alikedWeightSha256": ALIKED_WEIGHT_SHA256,
                "lightglueWeightUrl": "https://github.com/cvg/LightGlue/releases/download/v0.1_arxiv/aliked_lightglue.pth",
                "lightglueWeightSha256": LIGHTGLUE_WEIGHT_SHA256,
                "korniaSourceUrl": "https://github.com/kornia/kornia.git",
                "korniaCommit": KORNIA_COMMIT,
                "korniaLicense": "Apache-2.0",
                "korniaLicenseSha256": KORNIA_LICENSE_SHA256,
            },
            "parameters": {
                "extractor": "ALIKED-n16",
                "maxKeypoints": 4096,
                "detectionThreshold": 0.1,
                "resizeLongEdge": 1024,
                "device": device,
                "gpuFeatureExtractionImages": len(learned_references),
                "gpuTrainingRuns": 0,
            },
            "references": learned_references,
            "files": files,
        }
        (staging / "INDEX.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
        staging.rename(output)
    return index


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--challenge-manifest", required=True, type=Path)
    parser.add_argument("--sift-index-dir", required=True, type=Path)
    parser.add_argument("--index-dir", required=True, type=Path)
    parser.add_argument("--lightglue-root", required=True, type=Path)
    parser.add_argument("--kornia-root", required=True, type=Path)
    parser.add_argument("--device", choices=("cuda",), default="cuda")
    args = parser.parse_args()
    index = build(
        args.challenge_manifest,
        args.sift_index_dir,
        args.index_dir.resolve(),
        args.lightglue_root,
        args.kornia_root,
        args.device,
    )
    print(json.dumps({
        "status": "READY",
        "method": index["method"],
        "referenceCount": index["referenceCount"],
        "siftObservationCount": index["siftObservationCount"],
        "queryImagesOpened": index["queryImagesOpened"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
