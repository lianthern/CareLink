#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/local_video_intake.py"
SPEC = importlib.util.spec_from_file_location("local_video_intake", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fake_mp4() -> bytes:
    return (24).to_bytes(4, "big") + b"ftyp" + b"isom" + b"\x00" * 12 + b"payload"


class IntakeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "intake"
        self.server = MODULE.IntakeHTTPServer(
            ("127.0.0.1", 0),
            intake_root=self.root,
            csrf_token="unit-test-token",
            max_bytes=1024 * 1024,
            min_duration_seconds=3,
            max_duration_seconds=600,
        )
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.temporary.cleanup()

    def request(self, path: str, *, data: bytes | None = None, token: str | None = None):
        headers = {}
        if token is not None:
            headers["X-UNSEEN-CSRF"] = token
        request = urllib.request.Request(
            self.base + path,
            data=data,
            headers=headers,
            method="PUT" if data is not None else "GET",
        )
        return urllib.request.urlopen(request, timeout=5)

    def test_health_is_loopback_and_no_autostart(self) -> None:
        with self.request("/api/health") as response:
            payload = json.load(response)
        self.assertEqual(payload["bindAddress"], "127.0.0.1")
        self.assertFalse(payload["trainingStartsAutomatically"])

    @mock.patch.object(MODULE, "ffprobe_video")
    def test_streamed_upload_creates_private_local_job(self, probe: mock.Mock) -> None:
        probe.return_value = {
            "format": {"duration": "75.25", "format_name": "mov,mp4"},
            "streams": [{"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080}],
            "normalizedDurationSeconds": 75.25,
        }
        with self.request(
            "/api/upload?filename=My%20Classroom.MP4",
            data=fake_mp4(),
            token="unit-test-token",
        ) as response:
            self.assertEqual(response.status, 201)
            payload = json.load(response)
        job_dir = self.root / payload["jobId"]
        metadata = json.loads((job_dir / "intake.json").read_text(encoding="utf-8"))
        self.assertTrue((job_dir / "source.mp4").is_file())
        self.assertEqual(metadata["status"], "UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW")
        self.assertFalse(metadata["policy"]["trainingStartsAutomatically"])
        self.assertFalse(metadata["policy"]["githubUploadAllowed"])
        self.assertEqual(metadata["source"]["localDisplayName"], "My-Classroom.mp4")

    def test_csrf_is_required(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.request("/api/upload?filename=room.mp4", data=fake_mp4())
        try:
            self.assertEqual(raised.exception.code, 403)
        finally:
            raised.exception.close()
        self.assertFalse(self.root.exists())

    def test_extension_is_rejected_before_write(self) -> None:
        with self.assertRaises(urllib.error.HTTPError) as raised:
            self.request(
                "/api/upload?filename=room.exe",
                data=fake_mp4(),
                token="unit-test-token",
            )
        try:
            self.assertEqual(raised.exception.code, 415)
        finally:
            raised.exception.close()
        self.assertFalse(self.root.exists())

    def test_public_bind_and_windows_mount_are_refused(self) -> None:
        with self.assertRaises(ValueError):
            MODULE.validate_loopback_host("0.0.0.0")
        with self.assertRaises(ValueError):
            MODULE.validate_ext4_destination(Path("/mnt/c/Users/Max/video"))


if __name__ == "__main__":
    unittest.main()
