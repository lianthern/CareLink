#!/usr/bin/env python3
"""Validate and prepare the frozen NerfBaselines T&T Meetingroom archive.

The archive contains half-resolution JPEGs but the original-resolution COLMAP
camera model. This script safely extracts the exact expected members and makes
the same factor-two camera calibration copy used by NerfBaselines.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import shutil
import struct
import tarfile
import tempfile


EXPECTED_BYTES = 169_378_633
EXPECTED_SHA256 = "2e1f86fd7b25314fbc0361b42f16bf77ee222ac50294777995e8ab737aee8d33"
EXPECTED_IMAGE_NAMES = {f"{index:06d}.jpg" for index in range(1, 372)}
EXPECTED_WIDTH = 980
EXPECTED_HEIGHT = 543
EXPECTED_CAMERA_MODEL_ID = 1  # COLMAP PINHOLE
EXPECTED_ORIGINAL_WIDTH = 1960
EXPECTED_ORIGINAL_HEIGHT = 1086
EXPECTED_ORIGINAL_PARAMS = (1159.0417832127093, 1159.0417832127093, 980.0, 543.0)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def jpeg_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        if handle.read(2) != b"\xff\xd8":
            raise ValueError(f"not a JPEG: {path}")
        while True:
            marker_start = handle.read(1)
            if not marker_start:
                raise ValueError(f"JPEG has no SOF marker: {path}")
            if marker_start != b"\xff":
                continue
            marker = handle.read(1)
            while marker == b"\xff":
                marker = handle.read(1)
            if marker in {b"\xd8", b"\xd9"}:
                continue
            length_raw = handle.read(2)
            if len(length_raw) != 2:
                raise ValueError(f"truncated JPEG marker: {path}")
            length = struct.unpack(">H", length_raw)[0]
            if length < 2:
                raise ValueError(f"invalid JPEG marker length: {path}")
            if marker[0] in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                payload = handle.read(length - 2)
                if len(payload) < 5:
                    raise ValueError(f"truncated JPEG SOF: {path}")
                height, width = struct.unpack(">HH", payload[1:5])
                return width, height
            handle.seek(length - 2, os.SEEK_CUR)


def read_cameras(path: Path) -> list[dict]:
    cameras: list[dict] = []
    with path.open("rb") as handle:
        count = struct.unpack("<Q", handle.read(8))[0]
        for _ in range(count):
            camera_id, model_id, width, height = struct.unpack("<iiQQ", handle.read(24))
            param_count = {0: 3, 1: 4, 2: 4, 3: 5, 4: 8, 5: 8, 6: 12, 7: 5, 8: 4, 9: 5, 10: 12}.get(model_id)
            if param_count is None:
                raise ValueError(f"unsupported COLMAP camera model id: {model_id}")
            params = struct.unpack("<" + "d" * param_count, handle.read(8 * param_count))
            cameras.append({
                "cameraId": camera_id,
                "modelId": model_id,
                "width": width,
                "height": height,
                "params": params,
            })
        if handle.read(1):
            raise ValueError("unexpected trailing bytes in cameras.bin")
    return cameras


def write_scaled_camera(path: Path, camera: dict) -> None:
    params = tuple(float(value) / 2.0 for value in camera["params"])
    with path.open("wb") as handle:
        handle.write(struct.pack("<Q", 1))
        handle.write(struct.pack(
            "<iiQQ",
            camera["cameraId"],
            camera["modelId"],
            camera["width"] // 2,
            camera["height"] // 2,
        ))
        handle.write(struct.pack("<dddd", *params))


def inspect_images(path: Path) -> dict:
    names: set[str] = set()
    camera_ids: set[int] = set()
    observation_counts: list[int] = []
    with path.open("rb") as handle:
        image_count = struct.unpack("<Q", handle.read(8))[0]
        for _ in range(image_count):
            row = struct.unpack("<idddddddi", handle.read(64))
            camera_ids.add(row[-1])
            name_bytes = bytearray()
            while True:
                char = handle.read(1)
                if not char:
                    raise ValueError("truncated image name in images.bin")
                if char == b"\x00":
                    break
                name_bytes.extend(char)
            name = name_bytes.decode("utf-8")
            if "/" in name or "\\" in name:
                raise ValueError(f"unexpected image path in images.bin: {name}")
            names.add(name)
            points_count = struct.unpack("<Q", handle.read(8))[0]
            valid_observations = 0
            for _ in range(points_count):
                _, _, point_id = struct.unpack("<ddq", handle.read(24))
                if point_id >= 0:
                    valid_observations += 1
            observation_counts.append(valid_observations)
        if handle.read(1):
            raise ValueError("unexpected trailing bytes in images.bin")
    return {
        "registeredImages": image_count,
        "names": names,
        "cameraIds": camera_ids,
        "meanObservationsPerImage": sum(observation_counts) / len(observation_counts),
        "minimumObservationsPerImage": min(observation_counts),
    }


def expected_members() -> set[str]:
    members = {
        "meetingroom/sparse",
        "meetingroom/sparse/cameras.bin",
        "meetingroom/sparse/images.bin",
        "meetingroom/sparse/points3D.bin",
        "meetingroom/images_2",
    }
    members.update(f"meetingroom/images_2/{name}" for name in EXPECTED_IMAGE_NAMES)
    return members


def validate_archive(archive: Path) -> list[tarfile.TarInfo]:
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
    actual: set[str] = set()
    for member in members:
        normalized = member.name.rstrip("/")
        pure = PurePosixPath(normalized)
        if pure.is_absolute() or ".." in pure.parts or member.issym() or member.islnk():
            raise ValueError(f"unsafe tar member: {member.name}")
        if not (member.isdir() or member.isfile()):
            raise ValueError(f"unsupported tar member type: {member.name}")
        actual.add(normalized)
    expected = expected_members()
    if actual != expected:
        missing = sorted(expected - actual)[:10]
        extra = sorted(actual - expected)[:10]
        raise ValueError(f"archive member mismatch; missing={missing}; extra={extra}")
    return members


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    archive = args.archive.resolve()
    output = args.output.resolve()

    if archive.stat().st_size != EXPECTED_BYTES:
        raise ValueError(f"archive bytes mismatch: {archive.stat().st_size} != {EXPECTED_BYTES}")
    archive_hash = sha256(archive)
    if archive_hash != EXPECTED_SHA256:
        raise ValueError(f"archive SHA256 mismatch: {archive_hash}")
    members = validate_archive(archive)

    ready_report = output / ".prepared.json"
    if output.exists():
        if ready_report.is_file():
            prior = json.loads(ready_report.read_text(encoding="utf-8"))
            if prior.get("archiveSha256") == EXPECTED_SHA256 and prior.get("status") == "READY":
                print(json.dumps(prior, indent=2))
                return 0
        raise FileExistsError(f"refusing to overwrite existing output: {output}")

    output.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}.extract-", dir=output.parent))
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            for member in members:
                bundle.extract(member, path=staging)
        extracted = staging / "meetingroom"
        image_dir = extracted / "images_2"
        image_names = {path.name for path in image_dir.iterdir() if path.is_file()}
        if image_names != EXPECTED_IMAGE_NAMES:
            raise ValueError("extracted JPEG set is not exactly 000001.jpg through 000371.jpg")
        bad_dimensions = []
        for name in sorted(image_names):
            dimensions = jpeg_dimensions(image_dir / name)
            if dimensions != (EXPECTED_WIDTH, EXPECTED_HEIGHT):
                bad_dimensions.append((name, dimensions))
                if len(bad_dimensions) == 5:
                    break
        if bad_dimensions:
            raise ValueError(f"unexpected JPEG dimensions: {bad_dimensions}")

        sparse = extracted / "sparse"
        cameras = read_cameras(sparse / "cameras.bin")
        if len(cameras) != 1:
            raise ValueError(f"expected one COLMAP camera, found {len(cameras)}")
        camera = cameras[0]
        if camera["modelId"] != EXPECTED_CAMERA_MODEL_ID:
            raise ValueError(f"expected PINHOLE model id 1, got {camera['modelId']}")
        if (camera["width"], camera["height"]) != (EXPECTED_ORIGINAL_WIDTH, EXPECTED_ORIGINAL_HEIGHT):
            raise ValueError(f"unexpected original camera dimensions: {camera['width']}x{camera['height']}")
        if any(not math.isclose(actual, expected, rel_tol=0, abs_tol=1e-9) for actual, expected in zip(camera["params"], EXPECTED_ORIGINAL_PARAMS)):
            raise ValueError(f"unexpected original camera parameters: {camera['params']}")

        image_model = inspect_images(sparse / "images.bin")
        if image_model["registeredImages"] != 371 or image_model["names"] != EXPECTED_IMAGE_NAMES:
            raise ValueError("COLMAP images.bin does not register the exact 371-image set")
        if image_model["cameraIds"] != {camera["cameraId"]}:
            raise ValueError(f"unexpected COLMAP camera ids: {image_model['cameraIds']}")
        with (sparse / "points3D.bin").open("rb") as handle:
            points_count = struct.unpack("<Q", handle.read(8))[0]
        if points_count != 124_162:
            raise ValueError(f"unexpected sparse point count: {points_count}")

        scaled_sparse = extracted / "sparse_2" / "0"
        scaled_sparse.mkdir(parents=True)
        shutil.copy2(sparse / "images.bin", scaled_sparse / "images.bin")
        shutil.copy2(sparse / "points3D.bin", scaled_sparse / "points3D.bin")
        write_scaled_camera(scaled_sparse / "cameras.bin", camera)
        scaled_camera = read_cameras(scaled_sparse / "cameras.bin")[0]

        report = {
            "schemaVersion": "1.0",
            "status": "READY",
            "archiveBytes": EXPECTED_BYTES,
            "archiveSha256": archive_hash,
            "archiveEntries": len(members),
            "images": 371,
            "imageWidth": EXPECTED_WIDTH,
            "imageHeight": EXPECTED_HEIGHT,
            "registeredImages": image_model["registeredImages"],
            "registeredFraction": 1.0,
            "cameraModel": "PINHOLE",
            "cameraCount": 1,
            "scaledCameraWidth": scaled_camera["width"],
            "scaledCameraHeight": scaled_camera["height"],
            "scaledCameraParams": list(scaled_camera["params"]),
            "points3D": points_count,
            "meanObservationsPerImage": image_model["meanObservationsPerImage"],
            "minimumObservationsPerImage": image_model["minimumObservationsPerImage"],
            "imagesPath": "images_2",
            "colmapPath": "sparse_2/0",
        }
        (extracted / ".prepared.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        os.replace(extracted, output)
        print(json.dumps(report, indent=2))
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
