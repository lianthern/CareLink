#!/usr/bin/env python3
"""Search UNSEEN's archive and restore a verified file into a new location."""
import argparse
import contextlib
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CATALOG = ROOT / "archive/catalog/20260920"


def read_json(path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as stream:
        return json.load(stream)


def rows(catalog):
    with gzip.open(catalog / "files.jsonl.gz", "rt", encoding="utf-8") as stream:
        for line in stream:
            yield json.loads(line)


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(data)
    return digest.hexdigest()


def human_size(size):
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024


def search(catalog, query, category=None, source=None):
    terms = query.casefold().split()
    for row in rows(catalog):
        if category and row["category"] != category:
            continue
        if source and source not in row["source"]:
            continue
        haystack = " ".join(str(row.get(k, "")) for k in ("id", "path", "source", "title", "sha256")).casefold()
        if all(term in haystack for term in terms):
            yield row


def find_file(catalog, file_id):
    for row in rows(catalog):
        if row["id"] == file_id:
            return row
    raise ValueError(f"没有找到文件 ID：{file_id}")


class Capsules:
    def __init__(self, catalog, key, cache):
        self.coverage = read_json(catalog / "coverage.json")
        self.packs = read_json(catalog / "packs.json")
        self.key = key
        self.cache = cache

    @contextlib.contextmanager
    def open(self, index):
        pack = self.packs[index]
        name = pack["asset"]
        if not re.fullmatch(r"capsule-\d{4}-[a-f0-9]{16}\.zip\.age", name):
            raise ValueError("附件名不符合归档格式")
        self.cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        encrypted = self.cache / name
        if not encrypted.exists():
            with tempfile.TemporaryDirectory(prefix="download-", dir=self.cache) as tmp:
                subprocess.run([
                    "gh", "release", "download", self.coverage["tag"],
                    "--repo", self.coverage["repository"], "--pattern", name, "--dir", tmp,
                ], check=True)
                fetched = Path(tmp) / name
                self.verify_encrypted(fetched, pack)
                fetched.replace(encrypted)
        self.verify_encrypted(encrypted, pack)
        with tempfile.TemporaryDirectory(prefix="decrypt-", dir=self.cache) as tmp:
            plain = Path(tmp) / "capsule.zip"
            subprocess.run(["age", "--decrypt", "--identity", str(self.key), "--output", str(plain), str(encrypted)], check=True)
            if sha256(plain) != pack["plaintextSha256"]:
                raise ValueError("解密后的附件 SHA256 不匹配")
            with zipfile.ZipFile(plain) as archive:
                yield archive

    @staticmethod
    def verify_encrypted(path, pack):
        if path.stat().st_size != pack["bytes"] or sha256(path) != pack["sha256"]:
            raise ValueError("下载附件校验失败；没有恢复文件。请检查或移走损坏的缓存附件。")


def assemble(row, obj, provider, stream):
    """Read only the named ZIP members; never extract paths from an archive."""
    if obj["bytes"] != row["bytes"]:
        raise ValueError("目录与原件长度不匹配")
    total = 0
    digest = hashlib.sha256()
    parts = obj["parts"]
    if not parts:
        raise ValueError("原件缺少分块记录")
    pos = 0
    while pos < len(parts):
        pack_index = parts[pos]["pack"]
        with provider.open(pack_index) as archive:
            while pos < len(parts) and parts[pos]["pack"] == pack_index:
                part = parts[pos]
                expected_name = f"objects/{row['sha256']}/{pos:05d}"
                if part["member"] != expected_name:
                    raise ValueError("原件分块顺序或路径不匹配")
                info = archive.getinfo(expected_name)
                if info.file_size != part["bytes"]:
                    raise ValueError("分块长度不匹配")
                chunk = hashlib.sha256()
                amount = 0
                with archive.open(info) as source:
                    for data in iter(lambda: source.read(1024 * 1024), b""):
                        stream.write(data)
                        chunk.update(data)
                        digest.update(data)
                        amount += len(data)
                        total += len(data)
                if amount != part["bytes"] or chunk.hexdigest() != part["sha256"]:
                    raise ValueError("原件分块 SHA256 不匹配")
                pos += 1
    if total != row["bytes"] or digest.hexdigest() != row["sha256"]:
        raise ValueError("完整原件 SHA256 不匹配")


def restore(row, catalog, output, key, cache, provider=None, repo_root=ROOT):
    if row["kind"] != "file" or row.get("status") != "archived":
        raise ValueError(f"该条目没有可恢复的普通文件原件：{row.get('status', row['kind'])}")
    if output.exists() or output.is_symlink():
        raise FileExistsError(f"目标已存在，不覆盖：{output}")
    local = None
    if row.get("repoPath"):
        candidate = (repo_root / row["repoPath"]).resolve()
        if candidate.is_relative_to(repo_root.resolve()) and candidate.is_file() and sha256(candidate) == row["sha256"]:
            local = candidate
    if not local:
        objects = read_json(catalog / "objects.json.gz")
        obj = objects.get(row["sha256"])
        if obj is None:
            raise ValueError("原件索引缺失")
        if provider is None:
            if not key.is_file():
                raise FileNotFoundError(f"需要归档恢复密钥：{key}（也可用 --key 指定）")
            for command in ("gh", "age"):
                if not shutil.which(command):
                    raise ValueError(f"恢复需要安装 {command}")
            provider = Capsules(catalog, key, cache)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".unseen-restore-", dir=output.parent, delete=False) as stream:
            temporary = Path(stream.name)
            if local:
                with local.open("rb") as source:
                    shutil.copyfileobj(source, stream)
            else:
                assemble(row, obj, provider, stream)
            stream.flush()
            os.fsync(stream.fileno())
        if temporary.stat().st_size != row["bytes"] or sha256(temporary) != row["sha256"]:
            raise ValueError("恢复结果 SHA256 不匹配")
        os.chmod(temporary, 0o700 if row.get("mode", 0) & 0o111 else 0o600)
        # Same-directory hard link is atomic and refuses an existing destination.
        os.link(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return output


def validate(catalog):
    packs = read_json(catalog / "packs.json")
    objects = read_json(catalog / "objects.json.gz")
    count = 0
    ids = set()
    public_fields = {"id", "source", "sourceId", "path", "bytes", "kind", "status", "category", "mtime", "mode", "sha256", "repoPath", "title"}
    for row in rows(catalog):
        if set(row) - public_fields:
            raise ValueError("搜索目录混入了非公开元数据字段")
        if row.get("sha256") and not re.fullmatch(r"[a-f0-9]{64}", row["sha256"]):
            raise ValueError("文件 SHA256 格式错误")
        if row["id"] in ids:
            raise ValueError("重复文件 ID")
        ids.add(row["id"])
        if row.get("status") != "archived":
            continue
        obj = objects[row["sha256"]]
        if obj["bytes"] != row["bytes"] or not obj["parts"]:
            raise ValueError("原件大小/分块缺失")
        if sum(p["bytes"] for p in obj["parts"]) != row["bytes"]:
            raise ValueError("分块总大小错误")
        for i, part in enumerate(obj["parts"]):
            if not 0 <= part["pack"] < len(packs):
                raise ValueError("分块引用了不存在的附件")
            if part["member"] != f"objects/{row['sha256']}/{i:05d}":
                raise ValueError("分块路径错误")
        count += 1
    return {"files": count, "entries": len(ids), "objects": len(objects), "capsules": len(packs)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=DEFAULT_CATALOG)
    commands = parser.add_subparsers(dest="command", required=True)
    find = commands.add_parser("find", help="搜索名称、文档标题、来源或 SHA256")
    find.add_argument("query")
    find.add_argument("--category")
    find.add_argument("--source")
    find.add_argument("--limit", type=int, default=30)
    find.add_argument("--json", action="store_true")
    get = commands.add_parser("restore", help="恢复到新文件；绝不覆盖原文件")
    get.add_argument("id")
    get.add_argument("--output", type=Path, required=True)
    get.add_argument("--key", type=Path, default=Path(os.environ.get("UNSEEN_ARCHIVE_KEY", str(Path.home() / ".config/unseen-archive/owner-20260920.agekey"))))
    get.add_argument("--cache", type=Path, default=ROOT / ".local/archive-cache")
    commands.add_parser("verify", help="验证目录内全部原件引用与分块长度")
    commands.add_parser("coverage", help="查看快照覆盖范围和缺口")
    args = parser.parse_args()
    try:
        if args.command == "find":
            matches = list(search(args.catalog, args.query, args.category, args.source))
            chosen = matches[:max(0, args.limit)] if args.limit else matches
            if args.json:
                print(json.dumps({"total": len(matches), "files": chosen}, ensure_ascii=False, indent=2))
            else:
                print(f"找到 {len(matches)} 条，显示 {len(chosen)} 条。ID 可用于 restore。")
                for row in chosen:
                    print(f"{row['id']}  {human_size(row['bytes']):>10}  {row['status']}\n  {row['source']}/{row['path']}")
                    if row.get("title"):
                        print("  " + row["title"])
        elif args.command == "restore":
            row = find_file(args.catalog, args.id)
            result = restore(row, args.catalog, args.output.expanduser().absolute(), args.key.expanduser(), args.cache.expanduser())
            print(json.dumps({"status": "restored-sha256-verified", "path": str(result), "sha256": row["sha256"]}, ensure_ascii=False))
        elif args.command == "verify":
            print(json.dumps(validate(args.catalog), ensure_ascii=False))
        else:
            print(json.dumps(read_json(args.catalog / "coverage.json"), ensure_ascii=False, indent=2))
    except (ValueError, OSError, KeyError, zipfile.BadZipFile, subprocess.CalledProcessError) as exc:
        print(f"归档操作未完成：{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
