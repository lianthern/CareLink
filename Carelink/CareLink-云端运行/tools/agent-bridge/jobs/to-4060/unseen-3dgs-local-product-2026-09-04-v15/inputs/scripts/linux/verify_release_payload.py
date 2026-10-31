#!/usr/bin/env python3
"""Verify every byte in a flat v15 Release payload against MANIFEST.json."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from pathlib import Path, PurePosixPath
from typing import Any

JOB_ID = "unseen-3dgs-local-product-2026-09-04-v15"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_PAYLOAD_FILES = 4096
MAX_PAYLOAD_FILE_BYTES = 32 * 1024 * 1024
MAX_PAYLOAD_TOTAL_BYTES = 128 * 1024 * 1024
WINDOWS_FORBIDDEN = set('<>:"|?*')
WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def safe_relative(value: Any) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 240
        or "\\" in value
        or any(ord(character) < 32 for character in value)
        or WINDOWS_FORBIDDEN.intersection(value)
    ):
        raise ValueError(f"unsafe payload path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError(f"unsafe payload path: {value!r}")
    for part in path.parts:
        if part.endswith((" ", ".")) or part.split(".", 1)[0].upper() in WINDOWS_RESERVED:
            raise ValueError(f"Windows-unsafe payload path: {value!r}")
    if path.as_posix() != value:
        raise ValueError(f"payload path is not canonical: {value!r}")
    return value


def load_object(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is missing or invalid: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must contain one JSON object")
    return value


def assert_regular_file(path: Path, root: Path, label: str) -> None:
    try:
        info = path.lstat()
    except OSError as exc:
        raise ValueError(f"{label} is missing: {path.relative_to(root)}") from exc
    if not stat.S_ISREG(info.st_mode) or path.is_symlink():
        raise ValueError(f"{label} is not a regular non-symlink file: {path.relative_to(root)}")
    try:
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{label} escapes the payload root: {path}") from exc


def verify(
    root: Path,
    expected_manifest_sha256: str,
    *,
    allow_bridge_receipt: bool = False,
    expected_release_tag: str | None = None,
) -> dict[str, Any]:
    if not SHA256.fullmatch(expected_manifest_sha256):
        raise ValueError("an external lowercase MANIFEST.json SHA256 is required")
    supplied_root = root.expanduser()
    if supplied_root.is_symlink():
        raise ValueError("payload root must be a real directory")
    root = supplied_root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("payload root must be a real directory")
    manifest_path = root / "MANIFEST.json"
    assert_regular_file(manifest_path, root, "manifest")
    actual_manifest_sha256 = sha256(manifest_path)
    if actual_manifest_sha256 != expected_manifest_sha256:
        raise ValueError("MANIFEST.json SHA256 does not match external release evidence")
    manifest = load_object(manifest_path, "MANIFEST.json")
    if (
        manifest.get("schemaVersion") != "1.0"
        or manifest.get("jobId") != JOB_ID
        or not isinstance(manifest.get("releaseTag"), str)
        or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", manifest["releaseTag"])
        or (expected_release_tag is not None and manifest["releaseTag"] != expected_release_tag)
        or manifest.get("scope") != "release-payload"
        or manifest.get("selfExcluded") is not True
        or manifest.get("taskExcluded") is not True
        or not isinstance(manifest.get("files"), list)
    ):
        raise ValueError("MANIFEST.json identity/scope contract failed")

    if len(manifest["files"]) < 1 or len(manifest["files"]) > MAX_PAYLOAD_FILES:
        raise ValueError("MANIFEST.json payload file count exceeds the fixed budget")
    expected = {"MANIFEST.json"}
    expected_casefold = {"manifest.json"}
    total_bytes = 0
    records: list[dict[str, Any]] = []
    for raw in manifest["files"]:
        if not isinstance(raw, dict) or set(raw) != {"path", "bytes", "sha256"}:
            raise ValueError("each manifest record must contain exactly path/bytes/sha256")
        relative = safe_relative(raw["path"])
        if relative == "MANIFEST.json" or relative in expected or relative.casefold() in expected_casefold:
            raise ValueError(f"manifest contains itself or a duplicate path: {relative}")
        size = raw["bytes"]
        digest = raw["sha256"]
        if isinstance(size, bool) or not isinstance(size, int) or size < 1 or size > MAX_PAYLOAD_FILE_BYTES:
            raise ValueError(f"invalid byte count for {relative}")
        total_bytes += size
        if total_bytes > MAX_PAYLOAD_TOTAL_BYTES:
            raise ValueError("manifest payload exceeds the fixed total-byte budget")
        if not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise ValueError(f"invalid SHA256 for {relative}")
        path = root.joinpath(*PurePosixPath(relative).parts)
        assert_regular_file(path, root, "payload entry")
        if path.stat().st_size != size or sha256(path) != digest:
            raise ValueError(f"payload byte/SHA mismatch: {relative}")
        expected.add(relative)
        expected_casefold.add(relative.casefold())
        records.append({"path": relative, "bytes": size, "sha256": digest})

    if allow_bridge_receipt:
        expected.add(".bridge-receipt.json")
    actual: set[str] = set()
    for directory, names, filenames in os.walk(root, followlinks=False):
        directory_path = Path(directory)
        for name in names:
            candidate = directory_path / name
            if candidate.is_symlink():
                raise ValueError(f"payload contains a symlink directory: {candidate.relative_to(root)}")
        for name in filenames:
            candidate = directory_path / name
            assert_regular_file(candidate, root, "payload tree entry")
            actual.add(candidate.relative_to(root).as_posix())
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        raise ValueError(f"payload tree mismatch; missing={missing}; extra={extra}")
    return {
        "jobId": JOB_ID,
        "manifestSha256": actual_manifest_sha256,
        "fileCount": len(records),
        "state": "PAYLOAD_MANIFEST_VERIFIED",
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload-root", type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--manifest-sha256")
    source.add_argument("--bridge-receipt", type=Path)
    parser.add_argument("--allow-bridge-receipt", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    expected = args.manifest_sha256
    if args.bridge_receipt is not None:
        receipt = load_object(args.bridge_receipt, "Bridge receipt")
        expected_receipt_fields = {
            "schemaVersion", "jobId", "releaseTag", "assetName", "assetSha256",
            "assetBytes", "controlCommit", "verifiedAt", "verifiedBy",
            "payloadManifestSha256", "payloadFileCount",
        }
        if (
            set(receipt) != expected_receipt_fields
            or receipt.get("schemaVersion") != "1.0"
            or receipt.get("jobId") != JOB_ID
            or type(receipt.get("payloadFileCount")) is not int
            or receipt.get("payloadFileCount") < 1
            or not isinstance(receipt.get("releaseTag"), str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", receipt["releaseTag"]) is None
            or not isinstance(receipt.get("assetName"), str)
            or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}", receipt["assetName"]) is None
            or not SHA256.fullmatch(str(receipt.get("assetSha256") or ""))
            or type(receipt.get("assetBytes")) is not int
            or receipt.get("assetBytes") < 1
            or re.fullmatch(r"[a-f0-9]{40}", str(receipt.get("controlCommit") or "")) is None
            or receipt.get("verifiedBy") != "Receive-BridgeJob.ps1"
            or not SHA256.fullmatch(str(receipt.get("payloadManifestSha256") or ""))
        ):
            raise ValueError("Bridge receipt does not bind the exact v15 release payload")
        expected = receipt.get("payloadManifestSha256")
        args.allow_bridge_receipt = True
    expected_release_tag = str(receipt.get("releaseTag")) if args.bridge_receipt is not None else None
    evidence = verify(
        args.payload_root,
        str(expected or ""),
        allow_bridge_receipt=args.allow_bridge_receipt,
        expected_release_tag=expected_release_tag,
    )
    if args.bridge_receipt is not None and evidence["fileCount"] != receipt["payloadFileCount"]:
        raise ValueError("Bridge receipt payload file count disagrees with MANIFEST.json")
    print(json.dumps(evidence, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ValueError as exc:
        print(f"PAYLOAD_MANIFEST_FAILED: {exc}", file=os.sys.stderr)
        raise SystemExit(1)
