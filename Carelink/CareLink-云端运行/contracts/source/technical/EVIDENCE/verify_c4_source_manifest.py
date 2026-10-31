#!/usr/bin/env python3
"""Read-only verifier for the historical UNSEEN C4 source fingerprints."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def selected_paths(scope: dict, method: dict) -> list[Path]:
    root = Path(scope["rootAbsolutePath"])
    if scope["selection"] == "all_files":
        paths = [path for path in root.rglob("*") if path.is_file()]
    elif scope["selection"] == "source_extensions":
        extensions = set(method["includeExtensions"])
        excluded = set(method["excludedDirectoryNames"])
        paths = []
        for base, dirs, files in os.walk(root):
            dirs[:] = [name for name in dirs if name not in excluded]
            for name in files:
                path = Path(base) / name
                if path.suffix in extensions:
                    paths.append(path)
    else:
        raise AssertionError(f"unknown selection: {scope['selection']}")
    return sorted(paths, key=lambda path: os.fsencode(str(path)))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "manifest",
        nargs="?",
        type=Path,
        default=Path(__file__).with_name("c4-source-manifest-baseline.json"),
    )
    parser.add_argument("--print-lines", action="store_true")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    assert manifest["schemaVersion"] == "unseen-c4-source-manifest/1"
    verifier = Path(__file__).resolve()
    assert sha256_file(verifier) == manifest["verifier"]["sha256"]

    method = manifest["historicalMethod"]
    assert method["lineFormat"] == "{sha256}  {absolutePath}\\n"
    for scope in manifest["scopes"]:
        paths = selected_paths(scope, method)
        expected = scope["entries"]
        assert len(paths) == scope["expectedCount"] == len(expected)
        assert [str(path) for path in paths] == [item["absolutePath"] for item in expected]

        lines: list[bytes] = []
        for path, item in zip(paths, expected, strict=True):
            assert path.stat().st_size == item["bytes"], str(path)
            digest = sha256_file(path)
            assert digest == item["sha256"], str(path)
            line = f"{digest}  {path}\n".encode("utf-8")
            lines.append(line)
            if args.print_lines:
                print(line.decode("utf-8"), end="")

        aggregate = hashlib.sha256(b"".join(lines)).hexdigest()
        assert aggregate == scope["expectedAggregateSha256"], scope["id"]
        print(f"PASS {scope['id']} files={len(paths)} sha256={aggregate}")

    print("C4_SOURCE_MANIFEST_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
