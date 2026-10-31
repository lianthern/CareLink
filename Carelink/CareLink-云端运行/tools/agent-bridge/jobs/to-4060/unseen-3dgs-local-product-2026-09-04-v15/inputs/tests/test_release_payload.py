import hashlib
import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/linux/verify_release_payload.py"
SPEC = importlib.util.spec_from_file_location("verify_release_payload", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class ReleasePayloadTests(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        (root / "inputs").mkdir()
        payload = root / "inputs/example.txt"
        payload.write_text("verified\n", encoding="utf-8")
        manifest = {
            "schemaVersion": "1.0",
            "jobId": MODULE.JOB_ID,
            "releaseTag": MODULE.JOB_ID + "-r3",
            "scope": "release-payload",
            "selfExcluded": True,
            "taskExcluded": True,
            "files": [{
                "path": "inputs/example.txt",
                "bytes": payload.stat().st_size,
                "sha256": hashlib.sha256(payload.read_bytes()).hexdigest(),
            }],
        }
        manifest_path = root / "MANIFEST.json"
        manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
        digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        return temporary, root, digest

    def test_exact_tree_passes(self):
        temporary, root, digest = self.fixture()
        self.addCleanup(temporary.cleanup)
        result = MODULE.verify(root, digest)
        self.assertEqual(result["state"], "PAYLOAD_MANIFEST_VERIFIED")
        self.assertEqual(result["fileCount"], 1)

    def test_extra_file_fails(self):
        temporary, root, digest = self.fixture()
        self.addCleanup(temporary.cleanup)
        (root / "extra.txt").write_text("not listed", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "extra"):
            MODULE.verify(root, digest)

    def test_file_tamper_fails(self):
        temporary, root, digest = self.fixture()
        self.addCleanup(temporary.cleanup)
        (root / "inputs/example.txt").write_text("changed\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "mismatch"):
            MODULE.verify(root, digest)

    def test_external_manifest_hash_is_required(self):
        temporary, root, _digest = self.fixture()
        self.addCleanup(temporary.cleanup)
        with self.assertRaisesRegex(ValueError, "external"):
            MODULE.verify(root, "0" * 63)

    def test_path_traversal_is_rejected(self):
        for value in ("../secret", "/absolute", "a\\b", "a//b", "inputs/NUL.txt", "inputs/trailing. ", "inputs/a:b"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                MODULE.safe_relative(value)

    def test_manifest_size_budget_is_enforced_before_file_read(self):
        temporary, root, _digest = self.fixture()
        self.addCleanup(temporary.cleanup)
        manifest_path = root / "MANIFEST.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["files"][0]["bytes"] = MODULE.MAX_PAYLOAD_FILE_BYTES + 1
        manifest_path.write_text(json.dumps(manifest) + "\n", encoding="utf-8")
        digest = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError, "byte count"):
            MODULE.verify(root, digest)

    @unittest.skipIf(os.name == "nt", "symlink setup is Unix-specific")
    def test_intermediate_symlink_escape_is_rejected_before_hashing(self):
        temporary, root, digest = self.fixture()
        self.addCleanup(temporary.cleanup)
        external = root.parent / f"{root.name}-external"
        external.mkdir()
        self.addCleanup(shutil.rmtree, external, True)
        (root / "inputs/example.txt").replace(external / "example.txt")
        (root / "inputs").rmdir()
        (root / "inputs").symlink_to(external, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "escapes|symlink"):
            MODULE.verify(root, digest)


if __name__ == "__main__":
    unittest.main()
