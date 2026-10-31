import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

MODULE = Path(__file__).resolve().parents[2] / "scripts/archive/archive.py"
SPEC = importlib.util.spec_from_file_location("unseen_archive", MODULE)
archive = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(archive)


class LocalCapsules:
    def __init__(self, paths):
        self.paths = paths

    @contextlib.contextmanager
    def open(self, index):
        with zipfile.ZipFile(self.paths[index]) as value:
            yield value


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = "一份旧实验\n".encode() * 13 + b"\x00\xffbinary"
        sha = hashlib.sha256(self.data).hexdigest()
        self.row = {"id": "example", "source": "old-worktree", "path": "draft/旧实验.md", "title": "空间路线对比",
                    "category": "文档与草稿", "bytes": len(self.data), "sha256": sha, "kind": "file", "status": "archived"}
        self.parts = []
        self.paths = []
        chunks = [self.data[:31], self.data[31:83], self.data[83:]]
        for i, chunk in enumerate(chunks):
            name = f"objects/{sha}/{i:05d}"
            path = self.root / f"pack-{i}.zip"
            with zipfile.ZipFile(path, "w") as pack:
                pack.writestr(name, chunk)
                pack.writestr("../../should-never-be-extracted", b"not an archive object")
            self.paths.append(path)
            self.parts.append({"pack": i, "member": name, "bytes": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})
        self.obj = {"bytes": len(self.data), "parts": self.parts}
        self.write_catalog()
        self.output = self.root / "restored" / "original.md"
        self.provider = LocalCapsules(self.paths)

    def write_catalog(self):
        (self.root / "objects.json.gz").write_bytes(gzip.compress(json.dumps({self.row["sha256"]: self.obj}).encode()))
        (self.root / "files.jsonl.gz").write_bytes(gzip.compress((json.dumps(self.row, ensure_ascii=False) + "\n").encode()))
        (self.root / "packs.json").write_text(json.dumps([{}, {}, {}]))

    def restore(self):
        return archive.restore(self.row, self.root, self.output, self.root / "unused-key", self.root / "cache", provider=self.provider)

    def test_reassembles_multiple_capsules_and_checks_hash(self):
        self.restore()
        self.assertEqual(self.output.read_bytes(), self.data)
        self.assertFalse((self.root / "should-never-be-extracted").exists())
        self.assertEqual(archive.validate(self.root)["files"], 1)

    def test_searches_chinese_title_and_original_source(self):
        self.assertEqual(len(list(archive.search(self.root, "空间 old-worktree"))), 1)
        self.assertEqual(len(list(archive.search(self.root, "不存在"))), 0)

    def test_existing_destination_is_not_overwritten(self):
        self.output.parent.mkdir()
        self.output.write_bytes(b"my newer work")
        with self.assertRaises(FileExistsError):
            self.restore()
        self.assertEqual(self.output.read_bytes(), b"my newer work")

    def test_dangling_destination_symlink_is_not_overwritten(self):
        self.output.parent.mkdir()
        self.output.symlink_to(self.root / "missing")
        with self.assertRaises(FileExistsError):
            self.restore()
        self.assertTrue(self.output.is_symlink())

    def test_corrupt_chunk_leaves_no_destination(self):
        self.parts[1]["sha256"] = "0" * 64
        self.write_catalog()
        with self.assertRaisesRegex(ValueError, "分块 SHA256"):
            self.restore()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.output.parent.glob(".unseen-restore-*")))

    def test_wrong_full_hash_is_rejected(self):
        row = {**self.row, "sha256": "1" * 64}
        parts = [{**part, "member": part["member"].replace(self.row["sha256"], row["sha256"])} for part in self.parts]
        for path, part, chunk in zip(self.paths, parts, [self.data[:31], self.data[31:83], self.data[83:]]):
            with zipfile.ZipFile(path, "w") as pack:
                pack.writestr(part["member"], chunk)
        with self.assertRaisesRegex(ValueError, "完整原件"):
            archive.assemble(row, {"bytes": row["bytes"], "parts": parts}, self.provider, io.BytesIO())

    def test_empty_file_restores(self):
        digest = hashlib.sha256(b"").hexdigest()
        row = {**self.row, "sha256": digest, "bytes": 0}
        member = f"objects/{digest}/00000"
        with zipfile.ZipFile(self.paths[0], "w") as pack:
            pack.writestr(member, b"")
        obj = {"bytes": 0, "parts": [{"pack": 0, "member": member, "bytes": 0, "sha256": digest}]}
        output = io.BytesIO()
        archive.assemble(row, obj, self.provider, output)
        self.assertEqual(output.getvalue(), b"")

    def test_missing_cloud_original_is_not_claimed_restored(self):
        self.row.update(kind="cloud-placeholder", status="pending")
        with self.assertRaisesRegex(ValueError, "没有可恢复"):
            self.restore()
        self.assertFalse(self.output.exists())

    def test_malicious_member_path_is_rejected(self):
        self.parts[0]["member"] = "../../should-never-be-extracted"
        self.write_catalog()
        with self.assertRaisesRegex(ValueError, "分块顺序或路径"):
            self.restore()
        self.assertFalse(self.output.exists())

    def test_tampered_download_is_rejected(self):
        pack = {"bytes": self.paths[0].stat().st_size, "sha256": "0" * 64}
        with self.assertRaisesRegex(ValueError, "下载附件校验失败"):
            archive.Capsules.verify_encrypted(self.paths[0], pack)

    def test_missing_pack_is_rejected_by_catalog_validation(self):
        self.parts[-1]["pack"] = 100
        self.write_catalog()
        with self.assertRaisesRegex(ValueError, "不存在的附件"):
            archive.validate(self.root)

    def test_private_capture_fields_cannot_leak_into_search_catalog(self):
        self.row["localPath"] = "/private/original/location"
        self.write_catalog()
        with self.assertRaisesRegex(ValueError, "非公开元数据字段"):
            archive.validate(self.root)

    def test_local_copy_is_hash_verified_without_archive_key(self):
        local = self.root / "repo" / "draft.md"
        local.parent.mkdir()
        local.write_bytes(self.data)
        row = {**self.row, "repoPath": "draft.md"}
        archive.restore(row, self.root, self.output, self.root / "missing-key", self.root / "cache", repo_root=local.parent)
        self.assertEqual(self.output.read_bytes(), self.data)


if __name__ == "__main__":
    unittest.main()
