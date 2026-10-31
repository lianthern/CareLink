from __future__ import annotations

import contextlib
import hashlib
import io
import json
import stat
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

REPOSITORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY / "scripts"))

import build_v15_release as builder
import verify_bridge


def write_json(path: Path, value: object) -> None:
    path.write_bytes((json.dumps(value, indent=2) + "\n").encode("utf-8"))


class ReleaseBuilderTests(unittest.TestCase):
    def make_checkout(self, base: Path) -> tuple[Path, Path]:
        checkout = base / "checkout"
        job = checkout / "jobs/to-4060" / builder.JOB_ID
        (job / "inputs/scripts").mkdir(parents=True)
        for name in builder.TOP_LEVEL_PAYLOAD:
            (job / name).write_text(f"{name}\n", encoding="utf-8")
        (job / "inputs/.env.example").write_text("PRODUCTION_CONNECTION_ENABLED=false\n", encoding="utf-8")
        (job / "inputs/scripts/run.py").write_text("print('ok')\n", encoding="utf-8")
        (job / "MANIFEST.json").write_text("{}\n", encoding="utf-8")
        write_json(
            job / "TASK.json",
            {
                "schemaVersion": "1.0",
                "jobId": builder.JOB_ID,
                "targetAgent": "test",
                "publishedAt": "2026-09-04T00:00:00Z",
                "state": "PUBLISHED",
                "artifact": {
                    "delivery": "github-private-release",
                    "releaseTag": "old",
                    "assetName": "old.zip",
                    "sha256": "0" * 64,
                    "bytes": 1,
                    "format": "zip",
                },
                "inputs": [],
                "execution": {"entryPath": "START-HERE.md", "productionConnectionEnabled": False},
                "receipt": {},
                "security": {"productionApiAllowed": False},
            },
        )
        return checkout, job

    @contextlib.contextmanager
    def use_checkout(self, checkout: Path, job: Path):
        with (
            mock.patch.object(builder, "ROOT", checkout),
            mock.patch.object(builder, "JOB_ROOT", job),
        ):
            yield

    def build(self, checkout: Path, job: Path, output: Path) -> dict:
        stdout = io.StringIO()
        with self.use_checkout(checkout, job), contextlib.redirect_stdout(stdout):
            result = builder.main(
                [
                    "--release",
                    "r3",
                    "--output-dir",
                    str(output),
                    "--published-at",
                    "2026-09-04T15:00:00Z",
                    "--write-contract",
                ]
            )
        self.assertEqual(result, 0)
        return json.loads(stdout.getvalue())

    def assert_build_fails_without_contract_change(
        self,
        checkout: Path,
        job: Path,
        output: Path,
        expected: str,
    ) -> None:
        task_before = (job / "TASK.json").read_bytes()
        manifest_before = (job / "MANIFEST.json").read_bytes()
        with self.use_checkout(checkout, job), self.assertRaisesRegex(SystemExit, expected):
            builder.main(
                [
                    "--release",
                    "r3",
                    "--output-dir",
                    str(output),
                    "--published-at",
                    "2026-09-04T15:00:00Z",
                    "--write-contract",
                ]
            )
        self.assertEqual((job / "TASK.json").read_bytes(), task_before)
        self.assertEqual((job / "MANIFEST.json").read_bytes(), manifest_before)

    def test_happy_path_is_stored_flat_deterministic_and_verifier_clean(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            checkout, job = self.make_checkout(base)
            (job / "inputs/__pycache__").mkdir()
            (job / "inputs/__pycache__/ignored.pyc").write_bytes(b"cache")
            (job / "inputs/ignored.pyo").write_bytes(b"cache")

            first = self.build(checkout, job, base / "out-one")
            verify_bridge.check_task(job / "TASK.json")
            second = self.build(checkout, job, base / "out-two")

            first_asset = Path(first["assetPath"])
            second_asset = Path(second["assetPath"])
            self.assertEqual(first_asset.read_bytes(), second_asset.read_bytes())
            self.assertEqual(first["assetSha256"], second["assetSha256"])
            self.assertEqual(first["compression"], "stored")
            with zipfile.ZipFile(first_asset) as archive:
                names = archive.namelist()
                self.assertEqual(names[0], "MANIFEST.json")
                self.assertNotIn("TASK.json", names)
                self.assertNotIn("inputs/ignored.pyo", names)
                self.assertTrue(all(item.compress_type == zipfile.ZIP_STORED for item in archive.infolist()))
                manifest = json.loads(archive.read("MANIFEST.json"))
            self.assertTrue(manifest["selfExcluded"])
            self.assertTrue(manifest["taskExcluded"])
            self.assertNotIn("MANIFEST.json", {item["path"] for item in manifest["files"]})
            self.assertNotIn("TASK.json", {item["path"] for item in manifest["files"]})

    def test_forbidden_cache_media_and_secret_paths_fail_closed(self) -> None:
        cases = {
            "inputs/.pytest_cache/state": b"cache",
            "inputs/venv/secret.txt": b"venv",
            "inputs/private.jpg": b"frame",
            "inputs/.env": b"TOKEN=real-secret",
            "inputs/id_rsa": b"private-key",
            "inputs/secret.txt": b"credential",
            "inputs/.git/config": b"repository metadata",
        }
        for relative, data in cases.items():
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as raw:
                base = Path(raw)
                checkout, job = self.make_checkout(base)
                target = job / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                self.assert_build_fails_without_contract_change(
                    checkout,
                    job,
                    base / "out",
                    "forbidden generated/media/secret release path",
                )

    def test_root_verifier_uses_the_same_cache_and_forbidden_path_policy(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            job = Path(raw) / "job"
            (job / "inputs/__pycache__").mkdir(parents=True)
            (job / "inputs/keep.txt").write_text("payload", encoding="utf-8")
            (job / "inputs/ignored.pyo").write_bytes(b"cache")
            (job / "inputs/__pycache__/ignored.pyc").write_bytes(b"cache")
            self.assertEqual(set(verify_bridge.actual_files(job, "inputs")), {"inputs/keep.txt"})

            (job / "inputs/.pytest_cache").mkdir()
            (job / "inputs/.pytest_cache/state").write_text("generated", encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "forbidden generated/media/secret path"):
                verify_bridge.actual_files(job, "inputs")

    def test_builder_rejects_payload_budgets_before_reading_any_payload_bytes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            _, job = self.make_checkout(base)
            oversized = job / "inputs/oversized.dat"
            with oversized.open("wb") as handle:
                handle.truncate(verify_bridge.MAX_RELEASE_FILE_BYTES + 1)
            with (
                mock.patch.object(Path, "open", side_effect=AssertionError("payload was opened")),
                self.assertRaisesRegex(ValueError, "single-file budget exceeded"),
            ):
                builder.freeze_payload(job)

        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            _, job = self.make_checkout(base)
            for index in range(4):
                target = job / f"inputs/sparse-{index}.dat"
                with target.open("wb") as handle:
                    handle.truncate(verify_bridge.MAX_RELEASE_FILE_BYTES)
            with (
                mock.patch.object(Path, "open", side_effect=AssertionError("payload was opened")),
                self.assertRaisesRegex(ValueError, "total-byte budget exceeded"),
            ):
                builder.freeze_payload(job)

        candidate = builder.ReleaseCandidate("inputs/member.txt", Path("unused"), 1, 0, 0, 0)
        with self.assertRaisesRegex(ValueError, "file-count budget exceeded"):
            builder.validate_payload_budget([candidate] * (verify_bridge.MAX_RELEASE_PAYLOAD_FILES + 1))

    def test_root_verifier_preflights_modern_record_budgets_before_file_io(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            digest = "0" * 64
            cases = (
                (
                    [{"path": "inputs/huge.dat", "bytes": verify_bridge.MAX_RELEASE_FILE_BYTES + 1, "sha256": digest}],
                    "single-file budget exceeded",
                ),
                (
                    [
                        {
                            "path": f"inputs/part-{index}.dat",
                            "bytes": verify_bridge.MAX_RELEASE_FILE_BYTES,
                            "sha256": digest,
                        }
                        for index in range(5)
                    ],
                    "total-byte budget exceeded",
                ),
                (
                    [{"path": "inputs/member.dat", "bytes": 1, "sha256": digest}]
                    * (verify_bridge.MAX_RELEASE_PAYLOAD_FILES + 1),
                    "file-count budget exceeded",
                ),
            )
            for records, expected in cases:
                with self.subTest(expected=expected), self.assertRaisesRegex(AssertionError, expected):
                    verify_bridge.check_file_records(
                        records,
                        root,
                        root / "MANIFEST.json",
                        minimum_bytes=1,
                        enforce_release_policy=True,
                    )

    def test_secret_value_scan_covers_env_example_and_binary_without_flagging_regex_source(self) -> None:
        suffix = b"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
        provider_token = b"gh" + b"p_" + suffix
        generic_value = b"z9Y8x7W6v5U4t3S2r1Q0p9O8n7M6"
        cases = (
            ("inputs/.env.example", b"SERVICE_API_KEY" + b"=" + generic_value + b"\n", "credential assignment"),
            ("inputs/blob.dat", b"\x00\xffbinary\x00" + provider_token + b"\x00tail", "GitHub classic PAT"),
            (
                "inputs/key-material.txt",
                b"-----BEGIN " + b"OPENSSH PRIVATE KEY-----\nnot-a-real-key\n",
                "private-key block",
            ),
        )
        for relative, contents, expected in cases:
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as raw:
                base = Path(raw)
                checkout, job = self.make_checkout(base)
                target = job / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(contents)
                self.assert_build_fails_without_contract_change(
                    checkout,
                    job,
                    base / "out",
                    f"probable {expected}",
                )

        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            checkout, job = self.make_checkout(base)
            (job / "inputs/scripts/credential_patterns.py").write_bytes(
                b"PAT = rb'ghp_[A-Za-z0-9]{36}'\n"
                b"HEADER = b'-----BEGIN ' + b'PRIVATE KEY-----'\n"
            )
            self.build(checkout, job, base / "out")

    def test_root_verifier_secret_scan_detects_a_binary_token_across_read_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            job = Path(raw)
            target = job / "inputs/blob.dat"
            target.parent.mkdir(parents=True)
            suffix = b"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
            token = b"gh" + b"p_" + suffix
            chunk_bytes = 1024 * 1024
            contents = b"x" * (chunk_bytes - 3) + b"\x00" + token
            target.write_bytes(contents)
            record = {
                "path": "inputs/blob.dat",
                "bytes": len(contents),
                "sha256": hashlib.sha256(contents).hexdigest(),
            }
            with self.assertRaisesRegex(AssertionError, "probable GitHub classic PAT"):
                verify_bridge.check_file_records(
                    [record],
                    job,
                    job / "MANIFEST.json",
                    minimum_bytes=1,
                    enforce_release_policy=True,
                )

    @unittest.skipIf(sys.platform == "win32", "symlink setup is Unix-specific")
    def test_inputs_root_symlink_is_rejected_before_external_bytes_are_read(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            checkout, job = self.make_checkout(base)
            external = base / "external-inputs"
            (job / "inputs").rename(external)
            (job / "inputs").symlink_to(external, target_is_directory=True)
            self.assert_build_fails_without_contract_change(
                checkout,
                job,
                base / "out",
                "inputs must be a real, non-symlink directory",
            )

    def test_windows_unsafe_and_case_colliding_paths_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            checkout, job = self.make_checkout(base)
            (job / "inputs/NUL.txt").write_text("reserved", encoding="utf-8")
            self.assert_build_fails_without_contract_change(
                checkout,
                job,
                base / "out",
                "Windows-reserved name",
            )

        with self.assertRaisesRegex(ValueError, "case-colliding"):
            builder.validate_unique_paths(
                [
                    builder.FrozenFile("inputs/File.txt", b"one"),
                    builder.FrozenFile("inputs/file.txt", b"two"),
                ],
                Path("test"),
            )

    def test_output_inside_checkout_is_rejected_before_directory_or_contract_write(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            checkout, job = self.make_checkout(base)
            output = checkout / "release-output"
            self.assert_build_fails_without_contract_change(
                checkout,
                job,
                output,
                "release ZIP output must be outside",
            )
            self.assertFalse(output.exists())

    def test_artifact_commit_is_rejected_without_rewriting_contract(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            checkout, job = self.make_checkout(base)
            task = json.loads((job / "TASK.json").read_text())
            task["artifact"]["commit"] = "a" * 40
            write_json(job / "TASK.json", task)
            self.assert_build_fails_without_contract_change(
                checkout,
                job,
                base / "out",
                "artifact.commit is forbidden",
            )

    def test_source_change_during_zip_build_fails_before_contract_write(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            checkout, job = self.make_checkout(base)
            original_zip = builder.deterministic_zip

            def mutate_after_zip(destination: Path, snapshots: list[builder.FrozenFile]) -> None:
                original_zip(destination, snapshots)
                (job / "inputs/scripts/run.py").write_text("print('changed')\n", encoding="utf-8")

            task_before = (job / "TASK.json").read_bytes()
            manifest_before = (job / "MANIFEST.json").read_bytes()
            with (
                self.use_checkout(checkout, job),
                mock.patch.object(builder, "deterministic_zip", mutate_after_zip),
                self.assertRaisesRegex(SystemExit, "payload changed while"),
            ):
                builder.main(
                    [
                        "--release",
                        "r3",
                        "--output-dir",
                        str(base / "out"),
                        "--published-at",
                        "2026-09-04T15:00:00Z",
                        "--write-contract",
                    ]
                )
            self.assertEqual((job / "TASK.json").read_bytes(), task_before)
            self.assertEqual((job / "MANIFEST.json").read_bytes(), manifest_before)

    def test_zip_reopen_detects_member_bytes_not_matching_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            archive_path = Path(raw) / "bad.zip"
            expected = builder.FrozenFile("MANIFEST.json", b"expected")
            with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
                info = zipfile.ZipInfo(expected.relative, date_time=builder.ZIP_TIMESTAMP)
                info.compress_type = zipfile.ZIP_STORED
                info.create_system = 3
                info.external_attr = (0o644 | stat.S_IFREG) << 16
                archive.writestr(info, b"different", compress_type=zipfile.ZIP_STORED)
            with self.assertRaisesRegex(ValueError, "bytes/SHA256 mismatch"):
                builder.verify_built_zip(archive_path, [expected])

    def test_final_verifier_failure_rolls_back_both_contract_files(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            checkout, job = self.make_checkout(base)
            task_before = (job / "TASK.json").read_bytes()
            manifest_before = (job / "MANIFEST.json").read_bytes()
            with (
                self.use_checkout(checkout, job),
                mock.patch.object(
                    builder.bridge_contract,
                    "check_task",
                    side_effect=AssertionError("forced verifier failure"),
                ),
                self.assertRaisesRegex(SystemExit, "forced verifier failure"),
            ):
                builder.main(
                    [
                        "--release",
                        "r3",
                        "--output-dir",
                        str(base / "out"),
                        "--published-at",
                        "2026-09-04T15:00:00Z",
                        "--write-contract",
                    ]
                )
            self.assertEqual((job / "TASK.json").read_bytes(), task_before)
            self.assertEqual((job / "MANIFEST.json").read_bytes(), manifest_before)

    def test_root_verifier_rejects_manifest_release_tag_mismatch_early(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            base = Path(raw)
            checkout, job = self.make_checkout(base)
            self.build(checkout, job, base / "out")
            manifest_path = job / "MANIFEST.json"
            manifest = json.loads(manifest_path.read_text())
            manifest["releaseTag"] = "wrong-r3"
            manifest_path.write_bytes(builder.json_bytes(manifest))
            task_path = job / "TASK.json"
            task = json.loads(task_path.read_text())
            task["artifact"]["payloadManifestSha256"] = hashlib.sha256(manifest_path.read_bytes()).hexdigest()
            write_json(task_path, task)
            with self.assertRaisesRegex(AssertionError, "payload manifest releaseTag mismatch"):
                verify_bridge.check_task(task_path)


if __name__ == "__main__":
    unittest.main()
