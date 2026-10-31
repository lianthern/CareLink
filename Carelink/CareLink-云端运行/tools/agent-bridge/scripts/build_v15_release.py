#!/usr/bin/env python3
"""Build the deterministic flat v15 private-Release asset and bind TASK/MANIFEST."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Sequence

SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

import verify_bridge as bridge_contract  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
JOB_ID = "unseen-3dgs-local-product-2026-09-04-v15"
JOB_ROOT = ROOT / "jobs/to-4060" / JOB_ID
TOP_LEVEL_PAYLOAD = (
    "ACCEPTANCE.md",
    "PRODUCTION-CONTRACT.md",
    "README.md",
    "REPORT-TEMPLATE.md",
    "START-HERE.md",
    "STATUS.json",
)
SHA256 = re.compile(r"^[a-f0-9]{64}$")
ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def bytes_sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_bytes(value: dict) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def atomic_bytes(path: Path, value: bytes) -> None:
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@dataclass(frozen=True)
class FrozenFile:
    relative: str
    data: bytes

    def record(self) -> dict:
        return {
            "path": self.relative,
            "bytes": len(self.data),
            "sha256": bytes_sha256(self.data),
        }


@dataclass(frozen=True)
class ReleaseCandidate:
    relative: str
    path: Path
    size: int
    mtime_ns: int
    device: int
    inode: int


def require_contained(path: Path, root: Path, label: str) -> None:
    try:
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as exc:
        raise ValueError(f"{label} escapes the v15 job root: {path}") from exc


def inspect_regular_file(path: Path, job_root: Path) -> ReleaseCandidate:
    """Validate and stat one payload member without reading its bytes."""
    relative_text = path.relative_to(job_root).as_posix()
    relative = bridge_contract.safe_relative_path(relative_text, job_root)
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"release input must be a regular non-symlink file: {relative_text}")
    require_contained(path, job_root, "release input")
    classification = bridge_contract.classify_release_path(relative)
    if classification == bridge_contract.RELEASE_PATH_CACHE:
        raise ValueError(f"internal error: cache path was sent to the payload freezer: {relative_text}")
    if classification == bridge_contract.RELEASE_PATH_FORBIDDEN:
        raise ValueError(f"forbidden generated/media/secret release path: {relative_text}")
    if metadata.st_size < 1:
        raise ValueError(f"empty release file: {relative_text}")
    if metadata.st_size > bridge_contract.MAX_RELEASE_FILE_BYTES:
        raise ValueError(
            f"Release payload single-file budget exceeded "
            f"({bridge_contract.MAX_RELEASE_FILE_BYTES} bytes): {relative_text}"
        )
    return ReleaseCandidate(
        relative=relative_text,
        path=path,
        size=metadata.st_size,
        mtime_ns=metadata.st_mtime_ns,
        device=metadata.st_dev,
        inode=metadata.st_ino,
    )


def _candidate_signature(candidate: ReleaseCandidate) -> tuple[int, int, int, int]:
    return candidate.size, candidate.mtime_ns, candidate.device, candidate.inode


def _path_signature(path: Path) -> tuple[int, int, int, int]:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"release input stopped being a regular non-symlink file: {path}")
    return metadata.st_size, metadata.st_mtime_ns, metadata.st_dev, metadata.st_ino


def read_bounded_file(path: Path, maximum: int, label: str) -> bytes:
    with path.open("rb") as handle:
        data = handle.read(maximum + 1)
    if len(data) > maximum:
        raise ValueError(f"{label} exceeds the bounded file size")
    return data


def freeze_candidate(candidate: ReleaseCandidate, job_root: Path) -> FrozenFile:
    """Read a preflighted bounded file and reject any concurrent replacement."""
    require_contained(candidate.path, job_root, "release input")
    if _path_signature(candidate.path) != _candidate_signature(candidate):
        raise ValueError(f"release input changed after stat preflight: {candidate.relative}")
    with candidate.path.open("rb") as handle:
        opened = os.fstat(handle.fileno())
        opened_signature = opened.st_size, opened.st_mtime_ns, opened.st_dev, opened.st_ino
        if opened_signature != _candidate_signature(candidate):
            raise ValueError(f"release input changed while being opened: {candidate.relative}")
        data = handle.read(candidate.size + 1)
        closed_signature = os.fstat(handle.fileno())
    if (closed_signature.st_size, closed_signature.st_mtime_ns, closed_signature.st_dev, closed_signature.st_ino) != (
        _candidate_signature(candidate)
    ):
        raise ValueError(f"release input changed while being read: {candidate.relative}")
    if _path_signature(candidate.path) != _candidate_signature(candidate) or len(data) != candidate.size:
        raise ValueError(f"release input changed while being read: {candidate.relative}")
    bridge_contract.check_release_content(data, candidate.path)
    return FrozenFile(candidate.relative, data)


def collect_input_tree(job_root: Path) -> list[ReleaseCandidate]:
    input_root = job_root / "inputs"
    if input_root.is_symlink() or not input_root.is_dir():
        raise ValueError("v15 inputs must be a real, non-symlink directory")
    require_contained(input_root, job_root, "inputs root")

    candidates: list[ReleaseCandidate] = []
    for path in input_root.rglob("*"):
        relative_text = path.relative_to(job_root).as_posix()
        relative = bridge_contract.safe_relative_path(relative_text, job_root)
        metadata = path.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(f"release input may not be a symlink: {relative_text}")
        classification = bridge_contract.classify_release_path(relative)
        if classification == bridge_contract.RELEASE_PATH_CACHE:
            continue
        if classification == bridge_contract.RELEASE_PATH_FORBIDDEN:
            raise ValueError(f"forbidden generated/media/secret release path: {relative_text}")
        if stat.S_ISDIR(metadata.st_mode):
            require_contained(path, job_root, "release input directory")
            continue
        if not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"release input must be a regular file or directory: {relative_text}")
        candidates.append(inspect_regular_file(path, job_root))
        if len(candidates) + len(TOP_LEVEL_PAYLOAD) > bridge_contract.MAX_RELEASE_PAYLOAD_FILES:
            raise ValueError(
                f"Release payload file-count budget exceeded "
                f"({bridge_contract.MAX_RELEASE_PAYLOAD_FILES})"
            )
    return candidates


def validate_unique_paths(snapshots: Sequence[FrozenFile | ReleaseCandidate], owner: Path) -> None:
    exact: set[str] = set()
    folded: set[str] = set()
    for snapshot in snapshots:
        relative = bridge_contract.safe_relative_path(snapshot.relative, owner)
        if snapshot.relative in exact:
            raise ValueError(f"duplicate Release path: {snapshot.relative}")
        casefolded = snapshot.relative.casefold()
        if casefolded in folded:
            raise ValueError(f"Windows case-colliding Release path: {snapshot.relative}")
        exact.add(snapshot.relative)
        folded.add(casefolded)
        if bridge_contract.classify_release_path(relative) != bridge_contract.RELEASE_PATH_PAYLOAD:
            raise ValueError(f"non-payload path reached Release snapshot: {snapshot.relative}")


def validate_payload_budget(candidates: Sequence[ReleaseCandidate]) -> None:
    if len(candidates) > bridge_contract.MAX_RELEASE_PAYLOAD_FILES:
        raise ValueError(
            f"Release payload file-count budget exceeded "
            f"({bridge_contract.MAX_RELEASE_PAYLOAD_FILES})"
        )
    for candidate in candidates:
        if candidate.size < 1 or candidate.size > bridge_contract.MAX_RELEASE_FILE_BYTES:
            raise ValueError(
                f"Release payload single-file budget exceeded "
                f"({bridge_contract.MAX_RELEASE_FILE_BYTES} bytes): {candidate.relative}"
            )
    total = sum(candidate.size for candidate in candidates)
    if total > bridge_contract.MAX_RELEASE_PAYLOAD_BYTES:
        raise ValueError(
            f"Release payload total-byte budget exceeded "
            f"({bridge_contract.MAX_RELEASE_PAYLOAD_BYTES} bytes)"
        )


def freeze_payload(job_root: Path) -> tuple[list[FrozenFile], list[FrozenFile]]:
    if job_root.is_symlink() or not job_root.is_dir():
        raise ValueError(f"v15 job root must be a real directory: {job_root}")
    expected_top = {"TASK.json", "MANIFEST.json", *TOP_LEVEL_PAYLOAD, "inputs"}
    actual_top = {path.name for path in job_root.iterdir()}
    if actual_top != expected_top:
        raise ValueError(
            f"unexpected job-root entries; missing={sorted(expected_top - actual_top)} "
            f"extra={sorted(actual_top - expected_top)}"
        )

    for control_name in ("TASK.json", "MANIFEST.json"):
        control_path = job_root / control_name
        metadata = control_path.lstat()
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise ValueError(f"{control_name} must be a regular non-symlink file")
        require_contained(control_path, job_root, control_name)
        if metadata.st_size > bridge_contract.MAX_RELEASE_FILE_BYTES:
            raise ValueError(f"{control_name} exceeds the bounded control-file size")

    top_level_candidates = [inspect_regular_file(job_root / name, job_root) for name in TOP_LEVEL_PAYLOAD]
    input_candidates = collect_input_tree(job_root)
    payload_candidates = sorted([*top_level_candidates, *input_candidates], key=lambda item: item.relative)
    validate_unique_paths(payload_candidates, job_root)
    validate_payload_budget(payload_candidates)

    # The complete tree passes stat budgets before the first payload read.
    payload_files = [freeze_candidate(candidate, job_root) for candidate in payload_candidates]
    input_paths = {candidate.relative for candidate in input_candidates}
    input_files = [snapshot for snapshot in payload_files if snapshot.relative in input_paths]
    return input_files, payload_files


def deterministic_zip(destination: Path, snapshots: Sequence[FrozenFile]) -> None:
    validate_unique_paths(snapshots, destination)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as archive:
        for snapshot in snapshots:
            info = zipfile.ZipInfo(snapshot.relative, date_time=ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_STORED
            info.create_system = 3
            executable = PurePosixPath(snapshot.relative).suffix in {".sh", ".py"}
            info.external_attr = ((0o755 if executable else 0o644) | stat.S_IFREG) << 16
            archive.writestr(info, snapshot.data, compress_type=zipfile.ZIP_STORED)


def verify_built_zip(path: Path, snapshots: Sequence[FrozenFile]) -> None:
    expected_order = [snapshot.relative for snapshot in snapshots]
    expected = {snapshot.relative: snapshot for snapshot in snapshots}
    if len(expected) != len(snapshots):
        raise ValueError("duplicate path reached ZIP verification")
    folded = {name.casefold() for name in expected}
    if len(folded) != len(expected):
        raise ValueError("Windows case-colliding path reached ZIP verification")

    with zipfile.ZipFile(path, "r") as archive:
        infos = archive.infolist()
        if len(infos) > bridge_contract.MAX_RELEASE_PAYLOAD_FILES + 1:
            raise ValueError("flat ZIP member-count budget exceeded")
        names = [item.filename for item in infos]
        if names != expected_order:
            raise ValueError("flat ZIP member order/set does not exactly match the frozen payload")
        if "TASK.json" in names:
            raise ValueError("TASK.json must never be embedded in the Release asset")
        for info in infos:
            bridge_contract.safe_relative_path(info.filename, path)
            mode = (info.external_attr >> 16) & 0xFFFF
            if info.is_dir() or not stat.S_ISREG(mode) or stat.S_ISLNK(mode):
                raise ValueError(f"flat ZIP contains a non-regular member: {info.filename}")
            if info.compress_type != zipfile.ZIP_STORED or info.date_time != ZIP_TIMESTAMP:
                raise ValueError(f"flat ZIP metadata is not deterministic: {info.filename}")
            snapshot = expected[info.filename]
            if info.file_size != len(snapshot.data) or info.file_size > bridge_contract.MAX_RELEASE_FILE_BYTES:
                raise ValueError(f"flat ZIP member bytes/SHA256 mismatch (declared size): {info.filename}")
            data = archive.read(info)
            if len(data) != len(snapshot.data) or bytes_sha256(data) != bytes_sha256(snapshot.data):
                raise ValueError(f"flat ZIP member bytes/SHA256 mismatch: {info.filename}")
        corrupt = archive.testzip()
        if corrupt is not None:
            raise ValueError(f"flat ZIP CRC verification failed: {corrupt}")


def validate_output_directory(value: Path) -> Path:
    destination = value.expanduser().resolve(strict=False)
    checkout = ROOT.resolve(strict=True)
    if destination == checkout or checkout in destination.parents:
        raise ValueError("release ZIP output must be outside the Git checkout")
    if destination.exists() and not destination.is_dir():
        raise ValueError(f"release output exists but is not a directory: {destination}")
    return destination


def assert_source_unchanged(
    original_task: bytes,
    original_manifest: bytes,
    frozen_inputs: Sequence[FrozenFile],
    frozen_payload: Sequence[FrozenFile],
) -> None:
    current_inputs, current_payload = freeze_payload(JOB_ROOT)
    if list(current_inputs) != list(frozen_inputs) or list(current_payload) != list(frozen_payload):
        raise ValueError("v15 payload changed while the Release was being built; retry from a stable worktree")
    if read_bounded_file(JOB_ROOT / "TASK.json", bridge_contract.MAX_RELEASE_FILE_BYTES, "TASK.json") != original_task:
        raise ValueError("TASK.json changed while the Release was being built; retry from a stable worktree")
    if read_bounded_file(
        JOB_ROOT / "MANIFEST.json", bridge_contract.MAX_RELEASE_FILE_BYTES, "MANIFEST.json"
    ) != original_manifest:
        raise ValueError("MANIFEST.json changed while the Release was being built; retry from a stable worktree")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", required=True, choices=("r3",))
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--published-at", help="Explicit ISO-8601 UTC timestamp; default is current UTC")
    parser.add_argument("--write-contract", action="store_true", help="Required confirmation to rewrite TASK/MANIFEST")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.write_contract:
        raise SystemExit("--write-contract is required; nothing was changed")

    try:
        output_dir = validate_output_directory(args.output_dir)
        input_files, payload_files = freeze_payload(JOB_ROOT)
    except (AssertionError, ValueError) as exc:
        raise SystemExit(str(exc)) from exc

    manifest = {
        "schemaVersion": "1.0",
        "jobId": JOB_ID,
        "releaseTag": f"{JOB_ID}-{args.release}",
        "scope": "release-payload",
        "selfExcluded": True,
        "taskExcluded": True,
        "files": [snapshot.record() for snapshot in payload_files],
    }
    manifest_data = json_bytes(manifest)
    manifest_snapshot = FrozenFile("MANIFEST.json", manifest_data)
    manifest_sha = bytes_sha256(manifest_data)

    task_path = JOB_ROOT / "TASK.json"
    manifest_path = JOB_ROOT / "MANIFEST.json"
    original_task = read_bounded_file(task_path, bridge_contract.MAX_RELEASE_FILE_BYTES, "TASK.json")
    original_manifest = read_bounded_file(manifest_path, bridge_contract.MAX_RELEASE_FILE_BYTES, "MANIFEST.json")
    try:
        task = json.loads(original_task.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SystemExit(f"TASK.json is invalid: {exc}") from exc
    if not isinstance(task, dict):
        raise SystemExit("TASK.json must contain an object")
    if task.get("jobId") != JOB_ID or task.get("state") != "PUBLISHED":
        raise SystemExit("TASK identity/state failed")
    artifact = task.get("artifact")
    if not isinstance(artifact, dict):
        raise SystemExit("TASK artifact must be an object")
    if "commit" in artifact:
        raise SystemExit("artifact.commit is forbidden: the Release tag target is bound externally by the receiver")

    published_at = args.published_at or (
        datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", published_at) is None:
        raise SystemExit("--published-at must be a second-precision UTC timestamp ending in Z")
    task["publishedAt"] = published_at
    task["inputs"] = [snapshot.record() for snapshot in input_files]
    artifact.update(
        {
            "delivery": "github-private-release",
            "releaseTag": manifest["releaseTag"],
            "assetName": "PENDING_BUILD.zip",
            "sha256": "0" * 64,
            "bytes": 1,
            "format": "zip",
            "payloadManifestPath": "MANIFEST.json",
            "payloadManifestSha256": manifest_sha,
            "payloadFileCount": len(manifest["files"]),
        }
    )

    output_dir.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f"{JOB_ID}-{args.release}-", suffix=".zip", dir=output_dir)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        zip_snapshots = [manifest_snapshot, *payload_files]
        deterministic_zip(temporary, zip_snapshots)
        verify_built_zip(temporary, zip_snapshots)
        asset_sha = file_sha256(temporary)
        asset_bytes = temporary.stat().st_size
        if not SHA256.fullmatch(asset_sha) or asset_bytes < 1:
            raise ValueError("built asset hash/size failed")

        assert_source_unchanged(original_task, original_manifest, input_files, payload_files)
        asset_name = f"15-UNSEEN-LOCAL-PRODUCT-v15-{args.release}-sha256-{asset_sha}.zip"
        destination = output_dir / asset_name
        if destination.exists():
            if destination.is_symlink() or not destination.is_file():
                raise ValueError(f"refusing a non-regular existing release asset: {destination}")
            if destination.stat().st_size != asset_bytes or file_sha256(destination) != asset_sha:
                raise ValueError(f"refusing to overwrite a different release asset: {destination}")
            verify_built_zip(destination, zip_snapshots)
            temporary.unlink()
        else:
            os.replace(temporary, destination)

        artifact.update(assetName=asset_name, sha256=asset_sha, bytes=asset_bytes)
        task_data = json_bytes(task)
        try:
            atomic_bytes(manifest_path, manifest_data)
            atomic_bytes(task_path, task_data)
            bridge_contract.check_task(task_path)
        except BaseException:
            atomic_bytes(manifest_path, original_manifest)
            atomic_bytes(task_path, original_task)
            raise

        print(
            json.dumps(
                {
                    "releaseTag": artifact["releaseTag"],
                    "assetPath": str(destination),
                    "assetName": asset_name,
                    "assetBytes": asset_bytes,
                    "assetSha256": asset_sha,
                    "payloadManifestSha256": manifest_sha,
                    "payloadFileCount": len(manifest["files"]),
                    "flatRoot": True,
                    "taskEmbedded": False,
                    "compression": "stored",
                },
                indent=2,
            )
        )
        return 0
    except (AssertionError, OSError, ValueError, zipfile.BadZipFile) as exc:
        raise SystemExit(str(exc)) from exc
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
