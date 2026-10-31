#!/usr/bin/env python3
"""Dependency-free structural and data-boundary checks for Max Agent Bridge."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
SHA256 = re.compile(r"^[a-f0-9]{64}$")
JOB_ID = re.compile(r"^[a-z0-9][a-z0-9-]{5,127}$")
RECEIPT_STATES = {"RECEIVED_VERIFIED", "RUNNING", "UPLOADING", "COMPLETED", "BLOCKED", "FAILED"}
FORBIDDEN_SUFFIXES = {".mov", ".mkv", ".avi", ".webm", ".sog", ".ply", ".ckpt", ".pt", ".pth", ".pem", ".key"}
SAFE_WALKTHROUGH = re.compile(r"^results/from-4060/[a-z0-9][a-z0-9-]{5,127}/viewer-walkthrough-[a-z0-9-]+\.mp4$")
MAX_WALKTHROUGH_BYTES = 15 * 1024 * 1024
SAFE_SPATIAL_CONTEXT = re.compile(r"^results/from-4060/[a-z0-9][a-z0-9-]{5,127}/fixed-photo-spatial-context\.mp4$")
MAX_SPATIAL_CONTEXT_BYTES = 5 * 1024 * 1024
MAX_RELEASE_FILE_BYTES = 32 * 1024 * 1024
MAX_RELEASE_PAYLOAD_BYTES = 128 * 1024 * 1024
MAX_RELEASE_PAYLOAD_FILES = 4096
RELEASE_SECRET_SCAN_OVERLAP = 1024
PAYLOAD_MANIFEST_FIELDS = {
    "payloadManifestPath",
    "payloadManifestSha256",
    "payloadFileCount",
}
PYTHON_CACHE_DIRECTORIES = {"__pycache__"}
PYTHON_CACHE_SUFFIXES = {".pyc", ".pyo"}
FORBIDDEN_RELEASE_DIRECTORIES = {
    ".aws",
    ".azure",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".ssh",
    ".venv",
    "venv",
    "node_modules",
    "work",
}
FORBIDDEN_RELEASE_FILENAMES = {
    ".ds_store",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "credentials.json",
    "id_ed25519",
    "id_rsa",
    "secret.json",
    "secrets.json",
}
FORBIDDEN_RELEASE_STEMS = {
    "api-key",
    "api_key",
    "credential",
    "credentials",
    "private-key",
    "private_key",
    "secret",
    "secrets",
    "token",
    "tokens",
}
FORBIDDEN_RELEASE_SUFFIXES = {
    ".aac",
    ".avi",
    ".bmp",
    ".ckpt",
    ".db",
    ".dng",
    ".fbx",
    ".flac",
    ".gif",
    ".glb",
    ".gltf",
    ".heic",
    ".heif",
    ".jpeg",
    ".jpg",
    ".key",
    ".m4v",
    ".mkv",
    ".mov",
    ".mp4",
    ".mp3",
    ".mts",
    ".p12",
    ".pem",
    ".pfx",
    ".ply",
    ".png",
    ".pt",
    ".pth",
    ".sog",
    ".sqlite",
    ".sqlite3",
    ".svg",
    ".tif",
    ".tiff",
    ".wav",
    ".webp",
    ".webm",
}
RELEASE_PATH_CACHE = "cache"
RELEASE_PATH_FORBIDDEN = "forbidden"
RELEASE_PATH_PAYLOAD = "payload"
WINDOWS_FORBIDDEN_FILENAME_CHARACTERS = set('<>:"|?*')
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{number}" for number in range(1, 10)),
    *(f"LPT{number}" for number in range(1, 10)),
}


def _secret_token_pattern(prefix: bytes, minimum: int, maximum: int = 255) -> re.Pattern[bytes]:
    return re.compile(
        rb"(?<![A-Za-z0-9])(" + re.escape(prefix) + rb"[A-Za-z0-9_./+=-]{"
        + str(minimum).encode("ascii") + rb"," + str(maximum).encode("ascii")
        + rb"})(?![A-Za-z0-9_./+=-])"
    )


# Construct provider prefixes from fragments so this verifier's own source does
# not contain a complete credential-looking literal that it would flag if reused
# inside a Release payload.
RELEASE_SECRET_TOKEN_PATTERNS = (
    ("GitHub classic PAT", _secret_token_pattern(b"gh" + b"p_", 36, 36)),
    ("GitHub fine-grained PAT", _secret_token_pattern(b"github_" + b"pat_", 60)),
    ("GitLab PAT", _secret_token_pattern(b"gl" + b"pat-", 20)),
    ("Hugging Face token", _secret_token_pattern(b"h" + b"f_", 30)),
    ("Google API key", _secret_token_pattern(b"AI" + b"za", 35, 35)),
    ("AWS access key", _secret_token_pattern(b"AK" + b"IA", 16, 16)),
    ("Slack token", _secret_token_pattern(b"xo" + b"xb-", 20)),
    ("Slack token", _secret_token_pattern(b"xo" + b"xa-", 20)),
    ("Slack token", _secret_token_pattern(b"xo" + b"xp-", 20)),
    ("Slack token", _secret_token_pattern(b"xo" + b"xr-", 20)),
    ("Slack token", _secret_token_pattern(b"xo" + b"xs-", 20)),
    ("OpenAI API key", _secret_token_pattern(b"s" + b"k-", 40)),
    ("OpenAI project key", _secret_token_pattern(b"sk-" + b"proj-", 40)),
    ("Anthropic API key", _secret_token_pattern(b"sk-" + b"ant-", 40)),
    ("Stripe live secret", _secret_token_pattern(b"sk_" + b"live_", 24)),
)
RELEASE_SECRET_ASSIGNMENT = re.compile(
    rb"(?i)(?<![A-Z0-9_])(?:[A-Z][A-Z0-9]*_){0,4}(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|"
    rb"SECRET[_-]?KEY|CLIENT[_-]?SECRET|PASSWORD|TOKEN)[ \t]*[:=][ \t]*[\"']?"
    rb"([A-Za-z0-9_./+=-]{24,256})(?![A-Za-z0-9_./+=-])"
)
RELEASE_BEARER_ASSIGNMENT = re.compile(
    rb"(?i)(?<![A-Z0-9_])AUTHORIZATION[ \t]*[:=][ \t]*BEARER[ \t]+"
    rb"([A-Za-z0-9_./+=~-]{24,512})(?![A-Za-z0-9_./+=~-])"
)
RELEASE_PRIVATE_KEY_HEADERS = tuple(
    b"-----BEGIN " + key_type + b"PRIVATE KEY-----"
    for key_type in (b"", b"RSA ", b"EC ", b"DSA ", b"OPENSSH ", b"ENCRYPTED ")
)


def load(path: Path) -> dict:
    with path.open("r", encoding="utf-8-sig") as handle:
        return json.load(handle)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def _has_secret_entropy(candidate: bytes) -> bool:
    """Suppress obvious placeholders while retaining high-confidence values."""
    folded = candidate.lower()
    placeholder_markers = (
        b"changeme",
        b"dummy",
        b"example",
        b"fake",
        b"placeholder",
        b"replace",
        b"your-key",
        b"your_key",
        b"your-token",
        b"your_token",
    )
    return (
        len(candidate) >= 24
        and len(set(folded)) >= 10
        and any(65 <= value <= 90 or 97 <= value <= 122 for value in candidate)
        and not any(marker in folded for marker in placeholder_markers)
        and max(folded.count(value) for value in set(folded)) * 3 < len(folded) * 2
    )


def release_secret_kind(data: bytes) -> str | None:
    """Return a high-confidence credential kind found in arbitrary file bytes."""
    for header in RELEASE_PRIVATE_KEY_HEADERS:
        if header in data:
            return "private-key block"
    for label, pattern in RELEASE_SECRET_TOKEN_PATTERNS:
        for match in pattern.finditer(data):
            if _has_secret_entropy(match.group(1)):
                return label
    for label, pattern in (
        ("credential assignment", RELEASE_SECRET_ASSIGNMENT),
        ("Authorization bearer value", RELEASE_BEARER_ASSIGNMENT),
    ):
        for match in pattern.finditer(data):
            if _has_secret_entropy(match.group(1)):
                return label
    return None


def check_release_content(data: bytes, owner: Path) -> None:
    secret_kind = release_secret_kind(data)
    require(secret_kind is None, f"probable {secret_kind} in Release payload: {owner}")


def release_sha256(path: Path) -> str:
    """Hash and secret-scan one bounded payload file without loading it whole."""
    digest = hashlib.sha256()
    tail = b""
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            window = tail + chunk
            check_release_content(window, path)
            tail = window[-RELEASE_SECRET_SCAN_OVERLAP:]
    return digest.hexdigest()


def safe_relative_path(value: object, owner: Path) -> PurePosixPath:
    """Return one canonical, cross-platform-safe path below a job root."""
    require(isinstance(value, str) and bool(value), f"invalid empty path in {owner}")
    assert isinstance(value, str)  # Narrow the type for static checkers.
    require(len(value) <= 240, f"manifest path is too long in {owner}")
    require("\\" not in value, f"backslash is forbidden in manifest path {value!r}: {owner}")
    require(
        not WINDOWS_FORBIDDEN_FILENAME_CHARACTERS.intersection(value),
        f"Windows-forbidden character in path {value!r}: {owner}",
    )
    require(not any(ord(character) < 32 for character in value), f"control character in path: {owner}")
    relative = PurePosixPath(value)
    require(not relative.is_absolute(), f"absolute path is forbidden: {value!r} in {owner}")
    require(relative.parts, f"empty path is forbidden: {owner}")
    require(all(part not in {"", ".", ".."} for part in relative.parts), f"unsafe path {value!r}: {owner}")
    require(
        all(not part.endswith((" ", ".")) for part in relative.parts),
        f"Windows-unsafe trailing dot/space in path {value!r}: {owner}",
    )
    require(
        all(part.split(".", 1)[0].upper() not in WINDOWS_RESERVED_NAMES for part in relative.parts),
        f"Windows-reserved name in path {value!r}: {owner}",
    )
    require(relative.as_posix() == value, f"path must be canonical POSIX form: {value!r} in {owner}")
    return relative


def classify_release_path(relative: PurePosixPath) -> str:
    """Classify one job-relative path under the frozen Release policy."""
    folded_parts = tuple(part.casefold() for part in relative.parts)
    folded_name = relative.name.casefold()
    if (
        any(part in PYTHON_CACHE_DIRECTORIES for part in folded_parts)
        or relative.suffix.lower() in PYTHON_CACHE_SUFFIXES
    ):
        return RELEASE_PATH_CACHE
    if any(part in FORBIDDEN_RELEASE_DIRECTORIES for part in folded_parts):
        return RELEASE_PATH_FORBIDDEN
    if folded_name in FORBIDDEN_RELEASE_FILENAMES:
        return RELEASE_PATH_FORBIDDEN
    if relative.stem.casefold() in FORBIDDEN_RELEASE_STEMS:
        return RELEASE_PATH_FORBIDDEN
    if folded_name.startswith(".env") and folded_name != ".env.example":
        return RELEASE_PATH_FORBIDDEN
    if relative.suffix.lower() in FORBIDDEN_RELEASE_SUFFIXES:
        return RELEASE_PATH_FORBIDDEN
    return RELEASE_PATH_PAYLOAD


def is_generated_cache(relative: PurePosixPath) -> bool:
    return classify_release_path(relative) == RELEASE_PATH_CACHE


def actual_files(
    job_root: Path,
    subtree: str | None = None,
) -> dict[str, Path]:
    require(job_root.is_dir() and not job_root.is_symlink(), f"job root must be a real directory: {job_root}")
    job_root_resolved = job_root.resolve(strict=True)
    scan_root = job_root / subtree if subtree else job_root
    if not scan_root.is_dir():
        return {}
    require(not scan_root.is_symlink(), f"published subtree must not be a symlink: {scan_root}")
    try:
        scan_root.resolve(strict=True).relative_to(job_root_resolved)
    except (OSError, ValueError) as exc:
        raise AssertionError(f"published subtree escapes its job root: {scan_root}") from exc
    output: dict[str, Path] = {}
    for candidate in scan_root.rglob("*"):
        relative = PurePosixPath(candidate.relative_to(job_root).as_posix())
        safe_relative_path(relative.as_posix(), job_root)
        require(not candidate.is_symlink(), f"published job tree contains a symlink: {candidate}")
        try:
            candidate.resolve(strict=True).relative_to(job_root_resolved)
        except (OSError, ValueError) as exc:
            raise AssertionError(f"published path escapes its job root: {candidate}") from exc
        classification = classify_release_path(relative)
        if classification == RELEASE_PATH_CACHE:
            continue
        require(
            classification != RELEASE_PATH_FORBIDDEN,
            f"forbidden generated/media/secret path in published job tree: {candidate}",
        )
        if candidate.is_file():
            output[relative.as_posix()] = candidate
        else:
            require(candidate.is_dir(), f"published job tree contains a non-regular path: {candidate}")
    return output


def check_actual_release_budget(files: dict[str, Path], owner: Path) -> None:
    require(
        len(files) <= MAX_RELEASE_PAYLOAD_FILES,
        f"Release payload file-count budget exceeded ({MAX_RELEASE_PAYLOAD_FILES}): {owner}",
    )
    total = 0
    for relative, target in files.items():
        size = target.stat().st_size
        require(size >= 1, f"empty Release payload file: {relative} in {owner}")
        require(
            size <= MAX_RELEASE_FILE_BYTES,
            f"Release payload single-file budget exceeded ({MAX_RELEASE_FILE_BYTES} bytes): {relative} in {owner}",
        )
        total += size
    require(
        total <= MAX_RELEASE_PAYLOAD_BYTES,
        f"Release payload total-byte budget exceeded ({MAX_RELEASE_PAYLOAD_BYTES} bytes): {owner}",
    )


def check_file_records(
    records: object,
    job_root: Path,
    owner: Path,
    *,
    minimum_bytes: int = 0,
    enforce_release_policy: bool = False,
) -> set[str]:
    require(isinstance(records, list), f"files must be an array: {owner}")
    assert isinstance(records, list)
    if enforce_release_policy:
        require(
            len(records) <= MAX_RELEASE_PAYLOAD_FILES,
            f"Release payload file-count budget exceeded ({MAX_RELEASE_PAYLOAD_FILES}): {owner}",
        )

    paths: set[str] = set()
    casefolded_paths: set[str] = set()
    validated: list[tuple[PurePosixPath, int, str]] = []
    total = 0
    for item in records:
        require(isinstance(item, dict), f"file record must be an object: {owner}")
        assert isinstance(item, dict)
        require({"path", "bytes", "sha256"} <= item.keys(), f"incomplete file record: {owner}")
        relative = safe_relative_path(item.get("path"), owner)
        relative_text = relative.as_posix()
        require(relative_text not in paths, f"duplicate file record {relative_text!r}: {owner}")
        folded = relative_text.casefold()
        require(folded not in casefolded_paths, f"case-colliding file record {relative_text!r}: {owner}")
        paths.add(relative_text)
        casefolded_paths.add(folded)

        size = item.get("bytes")
        require(type(size) is int and size >= minimum_bytes, f"invalid byte size for {relative_text} in {owner}")
        assert isinstance(size, int)
        if enforce_release_policy:
            require(
                size <= MAX_RELEASE_FILE_BYTES,
                f"Release payload single-file budget exceeded ({MAX_RELEASE_FILE_BYTES} bytes): "
                f"{relative_text} in {owner}",
            )
            total += size
        digest = item.get("sha256")
        require(
            isinstance(digest, str) and bool(SHA256.fullmatch(digest)),
            f"invalid SHA256 for {relative_text} in {owner}",
        )
        assert isinstance(digest, str)
        validated.append((relative, size, digest))

    if enforce_release_policy:
        require(
            total <= MAX_RELEASE_PAYLOAD_BYTES,
            f"Release payload total-byte budget exceeded ({MAX_RELEASE_PAYLOAD_BYTES} bytes): {owner}",
        )

    # Only touch payload bytes after every declared stat budget has passed.
    job_root_resolved = job_root.resolve(strict=True)
    for relative, size, digest in validated:
        target = job_root.joinpath(*relative.parts)
        require(target.is_file() and not target.is_symlink(), f"manifest file is missing or a symlink: {target}")
        try:
            target.resolve(strict=True).relative_to(job_root_resolved)
        except (OSError, ValueError) as exc:
            raise AssertionError(f"manifest file escapes its job root: {target}") from exc
        require(target.stat().st_size == size, f"byte-size mismatch for {target}")
        actual_digest = release_sha256(target) if enforce_release_policy else sha256(target)
        require(actual_digest == digest, f"SHA256 mismatch for {target}")
    return paths


def check_payload_manifest(task: dict, task_path: Path, artifact: dict) -> None:
    job_root = task_path.parent
    manifest_relative = safe_relative_path(artifact["payloadManifestPath"], task_path)
    require(
        manifest_relative == PurePosixPath("MANIFEST.json"),
        f"payloadManifestPath must be MANIFEST.json for the flat Release contract: {task_path}",
    )
    manifest_path = job_root.joinpath(*manifest_relative.parts)
    require(manifest_path.is_file() and not manifest_path.is_symlink(), f"payload manifest is missing: {manifest_path}")
    try:
        manifest_path.resolve(strict=True).relative_to(job_root.resolve(strict=True))
    except (OSError, ValueError) as exc:
        raise AssertionError(f"payload manifest escapes its job root: {manifest_path}") from exc
    require(
        manifest_path.stat().st_size <= MAX_RELEASE_FILE_BYTES,
        f"payload manifest exceeds the bounded JSON size: {manifest_path}",
    )
    payload_file_count = artifact["payloadFileCount"]
    require(
        type(payload_file_count) is int and 1 <= payload_file_count <= MAX_RELEASE_PAYLOAD_FILES,
        f"invalid payloadFileCount: {task_path}",
    )
    manifest_digest = artifact["payloadManifestSha256"]
    require(
        isinstance(manifest_digest, str) and bool(SHA256.fullmatch(manifest_digest)),
        f"invalid payload manifest SHA256: {task_path}",
    )
    require(sha256(manifest_path) == manifest_digest, f"payload manifest SHA256 mismatch: {manifest_path}")

    manifest = load(manifest_path)
    require(isinstance(manifest, dict), f"payload manifest must be an object: {manifest_path}")
    require(manifest.get("schemaVersion") == "1.0", f"payload manifest schemaVersion mismatch: {manifest_path}")
    require(manifest.get("jobId") == task["jobId"], f"payload manifest jobId mismatch: {manifest_path}")
    require(
        manifest.get("releaseTag") == artifact["releaseTag"],
        f"payload manifest releaseTag mismatch: {manifest_path}",
    )
    require(manifest.get("scope") == "release-payload", f"payload manifest scope mismatch: {manifest_path}")
    require(manifest.get("selfExcluded") is True, f"payload manifest must declare selfExcluded=true: {manifest_path}")
    require(manifest.get("taskExcluded") is True, f"payload manifest must declare taskExcluded=true: {manifest_path}")
    manifest_paths = check_file_records(
        manifest.get("files"),
        job_root,
        manifest_path,
        minimum_bytes=1,
        enforce_release_policy=True,
    )
    require(len(manifest_paths) == payload_file_count, f"payloadFileCount mismatch: {task_path}")

    published = actual_files(job_root)
    excluded = {"TASK.json", "MANIFEST.json", manifest_relative.as_posix()}
    expected_files = {relative: target for relative, target in published.items() if relative not in excluded}
    check_actual_release_budget(expected_files, manifest_path)
    expected_paths = set(expected_files)
    require(
        manifest_paths == expected_paths,
        f"payload manifest coverage mismatch: missing={sorted(expected_paths - manifest_paths)}, "
        f"extra={sorted(manifest_paths - expected_paths)} in {manifest_path}",
    )


def check_task(path: Path) -> None:
    task = load(path)
    assert task["schemaVersion"] == "1.0", path
    assert JOB_ID.fullmatch(task["jobId"]), path
    assert task["state"] == "PUBLISHED", path
    artifact = task["artifact"]
    assert artifact["delivery"] == "github-private-release", path
    assert artifact["format"] == "zip", path
    assert SHA256.fullmatch(artifact["sha256"]), path
    assert isinstance(artifact["bytes"], int) and artifact["bytes"] > 0, path
    assert task["execution"]["productionConnectionEnabled"] is False, path
    assert task["security"]["productionApiAllowed"] is False, path
    manifest_fields_present = PAYLOAD_MANIFEST_FIELDS & artifact.keys()
    if manifest_fields_present:
        require(
            manifest_fields_present == PAYLOAD_MANIFEST_FIELDS,
            f"payload manifest fields must appear together; present={sorted(manifest_fields_present)}: {path}",
        )
    modern_release = bool(manifest_fields_present)
    inputs = task.get("inputs", [])
    input_paths = check_file_records(
        inputs,
        path.parent,
        path,
        minimum_bytes=1,
        enforce_release_policy=modern_release,
    )

    if modern_release:
        require("inputs" in task, f"payload manifest contract requires an explicit TASK.inputs array: {path}")
        expected_input_files = actual_files(path.parent, "inputs")
        check_actual_release_budget(expected_input_files, path)
        expected_inputs = set(expected_input_files)
        require(
            input_paths == expected_inputs,
            f"TASK.inputs coverage mismatch: missing={sorted(expected_inputs - input_paths)}, "
            f"extra={sorted(input_paths - expected_inputs)} in {path}",
        )
        check_payload_manifest(task, path, artifact)


def check_receipt(path: Path) -> None:
    receipt = load(path)
    assert receipt["schemaVersion"] == "1.0", path
    assert JOB_ID.fullmatch(receipt["jobId"]), path
    assert receipt["state"] in RECEIPT_STATES, path
    assert isinstance(receipt["message"], str) and 0 < len(receipt["message"]) <= 2000, path
    assert isinstance(receipt["evidence"], list), path


def main() -> int:
    attributes = (ROOT / ".gitattributes").read_text(encoding="utf-8")
    assert "* text=auto eol=lf" in attributes.splitlines(), "LF checkout contract missing"
    for path in ROOT.rglob("*"):
        if ".git" in path.parts or not path.is_file():
            continue
        relative_text = path.relative_to(ROOT).as_posix()
        safe_walkthrough = path.suffix.lower() == ".mp4" and bool(SAFE_WALKTHROUGH.fullmatch(relative_text))
        safe_spatial_context = path.suffix.lower() == ".mp4" and bool(SAFE_SPATIAL_CONTEXT.fullmatch(relative_text))
        if path.suffix.lower() == ".mp4":
            valid_walkthrough = safe_walkthrough and path.stat().st_size <= MAX_WALKTHROUGH_BYTES
            valid_spatial_context = safe_spatial_context and path.stat().st_size <= MAX_SPATIAL_CONTEXT_BYTES
            if not (valid_walkthrough or valid_spatial_context):
                raise AssertionError(
                    "only a <=15MiB named Viewer walkthrough or <=5MiB fixed-photo spatial-context video "
                    f"may be tracked: {relative_text}"
                )
        elif path.suffix.lower() in FORBIDDEN_SUFFIXES:
            raise AssertionError(f"forbidden tracked suffix: {path.relative_to(ROOT)}")
        if not (safe_walkthrough or safe_spatial_context) and path.stat().st_size > 5 * 1024 * 1024:
            raise AssertionError(f"large file belongs in a private Release: {path.relative_to(ROOT)}")

    tasks = sorted(ROOT.glob("jobs/to-4060/*/TASK.json"))
    assert tasks, "no TASK.json found"
    for task in tasks:
        check_task(task)

    for receipt in ROOT.glob("receipts/from-4060/*/*.json"):
        check_receipt(receipt)

    for schema in ROOT.glob("schemas/*.json"):
        load(schema)

    print(f"OK: {len(tasks)} task(s); Bridge JSON and data boundaries verified")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, KeyError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
    ".gif",
    ".m4v",
    ".ico",
    ".obj",
    ".ogg",
