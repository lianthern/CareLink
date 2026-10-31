#!/usr/bin/env python3
"""Build a truth-free, fixed-photo challenge from the accepted v11 cache.

The candidate locator receives training images/poses and five photometric forms
of the same held-out photograph.  The query pose is deliberately omitted.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any

import cv2
import numpy as np


V12_SHA256 = "a4c4d152695e9b8f1b335d5ff0cb83952aa1e1bd64cd0f269079eaa6c2bc3273"
SCHEMA_VERSION = "1.0"
CHALLENGE_ID = "v14-fixed-real-panorama-photo-q2"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_v12_module() -> Any:
    repo_root = Path(__file__).resolve().parents[6]
    path = repo_root / "jobs/to-4060/unseen-3dgs-360-photo-relocalization-2026-09-04-v12/inputs/scripts/linux/localize_v11_photos.py"
    if not path.is_file() or sha256(path) != V12_SHA256:
        raise RuntimeError(f"frozen v12 localizer missing or changed: {path}")
    spec = importlib.util.spec_from_file_location("frozen_v12_localizer_v14", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import frozen v12 localizer: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


V12 = load_v12_module()


def link_or_copy(source: Path, destination: Path) -> str:
    try:
        os.link(source, destination)
        return "hardlink"
    except OSError:
        shutil.copy2(source, destination)
        return "copy"


def write_jpeg(path: Path, image: np.ndarray, quality: int) -> None:
    if not cv2.imwrite(str(path), image, [cv2.IMWRITE_JPEG_QUALITY, quality]):
        raise RuntimeError(f"failed to write challenge image: {path}")


def gamma_image(image: np.ndarray, gamma: float) -> np.ndarray:
    table = np.asarray([round(((value / 255.0) ** gamma) * 255.0) for value in range(256)], dtype=np.uint8)
    return cv2.LUT(image, table)


def challenge_variants(image: np.ndarray) -> list[tuple[str, str, np.ndarray, int]]:
    return [
        ("final-01", "identity-jpeg-q98", image, 98),
        ("final-02", "identity-jpeg-q90", image, 90),
        ("final-03", "gamma-0.90", gamma_image(image, 0.90), 95),
        ("final-04", "gamma-1.10", gamma_image(image, 1.10), 95),
        ("final-05", "contrast-1.05-beta-minus-5", cv2.convertScaleAbs(image, alpha=1.05, beta=-5), 95),
    ]


def safe_relative(root: Path, relative: str) -> Path:
    path = Path(relative)
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe challenge path: {relative}")
    resolved = (root / path).resolve()
    if root.resolve() not in resolved.parents:
        raise ValueError(f"challenge path escapes root: {relative}")
    return resolved


def verify_existing(output: Path) -> dict[str, Any]:
    manifest_path = output / "challenge.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"existing challenge is incomplete; preserve it and investigate: {output}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != SCHEMA_VERSION or manifest.get("challengeId") != CHALLENGE_ID:
        raise RuntimeError(f"existing challenge identity mismatch: {manifest_path}")
    if manifest.get("queryGroundTruthIncluded") is not False:
        raise RuntimeError("existing challenge unexpectedly includes query truth")
    records = list(manifest.get("training", [])) + list(manifest.get("queryVariants", []))
    for record in records:
        path = safe_relative(output, record["path"])
        if not path.is_file() or path.stat().st_size != record["bytes"] or sha256(path) != record["sha256"]:
            raise RuntimeError(f"existing challenge file failed verification: {path}")
    return manifest


def build(dataset: Path, output: Path) -> dict[str, Any]:
    if output.exists():
        return verify_existing(output)
    transforms_path = dataset / "transforms.json"
    transforms = json.loads(transforms_path.read_text(encoding="utf-8"))
    train_frames, val_frames = V12.validate_and_index(transforms)
    queries = V12.select_queries(val_frames)
    if len(queries) != 3:
        raise RuntimeError("frozen v12 query selector no longer returns three queries")
    hard_query = queries[1]
    if hard_query.get("virtual_view") != "right" or Path(hard_query["file_path"]).stem != "val_1_0027__right":
        raise RuntimeError("frozen hard query identity changed")
    query_source = dataset / hard_query["file_path"]
    query_image = cv2.imread(str(query_source), cv2.IMREAD_COLOR)
    if query_image is None:
        raise RuntimeError(f"cannot read frozen hard query: {query_source}")
    height, width = query_image.shape[:2]
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="v14-challenge-", dir=output.parent) as temporary:
        staging = Path(temporary)
        train_dir = staging / "train"
        query_dir = staging / "queries"
        train_dir.mkdir()
        query_dir.mkdir()
        training = []
        hardlinks = 0
        copies = 0
        for index, frame in enumerate(sorted(train_frames, key=lambda row: row["file_path"])):
            source = dataset / frame["file_path"]
            suffix = source.suffix.lower() or ".jpg"
            relative = Path("train") / f"train-{index:04d}{suffix}"
            destination = staging / relative
            method = link_or_copy(source, destination)
            hardlinks += method == "hardlink"
            copies += method == "copy"
            training.append({
                "path": relative.as_posix(),
                "bytes": destination.stat().st_size,
                "sha256": sha256(destination),
                "sourcePanorama": frame.get("source_panorama"),
                "virtualView": frame.get("virtual_view"),
                "transformMatrixOpenGL": frame["transform_matrix"],
            })

        variants = []
        for run_id, operation, variant, quality in challenge_variants(query_image):
            relative = Path("queries") / f"{run_id}.jpg"
            destination = staging / relative
            write_jpeg(destination, variant, quality)
            variants.append({
                "runId": run_id,
                "path": relative.as_posix(),
                "bytes": destination.stat().st_size,
                "sha256": sha256(destination),
                "operation": operation,
                "width": width,
                "height": height,
            })

        manifest = {
            "schemaVersion": SCHEMA_VERSION,
            "challengeId": CHALLENGE_ID,
            "sourceType": "real-360-panorama-held-out-perspective",
            "sceneRevisionId": "360roam-base-posefix-r001",
            "sourceTransformsSha256": sha256(transforms_path),
            "queryGroundTruthIncluded": False,
            "sourceDatasetPathIncluded": False,
            "trainingCount": len(training),
            "queryVariantCount": len(variants),
            "intrinsics": {
                "w": int(transforms["w"]),
                "h": int(transforms["h"]),
                "flX": float(transforms["fl_x"]),
                "flY": float(transforms["fl_y"]),
                "cx": float(transforms["cx"]),
                "cy": float(transforms["cy"]),
            },
            "training": training,
            "queryVariants": variants,
            "construction": {"hardlinks": hardlinks, "copies": copies, "queryImagesReencoded": 5},
        }
        (staging / "challenge.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        staging.rename(output)
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = build(args.dataset.resolve(), args.output.resolve())
    print(json.dumps({
        "status": "READY",
        "challenge": str(args.output.resolve() / "challenge.json"),
        "trainingCount": manifest["trainingCount"],
        "queryVariantCount": manifest["queryVariantCount"],
        "queryGroundTruthIncluded": manifest["queryGroundTruthIncluded"],
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
