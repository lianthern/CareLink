#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "product/unseen_local_product.py"
SPEC = importlib.util.spec_from_file_location("unseen_local_product", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(MODULE)
# Explicit Mac-only boundary: the handoff interpreter has no third-party
# packages. Dedicated tests below exercise the production fail-closed loader;
# ordinary state-machine tests inject a visible in-process validator hook.
MODULE._SCHEMA_VALIDATOR_FOR_TESTS = lambda _value, _schema_name: None
FAKE_RUNNER = ROOT / "product/fake_runner.py"


def fake_mp4() -> bytes:
    return (24).to_bytes(4, "big") + b"ftyp" + b"isom" + b"\x00" * 12 + b"payload"


def fake_jpeg() -> bytes:
    return b"\xff\xd8\xff\xe0" + b"photo-payload"


def video_probe() -> dict:
    return {"streams": [{"codec_type": "video", "width": 4000, "height": 2000}], "format": {"duration": "75"},
            "normalizedWidth": 4000, "normalizedHeight": 2000, "normalizedDurationSeconds": 75.0}


def photo_probe() -> dict:
    return {"streams": [{"codec_type": "video", "width": 1920, "height": 1080}], "format": {},
            "normalizedWidth": 1920, "normalizedHeight": 1080}


class ProductTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(); self.root = Path(self.temporary.name) / "product"
        self.store = MODULE.Store(self.root)
        self.server = MODULE.ProductServer(("127.0.0.1", 0), self.store, "test-token", 1024*1024, 1024*1024)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True); self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(5); self.temporary.cleanup()

    def request(self, path, method="GET", data=None, token=True, headers=None):
        request_headers = {"X-UNSEEN-CSRF": "test-token"} if token else {}
        request_headers.update(headers or {})
        return urllib.request.urlopen(urllib.request.Request(self.base+path, data=data, headers=request_headers, method=method), timeout=5)

    def set_scene_result(self, scene_id, result):
        with self.store.connect() as db:
            db.execute("UPDATE scenes SET result_json=? WHERE id=?", (json.dumps(result), scene_id))

    @mock.patch.object(MODULE, "ffprobe")
    def test_full_fake_scene_and_photo_flow(self, probe):
        probe.return_value = video_probe()
        with self.request("/api/scenes?filename=Room%20360.MP4", "PUT", fake_mp4()) as response:
            scene = json.load(response)["scene"]
        self.assertEqual(scene["state"], "uploaded"); self.assertEqual(scene["width"], 4000)
        with self.request(f"/api/scenes/{scene['id']}/start", "POST", b"") as response:
            first = json.load(response)["job"]
        with self.request(f"/api/scenes/{scene['id']}/start", "POST", b"") as response:
            second = json.load(response)["job"]
        self.assertEqual(first["id"], second["id"])
        MODULE.run_worker(self.store, FAKE_RUNNER, True, 30, .01)
        ready_scene = self.store.get_scene(scene["id"])
        self.assertEqual(ready_scene["state"], "ready")
        with self.request("/api/status") as response:
            product_status = json.load(response)
        self.assertEqual(product_status["worker"]["state"], "stopped")
        self.assertFalse(product_status["worker"]["alive"])
        sog_path = Path(ready_scene["result"]["viewerRoot"]) / "assets/scene.sog"
        ready_scene["result"]["sogPath"] = str(sog_path)
        self.set_scene_result(scene["id"], ready_scene["result"])
        with self.request(f"/view/{scene['id']}/") as response:
            self.assertIn(b"fake viewer", response.read())
        with self.request(f"/view/{scene['id']}/assets/scene.sog") as response:
            self.assertEqual(response.read(), b"fake-sog")
            self.assertEqual(response.headers["Accept-Ranges"], "bytes")
        with self.request(f"/view/{scene['id']}/assets/scene.sog", headers={"Range": "bytes=2-5"}) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers["Content-Range"], "bytes 2-5/8")
            self.assertEqual(response.read(), b"ke-s")
        with self.request(f"/view/{scene['id']}/assets/scene.sog", method="HEAD") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Content-Length"], "8")
            self.assertEqual(response.read(), b"")
        with self.request(f"/download/{scene['id']}/scene.sog") as response:
            self.assertEqual(response.read(), b"fake-sog")
            self.assertIn("attachment", response.headers["Content-Disposition"])
            self.assertIn(scene["revision_id"], response.headers["Content-Disposition"])
        with self.request(f"/download/{scene['id']}/scene.sog", method="HEAD", headers={"Range": "bytes=-3"}) as response:
            self.assertEqual(response.status, 206)
            self.assertEqual(response.headers["Content-Range"], "bytes 5-7/8")
            self.assertEqual(response.read(), b"")

        probe.return_value = photo_probe()
        with self.request(f"/api/scenes/{scene['id']}/photos?filename=new.jpg", "PUT", fake_jpeg()) as response:
            photo_job = json.load(response)["job"]
        MODULE.run_worker(self.store, FAKE_RUNNER, True, 30, .01)
        self.assertEqual(self.store.get_job(photo_job["id"])["state"], "ready")

    @mock.patch.object(MODULE, "ffprobe")
    def test_invalid_or_multiple_range_returns_416(self, probe):
        probe.return_value = video_probe()
        with self.request("/api/scenes?filename=room.mp4", "PUT", fake_mp4()) as response:
            scene = json.load(response)["scene"]
        self.store.queue("scene_preview", scene["id"], Path(scene["source_path"]), scene["source_sha256"])
        MODULE.run_worker(self.store, FAKE_RUNNER, True, 30, .01)
        for value in ("bytes=99-100", "bytes=0-1,4-5", "items=0-1", "bytes=-0"):
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(f"/view/{scene['id']}/assets/scene.sog", headers={"Range": value})
            self.assertEqual(error.exception.code, 416)
            self.assertEqual(error.exception.headers["Content-Range"], "bytes */8")
            error.exception.close()

    @mock.patch.object(MODULE, "ffprobe")
    def test_sog_download_is_limited_to_ready_scene_result(self, probe):
        probe.return_value = video_probe()
        with self.request("/api/scenes?filename=room.mp4", "PUT", fake_mp4()) as response:
            scene = json.load(response)["scene"]
        self.store.queue("scene_preview", scene["id"], Path(scene["source_path"]), scene["source_sha256"])
        MODULE.run_worker(self.store, FAKE_RUNNER, True, 30, .01)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(f"/download/{scene['id']}/scene.sog")
        self.assertEqual(error.exception.code, 409); error.exception.close()
        result = self.store.get_scene(scene["id"])["result"]
        result["sogPath"] = str(self.store.db_path)
        self.set_scene_result(scene["id"], result)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(f"/download/{scene['id']}/scene.sog")
        self.assertEqual(error.exception.code, 409); error.exception.close()

    def test_page_exposes_sog_and_multi_photo_result_controls(self):
        page = MODULE.render_page("token", 123, 45).decode()
        self.assertIn("下载 scene.sog", page)
        self.assertIn("照片回位结果", page)
        self.assertIn("watchedPhotoJobId", page)
        self.assertIn("/anchor/", page)
        self.assertIn("job.state==='failed'", page)
        self.assertIn("attempt ${j.attempts}/${j.max_attempts}", page)
        self.assertIn("当前阶段/训练 step", page)
        self.assertIn("GPU Worker", page)

    def test_start_script_waits_for_api_confirmed_worker_health(self):
        script = (ROOT / "scripts/linux/start-local-product.sh").read_text(encoding="utf-8")
        self.assertIn('url + "api/status"', script)
        self.assertIn('worker["alive"] is True', script)
        self.assertIn('worker["state"] in {"idle", "running"}', script)
        self.assertIn('int(worker["pid"]) == int(sys.argv[3])', script)
        self.assertIn('worker["heartbeatAgeSeconds"]', script)
        self.assertIn('tail -n 80 "$data_root/reports/worker.log"', script)
        self.assertIn('state["appSha256"] == sys.argv[4]', script)
        self.assertIn('worker["runnerSha256"] == sys.argv[5]', script)
        self.assertIn('server_health_matches_current_code', script)
        self.assertIn('Stopped mixed-version local processes; queue, media and checkpoints were preserved.', script)

    def test_runtime_states_and_health_bind_launch_time_code_sha256(self):
        expected_app_sha = MODULE.sha256_file(SCRIPT)
        expected_runner_sha = MODULE.sha256_file(FAKE_RUNNER)
        self.assertEqual(MODULE.run_worker(self.store, FAKE_RUNNER, True, 30, .01), 0)
        worker_state = json.loads(
            (self.store.reports_root / "worker-state.json").read_text(encoding="utf-8")
        )
        self.assertEqual(worker_state["appSha256"], expected_app_sha)
        self.assertEqual(worker_state["runnerSha256"], expected_runner_sha)

        with self.request("/api/health") as response:
            health = json.load(response)
        self.assertEqual(health["server"]["appSha256"], expected_app_sha)
        self.assertEqual(health["server"]["pid"], os.getpid())

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "standalone-product"
            # The standalone process deliberately fails closed when ffprobe is
            # missing.  Give this fingerprint-only test a private executable so
            # it does not depend on the GitHub runner's system packages.
            fake_bin = Path(temporary) / "bin"
            fake_bin.mkdir()
            fake_ffprobe = fake_bin / "ffprobe"
            fake_ffprobe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            fake_ffprobe.chmod(0o700)
            child_env = os.environ.copy()
            child_env["PATH"] = str(fake_bin) + os.pathsep + child_env.get("PATH", "")
            process = subprocess.Popen(
                [sys.executable, str(SCRIPT), "--root", str(root), "server", "--port", "0"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=child_env,
            )
            try:
                state_path = root / "reports/server-state.json"
                deadline = time.time() + 5
                while not state_path.is_file() and process.poll() is None and time.time() < deadline:
                    time.sleep(.02)
                if process.poll() is not None:
                    output, _ = process.communicate(timeout=2)
                    self.fail(f"standalone server exited before writing its state:\n{output}")
                state = json.loads(state_path.read_text(encoding="utf-8"))
                self.assertEqual(state["pid"], process.pid)
                self.assertEqual(state["appSha256"], expected_app_sha)
                with urllib.request.urlopen(state["url"] + "api/health", timeout=2) as response:
                    standalone_health = json.load(response)
                self.assertEqual(standalone_health["server"], {
                    "pid": process.pid,
                    "appSha256": expected_app_sha,
                })
            finally:
                if process.poll() is None:
                    process.terminate()
                process.wait(timeout=5)

    def test_health_fingerprint_probe_is_read_only(self):
        media = self.root / "health.mp4"
        media.write_bytes(fake_mp4())
        scene = self.store.add_scene(
            display_name="health.mp4",
            path=media,
            digest=MODULE.sha256_file(media),
            size=media.stat().st_size,
            probe=video_probe(),
        )
        job = self.store.queue("scene_preview", scene["id"], media, MODULE.sha256_file(media))
        self.store.lease_next("health-test-worker", 30)
        with self.store.connect() as db:
            db.execute("UPDATE jobs SET lease_expires=? WHERE id=?", (time.time() - 1, job["id"]))

        with self.request("/api/health") as response:
            health = json.load(response)
        self.assertEqual(health["status"], "ready")
        self.assertNotIn("jobs", health)
        self.assertEqual(self.store.get_job(job["id"])["state"], "leased")

        with self.request("/api/status") as response:
            status = json.load(response)
        recovered = next(row for row in status["jobs"] if row["id"] == job["id"])
        self.assertEqual(recovered["state"], "queued")

    def test_installer_verifies_payload_before_any_install_write(self):
        installer = (ROOT / "scripts/linux/install-local-product.sh").read_text(encoding="utf-8")
        verifier_call = installer.index("inputs/scripts/linux/verify_release_payload.py")
        first_mutation = min(
            installer.index("\numask 077"),
            installer.index("\nmkdir -p"),
            installer.index("\ninstall -m"),
        )
        self.assertLess(verifier_call, first_mutation)
        self.assertIn('PYTHONDONTWRITEBYTECODE=1 "$verification_python" -B', installer)
        self.assertIn('--bridge-receipt "$bridge_receipt"', installer)
        self.assertIn('"$script_dir/verify_release_payload.py"', installer)
        self.assertIn('verify_release_payload.py; do', installer)

        doctor = (ROOT / "scripts/linux/doctor-local-product.sh").read_text(encoding="utf-8")
        self.assertIn('app_sha256=$(sha256sum -- "$app_path"', doctor)
        self.assertIn('runner_sha256=$(sha256sum -- "$runner_path"', doctor)
        self.assertIn('url + "api/health"', doctor)
        self.assertIn('worker.get("runnerSha256") != runner_sha256', doctor)

    def test_worker_rejects_result_identity_mismatches_before_ready(self):
        job = {"kind": "scene_preview", "input_sha256": "a" * 64}
        scene = {"revision_id": "scene-one-r001"}
        good = {
            "status": "ready",
            "kind": "scene_preview",
            "inputSha256": "a" * 64,
            "sceneRevisionId": "scene-one-r001",
        }
        self.assertIs(MODULE.validate_runner_result(good, job, scene), good)
        for key in ("status", "kind", "inputSha256", "sceneRevisionId"):
            bad = dict(good)
            bad[key] = "wrong"
            with self.assertRaisesRegex(RuntimeError, "runner result contract mismatch"):
                MODULE.validate_runner_result(bad, job, scene)

    @mock.patch.object(MODULE, "ffprobe")
    def test_each_photo_anchor_has_an_independent_viewer_entry(self, probe):
        probe.return_value = video_probe()
        with self.request("/api/scenes?filename=room.mp4", "PUT", fake_mp4()) as response:
            scene = json.load(response)["scene"]
        self.store.queue("scene_preview", scene["id"], Path(scene["source_path"]), scene["source_sha256"])
        MODULE.run_worker(self.store, FAKE_RUNNER, True, 30, .01)
        result = self.store.get_scene(scene["id"])["result"]
        manifest_path = Path(result["viewerRoot"]) / "scene.json"
        anchors = [
            {"id": "photo-first", "label": "First", "sceneRevisionId": scene["revision_id"], "position": [1, 2, 3], "quaternion": [0, 0, 0, 1], "fov": 60},
            {"id": "photo-second", "label": "Second", "sceneRevisionId": scene["revision_id"], "position": [4, 5, 6], "quaternion": [0, 0, 0, 1], "fov": 70},
        ]
        manifest_path.write_text(json.dumps({"photoAnchors": anchors, "defaultPhotoAnchorId": "photo-second"}), encoding="utf-8")
        for anchor in anchors:
            with self.request(f"/view/{scene['id']}/anchor/{anchor['id']}/") as response:
                self.assertIn(b"fake viewer", response.read())
            with self.request(f"/view/{scene['id']}/anchor/{anchor['id']}/scene.json") as response:
                selected = json.load(response)
            self.assertEqual(selected["photoAnchors"][0]["id"], anchor["id"])
            self.assertEqual(selected["defaultPhotoAnchorId"], anchor["id"])
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(f"/view/{scene['id']}/anchor/missing/")
        self.assertEqual(error.exception.code, 404); error.exception.close()

    @mock.patch.object(MODULE, "ffprobe")
    def test_duplicate_video_upload_reuses_scene_revision(self, probe):
        probe.return_value = video_probe()
        with self.request("/api/scenes?filename=first.mp4", "PUT", fake_mp4()) as response:
            first = json.load(response)["scene"]
        with self.request("/api/scenes?filename=second.mp4", "PUT", fake_mp4()) as response:
            second = json.load(response)["scene"]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(len(self.store.list_scenes()), 1)

    @mock.patch.object(MODULE, "ffprobe")
    def test_viewer_rejects_traversal_and_unready_scene(self, probe):
        probe.return_value = video_probe()
        with self.request("/api/scenes?filename=room.mp4", "PUT", fake_mp4()) as response:
            scene = json.load(response)["scene"]
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(f"/view/{scene['id']}/")
        self.assertEqual(error.exception.code, 409); error.exception.close()
        self.store.queue("scene_preview", scene["id"], Path(scene["source_path"]), scene["source_sha256"])
        MODULE.run_worker(self.store, FAKE_RUNNER, True, 30, .01)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(f"/view/{scene['id']}/..%2F..%2Fstate%2Fproduct.sqlite3")
        self.assertEqual(error.exception.code, 404); error.exception.close()

    @mock.patch.object(MODULE, "ffprobe")
    def test_non_2_to_1_video_is_rejected(self, probe):
        value = video_probe(); value["normalizedWidth"] = 1920; value["normalizedHeight"] = 1080; probe.return_value = value
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/scenes?filename=flat.mp4", "PUT", fake_mp4())
        self.assertEqual(error.exception.code, 422); error.exception.close()

    def test_security_boundaries(self):
        with self.assertRaises(ValueError): MODULE.validate_loopback_host("0.0.0.0")
        with self.assertRaises(ValueError): MODULE.validate_ext4_root(Path("/mnt/c/Users/Max/product"))
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/scenes?filename=x.mp4", "PUT", fake_mp4(), token=False)
        self.assertEqual(error.exception.code, 403); error.exception.close()

    def test_runtime_schema_dependency_is_fail_closed(self):
        with mock.patch.object(MODULE, "_SCHEMA_VALIDATOR_FOR_TESTS", None), \
             mock.patch.dict(MODULE._SCHEMA_VALIDATORS, {}, clear=True), \
             mock.patch.dict(sys.modules, {"jsonschema": None}):
            with self.assertRaisesRegex(RuntimeError, "jsonschema 4.26.0 is required"):
                MODULE.validate_json_contract({}, "job.schema.json")
        with mock.patch.object(MODULE, "_SCHEMA_VALIDATOR_FOR_TESTS", None), \
             mock.patch.dict(MODULE._SCHEMA_VALIDATORS, {}, clear=True), \
             mock.patch.dict(sys.modules, {"jsonschema": mock.Mock()}), \
             mock.patch.object(MODULE.importlib.metadata, "version", return_value="4.25.1"):
            with self.assertRaisesRegex(RuntimeError, "required; found 4.25.1"):
                MODULE.validate_json_contract({}, "job.schema.json")

    def test_worker_validates_queue_job_spec_and_result_contracts(self):
        media = self.root / "contract.mp4"; media.write_bytes(fake_mp4())
        scene = self.store.add_scene(
            display_name="contract.mp4", path=media, digest=MODULE.sha256_file(media),
            size=media.stat().st_size, probe=video_probe(),
        )
        observed = []

        def record_contract(_value, schema_name):
            observed.append(schema_name)

        with mock.patch.object(MODULE, "_SCHEMA_VALIDATOR_FOR_TESTS", record_contract):
            self.store.queue("scene_preview", scene["id"], media, MODULE.sha256_file(media))
            MODULE.run_worker(self.store, FAKE_RUNNER, True, 30, .01)
        self.assertIn("queue-state.schema.json", observed)
        self.assertIn("job.schema.json", observed)
        self.assertIn("result.schema.json", observed)

    def test_packaged_schema_contracts_are_strict_and_installed(self):
        schemas = ROOT / "schemas"
        job_schema = json.loads((schemas / "job.schema.json").read_text(encoding="utf-8"))
        queue_schema = json.loads((schemas / "queue-state.schema.json").read_text(encoding="utf-8"))
        result_schema = json.loads((schemas / "result.schema.json").read_text(encoding="utf-8"))
        self.assertFalse(job_schema["additionalProperties"])
        self.assertFalse(queue_schema["additionalProperties"])
        self.assertFalse(result_schema["additionalProperties"])
        registration = result_schema["$defs"]["registrationQuality"]
        for name in (
            "referenceFramesInIsolatedDatabase", "localDatabaseIsolation",
            "colmapGpuRequested", "registrationImageList",
        ):
            self.assertIn(name, registration["required"])
        installer = (ROOT / "scripts/linux/install-local-product.sh").read_text(encoding="utf-8")
        for name in ("job.schema.json", "result.schema.json", "queue-state.schema.json"):
            self.assertIn(name, installer)
        canary = (ROOT / "scripts/linux/run-v15-integration-canary.sh").read_text(encoding="utf-8")
        for name in ("schemas/job.schema.json", "schemas/result.schema.json", "schemas/queue-state.schema.json"):
            self.assertIn(name, canary)
        doctor = (ROOT / "scripts/linux/doctor-local-product.sh").read_text(encoding="utf-8")
        self.assertIn('"jsonschema": "4.26.0"', doctor)
        dry_run = (ROOT / "scripts/linux/dry-run-local-product.sh").read_text(encoding="utf-8")
        self.assertIn('"jobId": "job-deadbeef0001"', dry_run)
        self.assertIn('"source_sha256": digest', dry_run)
        self.assertIn('"state": "queued"', dry_run)
        self.assertIn('"$runtime_python" "$runner"', dry_run)

    def test_expired_lease_is_requeued_and_single_flight(self):
        media = self.root / "source.mp4"; media.write_bytes(fake_mp4())
        scene = self.store.add_scene(display_name="x.mp4", path=media, digest=MODULE.sha256_file(media), size=media.stat().st_size, probe=video_probe())
        job = self.store.queue("scene_preview", scene["id"], media, MODULE.sha256_file(media))
        leased = self.store.lease_next("worker-a", 30); self.assertEqual(leased["id"], job["id"])
        self.assertIsNone(self.store.lease_next("worker-b", 30))
        with self.store.connect() as db: db.execute("UPDATE jobs SET lease_expires=? WHERE id=?", (time.time()-1, job["id"]))
        self.assertEqual(self.store.recover_expired(), 1)
        self.assertEqual(self.store.lease_next("worker-b", 30)["id"], job["id"])

    def test_third_expired_scene_lease_fails_job_and_scene_together(self):
        media = self.root / "exhausted.mp4"; media.write_bytes(fake_mp4())
        scene = self.store.add_scene(display_name="exhausted.mp4", path=media, digest=MODULE.sha256_file(media), size=media.stat().st_size, probe=video_probe())
        job = self.store.queue("scene_preview", scene["id"], media, MODULE.sha256_file(media))
        for attempt in range(1, 4):
            leased = self.store.lease_next(f"worker-{attempt}", 30)
            self.assertEqual(leased["id"], job["id"])
            with self.store.connect() as db:
                db.execute("UPDATE jobs SET lease_expires=? WHERE id=?", (time.time()-1, job["id"]))
            self.assertEqual(self.store.recover_expired(), 1)
            expected = "queued" if attempt < 3 else "failed"
            self.assertEqual(self.store.get_job(job["id"])["state"], expected)
            self.assertEqual(self.store.get_scene(scene["id"])["state"], expected)

    def test_explicit_failed_scene_retry_restores_scene_to_queued(self):
        media = self.root / "retry.mp4"; media.write_bytes(fake_mp4())
        scene = self.store.add_scene(display_name="retry.mp4", path=media, digest=MODULE.sha256_file(media), size=media.stat().st_size, probe=video_probe())
        job = self.store.queue("scene_preview", scene["id"], media, MODULE.sha256_file(media))
        leased = self.store.lease_next("worker-a", 30)
        self.store.transition(leased["id"], "worker-a", "failed", "failed", 1.0, error="synthetic failure")
        self.assertEqual(self.store.get_scene(scene["id"])["state"], "failed")
        retried = self.store.queue("scene_preview", scene["id"], media, MODULE.sha256_file(media))
        self.assertEqual(retried["id"], job["id"])
        self.assertEqual(retried["state"], "queued")
        self.assertEqual(self.store.get_scene(scene["id"])["state"], "queued")

    def test_failed_photo_can_be_retried_from_http_ui_contract(self):
        media = self.root / "scene.mp4"; media.write_bytes(fake_mp4())
        scene = self.store.add_scene(display_name="scene.mp4", path=media, digest=MODULE.sha256_file(media), size=media.stat().st_size, probe=video_probe())
        photo = self.root / "photo.jpg"; photo.write_bytes(fake_jpeg())
        job = self.store.queue("photo_localize", scene["id"], photo, MODULE.sha256_file(photo))
        leased = self.store.lease_next("worker-a", 30)
        self.store.transition(leased["id"], "worker-a", "failed", "failed", 1.0, error="synthetic failure")
        with self.request(f"/api/jobs/{job['id']}/retry", "POST", b"") as response:
            retried = json.load(response)["job"]
        self.assertEqual(retried["id"], job["id"])
        self.assertEqual(retried["state"], "queued")

    def test_heartbeat_failure_terminates_active_runner_group(self):
        media = self.root / "lease-loss.mp4"; media.write_bytes(fake_mp4())
        scene = self.store.add_scene(display_name="lease-loss.mp4", path=media, digest=MODULE.sha256_file(media), size=media.stat().st_size, probe=video_probe())
        job = self.store.queue("scene_preview", scene["id"], media, MODULE.sha256_file(media))
        runner = self.root / "blocking_runner.py"
        runner.write_text("""#!/usr/bin/env python3
import argparse, json, os, signal, subprocess, sys, time
from pathlib import Path
parser=argparse.ArgumentParser(); parser.add_argument('--job-spec',type=Path,required=True); args=parser.parse_args()
spec=json.loads(args.job_spec.read_text()); work=Path(spec['workDir']); started=work/'runner-started'; terminated=work/'runner-terminated'
child_code="import signal,sys,time\\nfrom pathlib import Path\\nwork=Path(sys.argv[1])\\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\\nwork.joinpath('grandchild-started').write_text('started')\\nwhile True: time.sleep(.05)"
subprocess.Popen([sys.executable,'-c',child_code,str(work)])
while not work.joinpath('grandchild-started').is_file(): time.sleep(.01)
def stop(_signum,_frame):
    terminated.write_text('terminated\\n')
    raise SystemExit(143)
signal.signal(signal.SIGTERM,stop); work.joinpath('runner-pgid').write_text(str(os.getpgrp())); started.write_text('started\\n')
while True: time.sleep(.05)
""", encoding="utf-8")
        runner.chmod(0o700)
        marker = self.store.work_root / job["id"] / "runner-started"
        original_heartbeat = self.store.heartbeat
        worker_group_seen = []

        def lose_lease_after_start(*args, **kwargs):
            if marker.is_file():
                state = json.loads((self.store.reports_root / "worker-state.json").read_text(encoding="utf-8"))
                worker_group_seen.append(state.get("runnerPgid"))
                raise RuntimeError("synthetic heartbeat/lease loss")
            return original_heartbeat(*args, **kwargs)

        with mock.patch.object(self.store, "heartbeat", side_effect=lose_lease_after_start):
            self.assertEqual(MODULE.run_worker(self.store, runner, True, 30, .02), 0)
        terminated = marker.with_name("runner-terminated")
        deadline = time.time() + 2
        while not terminated.is_file() and time.time() < deadline:
            time.sleep(.02)
        self.assertTrue(terminated.is_file(), "runner did not receive group termination")
        pgid = int(marker.with_name("runner-pgid").read_text(encoding="utf-8"))
        deadline = time.time() + 3
        while MODULE.process_group_active(pgid) and time.time() < deadline:
            time.sleep(.02)
        self.assertFalse(MODULE.process_group_active(pgid), "SIGTERM-ignoring runner child escaped group cleanup")
        deadline = time.time() + 3
        while MODULE.process_group_members(pgid) and time.time() < deadline:
            time.sleep(.02)
        self.assertEqual(MODULE.process_group_members(pgid), {}, "runner PGID was not fully reaped")
        self.assertIn(pgid, worker_group_seen, "worker-state did not expose the active runner PGID")
        self.assertEqual(self.store.get_job(job["id"])["state"], "failed")


if __name__ == "__main__": unittest.main()
