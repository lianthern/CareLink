#!/usr/bin/env python3
"""Reuse/download and adapt the frozen 360Roam/base subset for Nerfstudio.

The public Synology share is read file-by-file over HTTPS. Downloads are
resumable, verified against the job manifest, and never re-uploaded. The
adapter converts each 2:1 panorama into nine overlapping pinhole views while
preserving the provided camera centre. 360Roam publishes OpenCV camera-to-world
poses; every virtual face is explicitly converted to Nerfstudio/OpenGL axes.
"""

from __future__ import annotations

import argparse
import hashlib
import http.cookiejar
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


BASE_URL = "https://hkust-vgd.nas.ust.hk:5001"
SHARE_ID = "LSeTZWca6"
REMOTE_ROOT = "/360Roam_dataset/base"
EXPECTED_PANO_SIZE = (6080, 3040)
EXPECTED_SOURCE_IMAGES = 198
EXPECTED_TRAIN_SOURCE_IMAGES = 50
EXPECTED_VAL_SOURCE_IMAGES = 10
FACE_SIZE = 1024
FACE_FOV_DEGREES = 100.0
FACE_SPECS = (
    ("front", 0.0, 0.0),
    ("front_right", 45.0, 0.0),
    ("right", 90.0, 0.0),
    ("back_right", 135.0, 0.0),
    ("back", 180.0, 0.0),
    ("back_left", -135.0, 0.0),
    ("left", -90.0, 0.0),
    ("front_left", -45.0, 0.0),
    ("up", 0.0, 65.0),
)
OPENCV_TO_OPENGL = (
    (1.0, 0.0, 0.0, 0.0),
    (0.0, -1.0, 0.0, 0.0),
    (0.0, 0.0, -1.0, 0.0),
    (0.0, 0.0, 0.0, 1.0),
)


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
            if marker[0] in {
                0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
            }:
                payload = handle.read(length - 2)
                if len(payload) < 5:
                    raise ValueError(f"truncated JPEG SOF: {path}")
                height, width = struct.unpack(">HH", payload[1:5])
                return width, height
            handle.seek(length - 2, os.SEEK_CUR)


def evenly_spaced_indices(length: int, count: int) -> list[int]:
    if count < 2 or length < count:
        raise ValueError("selection requires 2 <= count <= length")
    return [round(index * (length - 1) / (count - 1)) for index in range(count)]


def selected_source_names(pose_data: dict) -> dict[str, list[str]]:
    train = pose_data.get("train")
    test = pose_data.get("test")
    if not isinstance(train, list) or not isinstance(test, list):
        raise ValueError("pose_c2w.json must contain train and test lists")
    if len(train) != 148 or len(test) != 50:
        raise ValueError(f"unexpected pose split counts: train={len(train)} test={len(test)}")
    train_names = [train[index]["rgb_file"] for index in evenly_spaced_indices(len(train), EXPECTED_TRAIN_SOURCE_IMAGES)]
    val_names = [test[index]["rgb_file"] for index in evenly_spaced_indices(len(test), EXPECTED_VAL_SOURCE_IMAGES)]
    if len(set(train_names + val_names)) != EXPECTED_TRAIN_SOURCE_IMAGES + EXPECTED_VAL_SOURCE_IMAGES:
        raise ValueError("selected source panorama names are not unique")
    return {"train": train_names, "val": val_names}


def validate_pose_data(pose_data: dict) -> dict[str, list[dict]]:
    by_name: dict[str, dict] = {}
    total = 0
    for split in ("train", "test"):
        rows = pose_data.get(split)
        if not isinstance(rows, list):
            raise ValueError(f"missing pose split: {split}")
        for row in rows:
            name = row.get("rgb_file")
            matrix = row.get("transform_matrix")
            if not isinstance(name, str) or not name.endswith(".jpg") or "/" in name or "\\" in name:
                raise ValueError(f"unsafe or invalid pose filename: {name!r}")
            if name in by_name:
                raise ValueError(f"duplicate pose filename: {name}")
            if not isinstance(matrix, list) or len(matrix) != 4 or any(not isinstance(values, list) or len(values) != 4 for values in matrix):
                raise ValueError(f"pose for {name} is not 4x4")
            values = [float(value) for line in matrix for value in line]
            if not all(math.isfinite(value) for value in values):
                raise ValueError(f"pose for {name} contains non-finite values")
            if any(abs(float(actual) - expected) > 1e-7 for actual, expected in zip(matrix[3], (0.0, 0.0, 0.0, 1.0))):
                raise ValueError(f"pose for {name} has an invalid homogeneous row")
            rotation = [[float(matrix[row_index][column]) for column in range(3)] for row_index in range(3)]
            determinant = determinant3(rotation)
            if abs(determinant - 1.0) > 2e-3:
                raise ValueError(f"pose for {name} has rotation determinant {determinant}")
            normalized = [[float(value) for value in line] for line in matrix]
            by_name[name] = {"rgb_file": name, "transform_matrix": normalized, "source_split": split}
            total += 1
    if total != EXPECTED_SOURCE_IMAGES:
        raise ValueError(f"expected {EXPECTED_SOURCE_IMAGES} source poses, got {total}")
    selected = selected_source_names(pose_data)
    return {split: [by_name[name] for name in names] for split, names in selected.items()}


def determinant3(matrix: list[list[float]]) -> float:
    return (
        matrix[0][0] * (matrix[1][1] * matrix[2][2] - matrix[1][2] * matrix[2][1])
        - matrix[0][1] * (matrix[1][0] * matrix[2][2] - matrix[1][2] * matrix[2][0])
        + matrix[0][2] * (matrix[1][0] * matrix[2][1] - matrix[1][1] * matrix[2][0])
    )


def mat4_multiply(left: list[list[float]], right: list[list[float]]) -> list[list[float]]:
    return [
        [sum(float(left[row][inner]) * float(right[inner][column]) for inner in range(4)) for column in range(4)]
        for row in range(4)
    ]


def face_rotation_opencv(yaw_degrees: float, pitch_degrees: float) -> list[list[float]]:
    """Return face-camera OpenCV axes in the source panorama camera frame.

    Both 360Roam and the pixel rays emitted by FFmpeg's flat projection use
    OpenCV camera axes: +X right, +Y down, +Z forward. Positive FFmpeg yaw looks
    right, so it is a positive mathematical Y rotation. Positive pitch looks
    up, which is negative Y in this convention and is produced by +X rotation.
    """
    yaw = math.radians(yaw_degrees)
    pitch = math.radians(pitch_degrees)
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    rotate_y = [
        [cy, 0.0, sy, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [-sy, 0.0, cy, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    rotate_x = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, cp, -sp, 0.0],
        [0.0, sp, cp, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    return mat4_multiply(rotate_y, rotate_x)


def virtual_face_c2w_opengl(
    source_c2w_opencv: list[list[float]], yaw_degrees: float, pitch_degrees: float
) -> list[list[float]]:
    """Convert one 360Roam OpenCV c2w into a Nerfstudio/OpenGL face c2w."""
    face_c2w_opencv = mat4_multiply(
        source_c2w_opencv, face_rotation_opencv(yaw_degrees, pitch_degrees)
    )
    return mat4_multiply(face_c2w_opencv, [list(row) for row in OPENCV_TO_OPENGL])


class SynologyPublicShare:
    def __init__(self) -> None:
        cookie_jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
        self.entry_url = BASE_URL + "/sharing/webapi/entry.cgi"
        self.headers = {"User-Agent": "UNSEEN-360Roam-v11/1.0", "X-SYNO-SHARING": SHARE_ID}

    def _json_post(self, payload: dict, *, include_share_header: bool = True) -> dict:
        headers = dict(self.headers)
        if not include_share_header:
            headers.pop("X-SYNO-SHARING", None)
        request = urllib.request.Request(
            self.entry_url,
            data=urllib.parse.urlencode(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        with self.opener.open(request, timeout=60) as response:
            body = json.load(response)
        if not body.get("success"):
            raise RuntimeError(f"Synology API rejected request: {body}")
        return body["data"]

    def login(self) -> None:
        self._json_post({
            "api": "SYNO.Core.Sharing.Login",
            "version": 1,
            "method": "login",
            "sharing_id": SHARE_ID,
            "password": "",
        }, include_share_header=False)

    def list_folder(self, remote_path: str) -> list[dict]:
        data = self._json_post({
            "api": "SYNO.FolderSharing.List",
            "version": 2,
            "method": "list",
            "offset": 0,
            "limit": 1000,
            "sort_by": '"name"',
            "sort_direction": '"ASC"',
            "action": '"enum"',
            "filetype": '"all"',
            "additional": json.dumps(["size", "time", "type"]),
            "folder_path": json.dumps(remote_path),
            "_sharing_id": json.dumps(SHARE_ID),
        })
        if data.get("total") != len(data.get("files", [])):
            raise RuntimeError("unexpected paginated Synology listing")
        return data["files"]

    def download(self, remote_path: str, destination: Path, expected_bytes: int, expected_sha256: str) -> None:
        if destination.is_file():
            if destination.stat().st_size == expected_bytes and sha256(destination) == expected_sha256:
                return
            raise ValueError(f"refusing to overwrite invalid completed file: {destination}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        part = destination.with_name(destination.name + ".part")
        if part.exists() and part.stat().st_size > expected_bytes:
            raise ValueError(f"partial file exceeds expected bytes: {part}")
        last_error: Exception | None = None
        for attempt in range(1, 6):
            have = part.stat().st_size if part.exists() else 0
            query = urllib.parse.urlencode({
                "api": "SYNO.FolderSharing.Download",
                "version": 2,
                "method": "download",
                "mode": '"download"',
                "_sharing_id": json.dumps(SHARE_ID),
                "path": json.dumps([remote_path]),
            })
            headers = dict(self.headers)
            if have:
                headers["Range"] = f"bytes={have}-"
            request = urllib.request.Request(self.entry_url + "?" + query, headers=headers, method="GET")
            try:
                with self.opener.open(request, timeout=90) as response:
                    status = getattr(response, "status", response.getcode())
                    if have and status != 206:
                        have = 0
                        part.unlink(missing_ok=True)
                    mode = "ab" if have else "wb"
                    with part.open(mode) as handle:
                        while True:
                            chunk = response.read(1024 * 1024)
                            if not chunk:
                                break
                            handle.write(chunk)
                if part.stat().st_size != expected_bytes:
                    raise IOError(f"size mismatch for {remote_path}: {part.stat().st_size} != {expected_bytes}")
                digest = sha256(part)
                if digest != expected_sha256:
                    raise IOError(f"SHA256 mismatch for {remote_path}: {digest}")
                os.replace(part, destination)
                return
            except urllib.error.HTTPError as error:
                if error.code == 416 and have == expected_bytes and sha256(part) == expected_sha256:
                    os.replace(part, destination)
                    return
                last_error = error
            except (OSError, urllib.error.URLError) as error:
                last_error = error
            if attempt < 5:
                time.sleep(min(2**attempt, 15))
                self.login()
        raise RuntimeError(f"download failed after 5 attempts for {remote_path}: {last_error}")


def load_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    files = manifest.get("files")
    if not isinstance(files, list) or len(files) != EXPECTED_TRAIN_SOURCE_IMAGES + EXPECTED_VAL_SOURCE_IMAGES:
        raise ValueError("source manifest must freeze exactly 60 panorama files")
    for row in files:
        if row.get("split") not in {"train", "val"}:
            raise ValueError(f"invalid manifest split: {row}")
        if not isinstance(row.get("bytes"), int) or row["bytes"] <= 0:
            raise ValueError(f"invalid manifest byte count: {row}")
        digest = row.get("sha256")
        if not isinstance(digest, str) or len(digest) != 64:
            raise ValueError(f"manifest SHA256 is not frozen: {row.get('name')}")
    return manifest


def verify_remote_listing(client: SynologyPublicShare, manifest: dict) -> None:
    listing = client.list_folder(REMOTE_ROOT + "/images")
    remote = {
        row["name"]: int((row.get("additional") or {}).get("size", 0))
        for row in listing if not row.get("isdir")
    }
    if len(remote) != EXPECTED_SOURCE_IMAGES:
        raise ValueError(f"remote base/images count changed: {len(remote)}")
    for row in manifest["files"]:
        if remote.get(row["name"]) != row["bytes"]:
            raise ValueError(f"remote source size changed for {row['name']}")


def extract_face(source: Path, destination: Path, yaw: float, pitch: float) -> None:
    filter_value = (
        "v360=input=equirect:output=flat:"
        f"yaw={yaw}:pitch={pitch}:h_fov={FACE_FOV_DEGREES}:v_fov={FACE_FOV_DEGREES}:"
        f"w={FACE_SIZE}:h={FACE_SIZE}:interp=lanczos"
    )
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", str(source), "-vf", filter_value, "-frames:v", "1", "-q:v", "2", str(destination),
        ],
        check=True,
    )
    if jpeg_dimensions(destination) != (FACE_SIZE, FACE_SIZE):
        raise ValueError(f"unexpected virtual view dimensions: {destination}")


def build_transforms(
    pose_rows: dict[str, list[dict]],
    source_root: Path,
    output: Path,
    reuse_view_root: Path | None = None,
) -> dict:
    images = output / "images"
    images.mkdir(parents=True)
    frames: list[dict] = []
    split_paths: dict[str, list[str]] = {"train": [], "val": []}
    for split in ("train", "val"):
        for pose in pose_rows[split]:
            source = source_root / pose["rgb_file"]
            if jpeg_dimensions(source) != EXPECTED_PANO_SIZE:
                raise ValueError(f"unexpected panorama dimensions: {source}")
            for face_name, yaw, pitch in FACE_SPECS:
                relative = f"images/{split}_{Path(pose['rgb_file']).stem}__{face_name}.jpg"
                destination = output / relative
                reusable = reuse_view_root / Path(relative).name if reuse_view_root else None
                if reusable and reusable.is_file() and jpeg_dimensions(reusable) == (FACE_SIZE, FACE_SIZE):
                    try:
                        os.link(reusable, destination)
                    except OSError:
                        shutil.copy2(reusable, destination)
                else:
                    extract_face(source, destination, yaw, pitch)
                transform = virtual_face_c2w_opengl(pose["transform_matrix"], yaw, pitch)
                frames.append({
                    "file_path": relative,
                    "transform_matrix": transform,
                    "source_transform_matrix_opencv": pose["transform_matrix"],
                    "source_panorama": pose["rgb_file"],
                    "virtual_view": face_name,
                    "virtual_yaw_degrees": yaw,
                    "virtual_pitch_degrees": pitch,
                    "source_split": pose["source_split"],
                })
                split_paths[split].append(relative)
    focal = FACE_SIZE / (2.0 * math.tan(math.radians(FACE_FOV_DEGREES) / 2.0))
    transforms = {
        "camera_model": "OPENCV",
        "fl_x": focal,
        "fl_y": focal,
        "cx": FACE_SIZE / 2.0,
        "cy": FACE_SIZE / 2.0,
        "w": FACE_SIZE,
        "h": FACE_SIZE,
        "k1": 0.0,
        "k2": 0.0,
        "p1": 0.0,
        "p2": 0.0,
        "train_filenames": split_paths["train"],
        "val_filenames": split_paths["val"],
        "test_filenames": split_paths["val"],
        "frames": frames,
    }
    (output / "transforms.json").write_text(json.dumps(transforms, indent=2) + "\n", encoding="utf-8")
    return transforms


def validate_prepared(output: Path, transforms: dict) -> dict:
    frames = transforms["frames"]
    train = transforms["train_filenames"]
    val = transforms["val_filenames"]
    translations: dict[str, set[tuple[float, float, float]]] = {}
    determinants: list[float] = []
    for frame in frames:
        path = output / frame["file_path"]
        if not path.is_file() or jpeg_dimensions(path) != (FACE_SIZE, FACE_SIZE):
            raise ValueError(f"prepared virtual view missing or invalid: {path}")
        matrix = frame["transform_matrix"]
        rotation = [[float(matrix[row][column]) for column in range(3)] for row in range(3)]
        determinants.append(determinant3(rotation))
        translations.setdefault(frame["source_panorama"], set()).add(tuple(float(matrix[row][3]) for row in range(3)))
    checks = {
        "sourcePanoramas": len(translations) == 60,
        "nineViewsPerPanorama": len(frames) == 540,
        "trainViews": len(train) == 450,
        "valViews": len(val) == 90,
        "disjointSplits": not (set(train) & set(val)),
        "sameCenterAcrossVirtualViews": all(len(values) == 1 for values in translations.values()),
        "properRotations": all(abs(value - 1.0) <= 2e-3 for value in determinants),
    }
    if not all(checks.values()):
        raise ValueError(f"prepared data gate failed: {checks}")
    return {
        "schemaVersion": "1.0",
        "status": "READY",
        "adapter": "equirectangular-to-overlapping-pinhole-v2-opencv-posefix",
        "sourcePoseConvention": "opencv-c2w-x-right-y-down-z-forward",
        "outputPoseConvention": "opengl-c2w-x-right-y-up-z-back",
        "sourcePanoramas": 60,
        "trainSourcePanoramas": 50,
        "valSourcePanoramas": 10,
        "virtualViews": 540,
        "trainViews": 450,
        "valViews": 90,
        "faceSize": FACE_SIZE,
        "faceFovDegrees": FACE_FOV_DEGREES,
        "viewsPerPanorama": len(FACE_SPECS),
        "dynamicNadirExcluded": True,
        "usesAuthorScenePly": False,
        "checks": checks,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument("--list-only", action="store_true")
    parser.add_argument("--offline-reuse", action="store_true")
    parser.add_argument("--reuse-download-root", type=Path)
    parser.add_argument("--reuse-view-root", type=Path)
    args = parser.parse_args()
    destination = args.destination.resolve()
    manifest = load_manifest(args.manifest.resolve())
    if args.offline_reuse and not args.reuse_download_root:
        raise ValueError("--offline-reuse requires --reuse-download-root")
    download = (args.reuse_download_root or (destination / "download")).resolve()
    pose_path = download / "pose_c2w.json"
    pano_root = download / "panos"
    prepared = destination / "prepared" / "base-erp9-posefix"

    client = None
    if not args.offline_reuse:
        client = SynologyPublicShare()
        client.login()
        verify_remote_listing(client, manifest)
    if args.list_only:
        print(json.dumps({"status": "REMOTE_LIST_PASS", "selectedFiles": len(manifest["files"])}, indent=2))
        return 0

    pose_spec = manifest["pose"]
    if client:
        client.download(REMOTE_ROOT + "/pose_c2w.json", pose_path, pose_spec["bytes"], pose_spec["sha256"])
    if not pose_path.is_file() or pose_path.stat().st_size != pose_spec["bytes"] or sha256(pose_path) != pose_spec["sha256"]:
        raise ValueError(f"missing or invalid frozen pose file: {pose_path}")
    pose_data = json.loads(pose_path.read_text(encoding="utf-8"))
    selected = validate_pose_data(pose_data)
    expected_selection = {split: [row["rgb_file"] for row in selected[split]] for split in ("train", "val")}
    manifest_selection = {
        split: [row["name"] for row in manifest["files"] if row["split"] == split]
        for split in ("train", "val")
    }
    if manifest_selection != expected_selection:
        raise ValueError("manifest selection does not match deterministic pose selection")
    for index, row in enumerate(manifest["files"], start=1):
        print(f"[{index:02d}/60] {row['name']} ({row['bytes']} bytes)", flush=True)
        local_pano = pano_root / row["name"]
        if client:
            client.download(row["remotePath"], local_pano, row["bytes"], row["sha256"])
        if not local_pano.is_file() or local_pano.stat().st_size != row["bytes"] or sha256(local_pano) != row["sha256"]:
            raise ValueError(f"missing or invalid frozen panorama: {local_pano}")
    lock = {
        "schemaVersion": "1.0",
        "status": "DOWNLOADED_VERIFIED",
        "source": manifest["source"],
        "pose": pose_spec,
        "selectedFiles": len(manifest["files"]),
        "selectedBytes": sum(row["bytes"] for row in manifest["files"]),
        "files": manifest["files"],
    }
    destination.mkdir(parents=True, exist_ok=True)
    lock_path = destination / ("source-cache-verification.lock.json" if args.reuse_download_root else "download-manifest.lock.json")
    lock_path.write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
    if args.download_only:
        print(json.dumps({"status": "DOWNLOADED_VERIFIED", "selectedFiles": 60}, indent=2))
        return 0

    ready = prepared / ".prepared.json"
    if ready.is_file():
        prior = json.loads(ready.read_text(encoding="utf-8"))
        if prior.get("status") == "READY" and prior.get("adapter") == "equirectangular-to-overlapping-pinhole-v2-opencv-posefix":
            print(json.dumps(prior, indent=2))
            return 0
        raise ValueError(f"refusing unrecognized existing prepared output: {prepared}")
    if prepared.exists():
        raise FileExistsError(f"refusing to overwrite incomplete prepared output: {prepared}")
    prepared.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".base-erp9-posefix-", dir=prepared.parent))
    try:
        reuse_view_root = args.reuse_view_root.resolve() if args.reuse_view_root else None
        transforms = build_transforms(selected, pano_root, staging, reuse_view_root)
        report = validate_prepared(staging, transforms)
        (staging / ".prepared.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        os.replace(staging, prepared)
        print(json.dumps(report, indent=2))
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
