import importlib.util
import json
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock


INPUTS = Path(__file__).resolve().parents[1]
MODULE_PATH = INPUTS / "scripts/linux/run_v15_full_canary.py"
SPEC = importlib.util.spec_from_file_location("run_v15_full_canary", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)
DOWNLOADER_PATH = INPUTS / "scripts/linux/download_360roam_fixture.py"
DOWNLOADER_SPEC = importlib.util.spec_from_file_location("download_360roam_fixture", DOWNLOADER_PATH)
DOWNLOADER = importlib.util.module_from_spec(DOWNLOADER_SPEC)
assert DOWNLOADER_SPEC and DOWNLOADER_SPEC.loader
DOWNLOADER_SPEC.loader.exec_module(DOWNLOADER)


class FullCanaryEvidenceTests(unittest.TestCase):
    def test_selects_three_spatially_distinct_held_out_photos(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            held = root / "scenes/example/projected/held-out"
            held.mkdir(parents=True)
            paths = []
            for index in (13, 26, 39):
                for direction in ("front", "right", "back"):
                    path = held / f"t{index:04d}_{direction}.jpg"
                    path.write_bytes(b"jpeg")
                    paths.append(str(path))
            manifest = root / "held-out.json"
            manifest.write_text(
                json.dumps({"heldOutViews": 27, "usedForTraining": False, "heldOutPaths": paths}),
                encoding="utf-8",
            )
            selected = MODULE.choose_held_out_photos(manifest, root)
            self.assertEqual([path.name for path in selected], ["t0013_front.jpg", "t0026_right.jpg", "t0039_back.jpg"])

    def test_held_out_path_must_remain_in_product_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            root = base / "product"
            root.mkdir()
            outside = base / "outside-heldout.jpg"
            outside.write_bytes(b"jpeg")
            manifest = root / "held-out.json"
            manifest.write_text(
                json.dumps({"heldOutViews": 27, "usedForTraining": False, "heldOutPaths": [str(outside)]}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "escaped WSL product root"):
                MODULE.choose_held_out_photos(manifest, root)

    def test_photo_quality_gate_fails_closed(self):
        good = {
            "groundTruthRead": False,
            "hardcodedPoseUsed": False,
            "registrationQuality": {
                "geometricInliers": 20,
                "geometricInlierRatio": 0.10,
                "medianReprojectionPx": 3.5,
                "gatePassed": True,
                "existingFramesFixed": True,
                "inlierRatioDefinition": "registered-3d-observations/query-keypoints",
            },
        }
        MODULE.require_photo_metrics(good)
        for key, value in (("geometricInliers", 19), ("geometricInlierRatio", 0.09), ("medianReprojectionPx", 3.51)):
            bad = json.loads(json.dumps(good))
            bad["registrationQuality"][key] = value
            with self.assertRaisesRegex(RuntimeError, "photo registration gate failed"):
                MODULE.require_photo_metrics(bad)

    def test_report_excludes_local_artifact_paths(self):
        result = {
            "canaryRunId": "run-0123456789abcdef",
            "state": "RUNNING_PENDING_4060_AGENT_VISUAL",
            "overallProductGoal": "ACTIVE",
            "release": {
                "releaseTag": "v15-r3",
                "assetName": "payload.tar.gz",
                "assetSha256": "e" * 64,
                "assetBytes": 1234,
                "controlCommit": "f" * 40,
                "payloadManifestSha256": "8" * 64,
                "payloadFileCount": 42,
                "runtimeFingerprintSha256": "9" * 64,
            },
            "gpu": {},
            "input": {"bytes": 123, "sha256": "a" * 64},
            "scene": {
                "sceneRevisionId": "scene-r001",
                "registeredViews": 300,
                "registeredDirections": ["front", "right"],
                "registeredTimeIndices": 40,
                "colmapModelCounts": {"0": 300},
                "trainingIterations": 7000,
                "trainingResumedFromStep": None,
                "trainingLastAttemptWallSeconds": None,
                "trainingLastAttemptPeakVramMiB": None,
                "oom": False,
                "checkpointBytes": 321,
                "checkpointSha256": "d" * 64,
                "plyBytes": 456,
                "plySha256": "b" * 64,
                "sogBytes": 789,
                "sogSha256": "c" * 64,
                "duplicateUploadReturnedSameSceneId": True,
                "duplicateStartReturnedSameJobId": True,
            },
            "viewerHttp": {"rangeHttpStatus": 206},
            "photoAnchorHttp": {"verifiedAnchors": 3, "rows": []},
            "viewerVisual": {"state": "PENDING"},
            "photoLocalizations": [],
            "workerRecovery": {"state": "PASS"},
            "security": {
                "listener": {"state": "PASS_LOOPBACK_ONLY", "port": 8780, "addresses": ["127.0.0.1"]},
                "bridgeFilesWritten": ["V15-RESULT.json", "V15-REPORT.md"],
                "reportBoundaryValidated": True,
            },
        }
        report = MODULE.render_report(result)
        MODULE.assert_safe_report_payload(report)
        self.assertNotIn("/home/", report)
        self.assertNotIn("/mnt/", report)
        self.assertNotIn("scene.sog", report)

    def test_scene_gate_requires_checkpoint_evidence(self):
        good = {
            "registeredViews": 300,
            "registeredDirections": ["front", "right", "back", "left", "up", "front_right"],
            "registeredTimeIndices": 40,
            "trainingIterations": 7000,
            "oom": False,
            "checkpointBytes": 100,
            "checkpointSha256": "a" * 64,
            "plyBytes": 100,
            "plySha256": "b" * 64,
            "sogBytes": 100,
            "sogSha256": "c" * 64,
        }
        MODULE.require_scene_metrics(good)
        for key in ("checkpointBytes", "checkpointSha256"):
            bad = dict(good); bad.pop(key)
            with self.assertRaisesRegex(RuntimeError, "checkpoint"):
                MODULE.require_scene_metrics(bad)

    def test_gpu_gate_requires_real_4060_and_torch_cuda(self):
        good = {
            "name": "NVIDIA GeForce RTX 4060 Laptop GPU",
            "driver": "555.99",
            "memoryMiB": 8188,
            "torch": "2.4.0",
            "torchCuda": "12.1",
            "torchCudaAvailable": True,
        }
        MODULE.require_gpu_summary(good)
        for key, value in (("name", "RTX 4090"), ("memoryMiB", 0), ("torchCudaAvailable", False)):
            bad = dict(good)
            bad[key] = value
            with self.assertRaisesRegex(RuntimeError, "4060 CUDA evidence"):
                MODULE.require_gpu_summary(bad)
        for key in ("name", "driver", "torch", "torchCuda"):
            bad = dict(good)
            bad[key] = str(good[key]) + "\nprivate"
            with self.assertRaisesRegex(RuntimeError, "4060 CUDA evidence"):
                MODULE.require_gpu_summary(bad)

    def test_driver_cross_checks_durable_job_and_runner_result_identity(self):
        job = {
            "state": "ready",
            "kind": "scene_preview",
            "input_sha256": "a" * 64,
            "result": {
                "status": "ready",
                "kind": "scene_preview",
                "inputSha256": "a" * 64,
                "sceneRevisionId": "scene-r001",
            },
        }
        self.assertIs(
            MODULE.require_completed_job_identity(job, "scene_preview", "scene-r001"),
            job["result"],
        )
        for key in ("status", "kind", "inputSha256", "sceneRevisionId"):
            bad = json.loads(json.dumps(job))
            bad["result"][key] = "wrong"
            with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                MODULE.require_completed_job_identity(bad, "scene_preview", "scene-r001")

    def test_release_evidence_is_strictly_whitelisted_and_runtime_bound(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "release-evidence.json").write_text(json.dumps({
                "jobId": MODULE.JOB_ID,
                "releaseTag": "v15-r3",
                "assetName": "payload.tar.gz",
                "assetSha256": "a" * 64,
                "assetBytes": 123,
                "controlCommit": "b" * 40,
                "payloadManifestSha256": "d" * 64,
                "payloadFileCount": 42,
                "unexpectedPath": "/home/max/private",
            }), encoding="utf-8")
            safe = MODULE.load_release_evidence(root, "c" * 64)
            self.assertEqual(safe["assetBytes"], 123)
            self.assertEqual(safe["payloadFileCount"], 42)
            self.assertNotIn("unexpectedPath", safe)
            with self.assertRaisesRegex(RuntimeError, "runtime fingerprint"):
                MODULE.load_release_evidence(root, "bad")

    def test_report_whitelist_drops_anchor_paths_and_rejects_nonfinite_pose(self):
        anchor = {
            "id": "photo-abc123",
            "label": "/home/max/private.jpg",
            "sceneRevisionId": "scene-abc-r001",
            "position": [1, 2, 3],
            "quaternion": [0, 0, 0, 1],
            "fov": 70,
            "unexpectedPath": "/mnt/c/private.jpg",
        }
        safe = MODULE.safe_anchor(anchor, "scene-abc-r001")
        self.assertEqual(set(safe), {"id", "sceneRevisionId", "position", "quaternion", "fov"})
        anchor["position"] = [float("nan"), 2, 3]
        with self.assertRaisesRegex(RuntimeError, "finite"):
            MODULE.safe_anchor(anchor, "scene-abc-r001")

    def test_report_boundary_rejects_absolute_paths_and_secret_values(self):
        for leaked in ("artifact=/home/max/private.jpg", "token=" + "ghp_" + "1234567890abcdefghijklmnop"):
            with self.assertRaises(RuntimeError):
                MODULE.assert_safe_report_payload(leaked)

    def test_safe_registration_evidence_is_query_only_path_free_and_cpu_mode_is_allowed(self):
        metrics = {
            "geometricInliers": 30,
            "geometricInlierRatio": 0.2,
            "medianReprojectionPx": 1.5,
            "maxReprojectionPx": 2.0,
            "queryKeypoints": 150,
            "inlierRatioDefinition": "registered-3d-observations/query-keypoints",
            "gatePassed": True,
            "existingFramesFixed": True,
            "registrationImageList": ["query.jpg"],
            "referenceFramesInIsolatedDatabase": 270,
            "referenceFramesCompared": 270,
            "referenceFramesWhitelisted": 270,
            "onlyQueryAdded": True,
            "maxReferenceRotationDelta": 0.0,
            "maxReferencePositionDelta": 0.0,
            "referenceGaugeTolerance": 1e-7,
            "colmapGpuRequested": False,
            "localDatabaseIsolation": {
                "sourceDatabaseCopied": True,
                "sourceDatabaseSha256": "a" * 64,
                "baseReferenceImages": 270,
                "removedNonModelImages": 10,
                "removedOutOfModelPairRows": 20,
                "onlyQueryUnregistered": True,
                "queryDatabaseImageId": 999,
                "databaseImageCountAfterQuery": 271,
            },
            "thresholds": {
                "minGeometricInliers": 20,
                "minGeometricInlierRatio": 0.1,
                "maxMedianReprojectionPx": 3.5,
            },
        }
        safe = MODULE.safe_registration_quality(metrics)
        self.assertEqual(safe["registrationImageList"], ["query.jpg"])
        self.assertEqual(safe["colmapFeatureMode"], "cpu-headless")
        self.assertFalse(safe["colmapGpuRequested"])
        self.assertEqual(safe["localDatabaseIsolation"]["sourceDatabaseSha256"], "a" * 64)
        self.assertEqual(safe["localDatabaseIsolation"]["queryDatabaseImageId"], 999)
        bad = json.loads(json.dumps(metrics))
        bad["registrationImageList"] = ["frame.jpg", "query.jpg"]
        with self.assertRaisesRegex(RuntimeError, "only query"):
            MODULE.safe_registration_quality(bad)

        changed_threshold = json.loads(json.dumps(metrics))
        changed_threshold["thresholds"]["minGeometricInliers"] = 19
        with self.assertRaisesRegex(RuntimeError, "thresholds changed"):
            MODULE.safe_registration_quality(changed_threshold)

    def test_visual_publisher_binds_remote_receipts_and_strips_type_drift(self):
        publisher = (INPUTS / "scripts/windows/Publish-V15-VisualAcceptance.ps1").read_text(encoding="utf-8")
        for fragment in (
            "maxi-max-dev/max-agent-bridge",
            "symbolic-ref --quiet --short HEAD",
            "Get-ReceiptLedger",
            "Assert-TrackedOnOriginMain",
            "Assert-ReceiptHashes",
            "Assert-ExactProperties $result",
            "Assert-StrictBoolean",
            'hash-object "--path=$RelativePath"',
            "Assert-Issue16Open",
            "$httpAnchorIds",
            "$listenerAddresses.Count -ge 1",
            "$safeTechnicalText",
            "sourceDatabaseSha256",
            "queryDatabaseImageId",
            "colmapGpuRequested",
            "report_commit:$jsonCommit",
        ):
            self.assertIn(fragment, publisher)
        self.assertNotRegex(publisher, r"-eq\s+\$(?:true|false)")
        self.assertNotIn("Sort-Object Name", publisher)
        self.assertNotIn("ShouldProcess", publisher)
        allowlist_call = publisher.index("Assert-AllowedWorktree $BridgeCheckout $allowed")
        pull_call = publisher.index("Invoke-Checked { git -C $BridgeCheckout pull --rebase --autostash origin main }")
        self.assertLess(allowlist_call, pull_call)
        ahead_call = publisher.rindex("Publish-AllowedLocalAhead $BridgeCheckout $allowed")
        issue_before_ahead = publisher.rfind("Assert-Issue16Open", 0, ahead_call)
        self.assertGreater(issue_before_ahead, 0)
        self.assertGreaterEqual(publisher.count("Assert-Issue16Open"), 5)

    def test_wrapper_uses_deterministic_lineage_single_flight_and_poc_venv_fallback(self):
        wrapper = (INPUTS / "scripts/linux/run-v15-integration-canary.sh").read_text(encoding="utf-8")
        self.assertIn('source_root="/home/max/src/unseen-3dgs-sceneworker/data/360roam-base-v10/download/panos"', wrapper)
        self.assertIn('--new-run) new_run=yes', wrapper)
        self.assertIn('product_app="$install_root/app/unseen_local_product.py"', wrapper)
        self.assertIn('runner="$install_root/app/pipeline_runner.py"', wrapper)
        self.assertIn('digest.update(b"encoder-contract', wrapper)
        self.assertIn('digest.update(b"runtime-fingerprint', wrapper)
        self.assertIn('"app/verify_release_payload.py"', wrapper)
        self.assertIn('receipt["assetSha256"]', wrapper)
        self.assertNotIn('"release-evidence.json",', wrapper)
        self.assertIn('v15-full-canary.lock', wrapper)
        self.assertIn('flock -n 9', wrapper)
        self.assertIn('elif [[ -x "$poc_root/.venv/bin/python3" ]]', wrapper)
        self.assertIn('--confirm-download-public-fixture)', wrapper)
        self.assertIn('manifest="$install_root/fixtures/360roam/source-manifest.json"', wrapper)
        self.assertNotIn('unseen-3dgs-360roam-posefix-2026-09-04-v11/inputs/source-manifest.json', wrapper)
        self.assertIn('product_root=$(realpath -m -- "$product_root")', wrapper)
        self.assertIn('source_root=$(realpath -m -- "$source_root")', wrapper)
        self.assertNotIn('without-poses-base.mp4', wrapper)
        doctor = (INPUTS / "scripts/linux/doctor-local-product.sh").read_text(encoding="utf-8")
        self.assertIn("nvidia-smi flock", doctor)
        windows_start = (INPUTS / "scripts/windows/Start-UNSEEN-LocalProduct.ps1").read_text(encoding="utf-8")
        self.assertIn('-Filter "ext4.vhdx"', windows_start)
        self.assertIn('$vhdx.Count -ne 1', windows_start)
        self.assertIn('Join-Path $scriptJobRoot "START-HERE.md"', windows_start)
        self.assertIn('Join-Path $scriptJobRoot "inputs"', windows_start)
        self.assertNotIn('Join-Path $scriptJobRoot "TASK.json"', windows_start)
        for field in ("jobId", "releaseTag", "assetName", "assetSha256", "assetBytes", "controlCommit"):
            self.assertIn(f"$receipt.{field}", windows_start)
        self.assertNotIn("$receipt.job ", windows_start)

    def test_packaged_public_fixture_manifest_and_downloader_are_fail_closed(self):
        manifest_path = INPUTS / "fixtures/360roam/source-manifest.json"
        manifest = DOWNLOADER.load_manifest(manifest_path)
        self.assertEqual(len(manifest["files"]), 60)
        with tempfile.TemporaryDirectory() as temporary:
            bad_path = Path(temporary) / "manifest.json"
            bad = json.loads(json.dumps(manifest))
            bad["files"][0]["remotePath"] = "https://evil.example/file.jpg"
            bad_path.write_text(json.dumps(bad), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "remote path"):
                DOWNLOADER.load_manifest(bad_path)

        class Response:
            def geturl(self):
                return "https://evil.example/redirect"

        with self.assertRaisesRegex(RuntimeError, "non-official"):
            DOWNLOADER.require_official_https_response(Response())

    def test_ready_same_lineage_requires_exact_prior_recovery_proof(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "reports/v15-safe/V15-RESULT.json"
            path.parent.mkdir(parents=True)
            value = {
                "canaryRunId": "run-lineage",
                "scene": {"sceneId": "scene-one", "jobId": "job-one"},
                "workerRecovery": {
                    "state": "PASS_LEASE_RECOVERED_SAME_JOB",
                    "victimJobId": "job-one",
                    "beforeAttempts": 1,
                    "victimAttempts": 2,
                    "leaseTtlSeconds": 180,
                    "oldLeaseOwnerSha256": "a" * 64,
                    "newLeaseOwnerSha256": "b" * 64,
                    "leaseOwnerChanged": True,
                },
            }
            path.write_text(json.dumps(value), encoding="utf-8")
            recovery = MODULE.load_previous_passed_recovery(root, "run-lineage", "scene-one", "job-one")
            self.assertEqual(recovery["victimAttempts"], 2)
            value["workerRecovery"].pop("leaseOwnerChanged")
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "--new-run"):
                MODULE.load_previous_passed_recovery(root, "run-lineage", "scene-one", "job-one")

    def test_three_photo_anchors_are_verified_through_the_viewer(self):
        scene_revision = "scene-r001"
        jobs = []
        manifests = {}
        for index in range(3):
            anchor = {
                "id": f"photo-{index}",
                "sceneRevisionId": scene_revision,
                "position": [index, 0, 0],
                "quaternion": [0, 0, 0, 1],
                "fov": 70 + index,
            }
            jobs.append({"input_sha256": str(index + 1) * 64, "result": {"anchor": anchor}})
            manifests[anchor["id"]] = {
                "defaultPhotoAnchorId": anchor["id"],
                "photoAnchors": [anchor],
            }

        class Client:
            def request(self, _method, path):
                if path.endswith("scene.json"):
                    anchor_id = path.split("/")[-2]
                    return 200, {}, json.dumps(manifests[anchor_id]).encode()
                return 200, {}, b"<!doctype html><script src='playcanvas.js'></script>"

        evidence = MODULE.verify_photo_anchor_http(Client(), "scene-one", scene_revision, jobs)
        self.assertEqual(evidence["verifiedAnchors"], 3)
        jobs[2]["input_sha256"] = jobs[1]["input_sha256"]
        with self.assertRaisesRegex(RuntimeError, "distinct"):
            MODULE.verify_photo_anchor_http(Client(), "scene-one", scene_revision, jobs)

    def test_main_wires_fresh_idempotency_recovery_http_listener_and_safe_reports(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            video = root / "fresh.mp4"
            video.write_bytes(b"fresh-canary")
            photos = []
            for index in range(3):
                photo = root / f"held-{index}.jpg"
                photo.write_bytes(b"jpeg")
                photos.append(photo)
            args = types.SimpleNamespace(
                url="http://127.0.0.1:8780",
                video=video,
                product_root=Path("/home/max/unseen-local-product"),
                install_root=Path("/home/max/src/unseen-local-product"),
                bridge_root=root / "bridge",
                run_id="run-0123456789abcdef",
                runtime_fingerprint_sha256="f" * 64,
                wait_seconds=600,
                exercise_worker_recovery=True,
            )
            scene = {"id": "scene-fresh", "revision_id": "scene-fresh-r001"}
            scene_result = {
                "registeredViews": 300,
                "registeredDirections": ["front", "right", "back", "left", "up", "front_right"],
                "registeredTimeIndices": 40,
                "colmapModelCounts": {"0": 300},
                "trainingIterations": 7000,
                "trainingResumedFromStep": None,
                "trainingLastAttemptWallSeconds": 120.0,
                "trainingLastAttemptPeakVramMiB": 6000,
                "oom": False,
                "checkpointBytes": 10,
                "checkpointSha256": "a" * 64,
                "plyBytes": 11,
                "plySha256": "b" * 64,
                "sogBytes": 12,
                "sogSha256": "c" * 64,
                "heldOutManifest": "/home/max/unseen-local-product/held.json",
            }
            scene_job = {
                "id": "job-scene",
                "kind": "scene_preview",
                "state": "ready",
                "attempts": 2,
                "input_sha256": MODULE.file_sha256(video),
                "result": scene_result,
            }
            scene_result.update({
                "status": "ready",
                "kind": "scene_preview",
                "sceneRevisionId": scene["revision_id"],
                "inputSha256": scene_job["input_sha256"],
            })

            def photo_job(index: int) -> dict:
                metrics = {
                    "geometricInliers": 30,
                    "geometricInlierRatio": 0.2,
                    "medianReprojectionPx": 1.5,
                    "maxReprojectionPx": 2.0,
                    "queryKeypoints": 150,
                    "inlierRatioDefinition": "registered-3d-observations/query-keypoints",
                    "gatePassed": True,
                    "existingFramesFixed": True,
                    "registrationImageList": ["query.jpg"],
                    "referenceFramesInIsolatedDatabase": 270,
                    "referenceFramesCompared": 270,
                    "referenceFramesWhitelisted": 270,
                    "onlyQueryAdded": True,
                    "maxReferenceRotationDelta": 0.0,
                    "maxReferencePositionDelta": 0.0,
                    "referenceGaugeTolerance": 1e-7,
                    "colmapGpuRequested": False,
                    "localDatabaseIsolation": {
                        "sourceDatabaseCopied": True,
                        "sourceDatabaseSha256": "d" * 64,
                        "baseReferenceImages": 270,
                        "removedNonModelImages": 1,
                        "removedOutOfModelPairRows": 2,
                        "onlyQueryUnregistered": True,
                        "queryDatabaseImageId": 271,
                        "databaseImageCountAfterQuery": 271,
                    },
                    "thresholds": {
                        "minGeometricInliers": 20,
                        "minGeometricInlierRatio": 0.1,
                        "maxMedianReprojectionPx": 3.5,
                    },
                }
                return {
                    "id": f"job-photo-{index}",
                    "kind": "photo_localize",
                    "state": "ready",
                    "attempts": 1,
                    "input_sha256": str(index) * 64,
                    "result": {
                        "groundTruthRead": False,
                        "hardcodedPoseUsed": False,
                        "status": "ready",
                        "kind": "photo_localize",
                        "sceneRevisionId": scene["revision_id"],
                        "inputSha256": str(index) * 64,
                        "registrationQuality": metrics,
                        "anchor": {
                            "id": f"photo-{index}",
                            "sceneRevisionId": scene["revision_id"],
                            "position": [index, 0, 0],
                            "quaternion": [0, 0, 0, 1],
                            "fov": 70,
                        },
                    },
                }

            photo_jobs = {f"job-photo-{index}": photo_job(index) for index in range(1, 4)}
            client = mock.Mock()
            photo_upload = iter(photo_jobs)

            def client_json(method, path, **_kwargs):
                if method == "PUT" and path.startswith("/api/scenes?"):
                    return {"scene": scene}
                if method == "POST":
                    return {"job": {"id": "job-scene"}}
                if method == "PUT" and "/photos?" in path:
                    return {"job": {"id": next(photo_upload)}}
                raise AssertionError((method, path))

            client.json.side_effect = client_json
            active = {
                "job": {
                    "id": "job-scene",
                    "attempts": 1,
                    "lease_owner": "owner-old",
                    "lease_expires": time.time() + 180,
                },
                "worker": {
                    "state": "running",
                    "jobId": "job-scene",
                    "owner": "owner-old",
                    "runnerPgid": 444,
                    "leaseTtlSeconds": 180,
                },
            }

            def wait_job(_client, job_id, _timeout):
                if job_id == "job-scene":
                    return scene_job, {"scenes": [scene]}
                return photo_jobs[job_id], {"scenes": [scene]}

            listener = {"state": "PASS_LOOPBACK_ONLY", "port": 8780, "addresses": ["127.0.0.1"]}
            http_evidence = {
                "entryHttpStatus": 200,
                "headHttpStatus": 200,
                "rangeHttpStatus": 206,
                "rangeBytes": 12,
                "invalidRangeHttpStatus": 416,
                "fullDownloadHttpStatus": 200,
                "fullDownloadBytes": 12,
                "fullDownloadSha256": "c" * 64,
            }
            with (
                mock.patch.object(MODULE, "parse_args", return_value=args),
                mock.patch.object(Path, "resolve", autospec=True, side_effect=lambda value: value),
                mock.patch.object(MODULE, "LoopbackClient", return_value=client),
                mock.patch.object(MODULE, "load_release_evidence", return_value={"releaseTag": "v15-r3", "assetName": "payload.tar.gz", "assetSha256": "e" * 64, "assetBytes": 123, "controlCommit": "d" * 40, "payloadManifestSha256": "a" * 64, "payloadFileCount": 42, "runtimeFingerprintSha256": "f" * 64}),
                mock.patch.object(MODULE, "wait_for_active_job", return_value=active),
                mock.patch.object(MODULE, "terminate_worker_for_recovery", return_value={"workerPid": 111, "runnerPgid": 444}),
                mock.patch.object(MODULE, "restart_product", return_value=222),
                mock.patch.object(MODULE, "wait_for_released_attempt", return_value={"attempts": 2, "lease_owner": "owner-new"}),
                mock.patch.object(MODULE, "wait_for_job", side_effect=wait_job),
                mock.patch.object(MODULE, "resolve_inside", return_value=root / "held.json"),
                mock.patch.object(MODULE, "choose_held_out_photos", return_value=photos),
                mock.patch.object(MODULE, "verify_viewer_http", return_value=http_evidence) as verify_http,
                mock.patch.object(MODULE, "verify_photo_anchor_http", return_value={"verifiedAnchors": 3, "rows": []}) as verify_anchors,
                mock.patch.object(MODULE, "verify_loopback_listener", return_value=listener) as verify_listener,
                mock.patch.object(MODULE, "safe_gpu_summary", return_value={"name": "RTX 4060", "driver": "test", "memoryMiB": 8192, "torch": "test", "torchCuda": "test", "torchCudaAvailable": True}),
                mock.patch.object(MODULE, "write_atomic") as write_report,
            ):
                self.assertEqual(MODULE.main(), 0)
            verify_http.assert_called_once_with(client, "scene-fresh", 12, "c" * 64)
            verify_listener.assert_called_once_with(args.url, args.product_root)
            verify_anchors.assert_called_once_with(client, "scene-fresh", "scene-fresh-r001", list(photo_jobs.values()))
            self.assertEqual(write_report.call_count, 4)
            emitted = [call.args[1] for call in write_report.call_args_list]
            self.assertTrue(any('"checkpointBytes": 10' in value for value in emitted))
            self.assertTrue(any("PASS_LEASE_RECOVERED_SAME_JOB" in value for value in emitted))


if __name__ == "__main__":
    unittest.main()
