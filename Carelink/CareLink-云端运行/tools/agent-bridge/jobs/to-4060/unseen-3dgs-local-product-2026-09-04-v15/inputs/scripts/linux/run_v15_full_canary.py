#!/usr/bin/env python3
"""Run the complete loopback v15 canary and emit only safe evidence.

The source video, projected views, uploaded photos, SOG, PLY, checkpoints and
COLMAP database never leave the WSL ext4 product root.  The only files written
to the Bridge checkout are a compact JSON result and Markdown report.
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import math
import os
import re
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit


JOB_ID = "unseen-3dgs-local-product-2026-09-04-v15"
SHA256 = re.compile(r"^[a-f0-9]{64}$")
SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,160}$")
SAFE_TECHNICAL_TEXT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}$")
STREAM_CHUNK_BYTES = 1024 * 1024
ABSOLUTE_PATH = re.compile(r"(?:/(?:home|mnt)/|\b[A-Za-z]:[\\/])")
SECRET_VALUE = re.compile(
    r"(?:\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{16,}|"
    r"\bgithub_pat_[A-Za-z0-9_]{16,}|\bxox[baprs]-[A-Za-z0-9-]{16,}|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----)",
    re.IGNORECASE,
)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def text_sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class LoopbackClient:
    def __init__(self, base_url: str):
        parsed = urlsplit(base_url)
        if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or parsed.path not in {"", "/"}:
            raise ValueError("canary URL must be an http://127.0.0.1:<port> loopback root")
        if not parsed.port:
            raise ValueError("canary URL must include an explicit port")
        self.host = parsed.hostname
        self.port = parsed.port
        self.token = ""

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | Path | None = None,
        headers: dict[str, str] | None = None,
        expected: tuple[int, ...] = (200,),
        timeout: float = 30,
    ) -> tuple[int, dict[str, str], bytes]:
        request_headers = dict(headers or {})
        if self.token:
            request_headers.setdefault("X-UNSEEN-CSRF", self.token)
        connection = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        opened = None
        try:
            if isinstance(body, Path):
                opened = body.open("rb")
                request_headers["Content-Length"] = str(body.stat().st_size)
                request_headers.setdefault("Content-Type", "application/octet-stream")
                payload: Any = opened
            else:
                payload = body
                if isinstance(body, bytes):
                    request_headers.setdefault("Content-Length", str(len(body)))
            connection.request(method, path, body=payload, headers=request_headers)
            response = connection.getresponse()
            data = response.read()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            if response.status not in expected:
                try:
                    detail = json.loads(data).get("error")
                except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
                    detail = data[:300].decode("utf-8", errors="replace")
                raise RuntimeError(f"loopback {method} {path} returned HTTP {response.status}: {detail}")
            return response.status, response_headers, data
        finally:
            if opened is not None:
                opened.close()
            connection.close()

    def json(self, method: str, path: str, *, body: bytes | Path | None = None, expected: tuple[int, ...] = (200,)) -> dict[str, Any]:
        _status, _headers, data = self.request(method, path, body=body, expected=expected, timeout=300)
        value = json.loads(data)
        if not isinstance(value, dict):
            raise RuntimeError(f"loopback {method} {path} did not return an object")
        return value

    def stream_sha256(self, path: str, *, expected: tuple[int, ...] = (200,)) -> tuple[int, dict[str, str], int, str]:
        """Stream an HTTP response into a digest without retaining the SOG."""
        headers = {"X-UNSEEN-CSRF": self.token} if self.token else {}
        connection = http.client.HTTPConnection(self.host, self.port, timeout=300)
        try:
            connection.request("GET", path, headers=headers)
            response = connection.getresponse()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            if response.status not in expected:
                detail = response.read(300).decode("utf-8", errors="replace")
                raise RuntimeError(f"loopback GET {path} returned HTTP {response.status}: {detail}")
            digest = hashlib.sha256()
            total = 0
            while True:
                chunk = response.read(STREAM_CHUNK_BYTES)
                if not chunk:
                    break
                digest.update(chunk)
                total += len(chunk)
            return response.status, response_headers, total, digest.hexdigest()
        finally:
            connection.close()

    def initialize_token(self) -> None:
        _status, _headers, body = self.request("GET", "/")
        match = re.search(rb'name="unseen-token" content="([^"]+)"', body)
        if not match:
            raise RuntimeError("loopback UI did not expose its per-process CSRF token")
        self.token = match.group(1).decode("ascii")

    def status(self) -> dict[str, Any]:
        return self.json("GET", "/api/status")


def find_job(snapshot: dict[str, Any], job_id: str) -> dict[str, Any]:
    for job in snapshot.get("jobs", []):
        if job.get("id") == job_id:
            return job
    raise RuntimeError(f"job disappeared from durable status: {job_id}")


def find_scene(snapshot: dict[str, Any], scene_id: str) -> dict[str, Any]:
    for scene in snapshot.get("scenes", []):
        if scene.get("id") == scene_id:
            return scene
    raise RuntimeError(f"scene disappeared from durable status: {scene_id}")


def wait_for_job(client: LoopbackClient, job_id: str, timeout_seconds: float) -> tuple[dict[str, Any], dict[str, Any]]:
    deadline = time.monotonic() + timeout_seconds
    last = None
    while time.monotonic() < deadline:
        try:
            snapshot = client.status()
            job = find_job(snapshot, job_id)
        except (ConnectionError, TimeoutError, OSError, http.client.HTTPException) as exc:
            state = ("server-unavailable", str(exc))
            if state != last:
                print(f"{job_id}: loopback temporarily unavailable; waiting", flush=True)
                last = state
            time.sleep(2)
            continue
        state = (job.get("state"), job.get("stage"), round(float(job.get("progress") or 0), 3), job.get("attempts"))
        if state != last:
            print(f"{job_id}: state={state[0]} stage={state[1]} progress={state[2]:.1%} attempts={state[3]}", flush=True)
            last = state
        if job.get("state") == "ready":
            return job, snapshot
        if job.get("state") == "failed":
            raise RuntimeError(f"{job_id} failed: {job.get('error') or 'no error detail'}")
        time.sleep(2)
    raise TimeoutError(f"timed out after {timeout_seconds:.0f}s waiting for {job_id}; the durable job remains in the queue")


def wait_for_active_job(client: LoopbackClient, job_id: str, timeout_seconds: float) -> dict[str, Any] | None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        snapshot = client.status()
        job = find_job(snapshot, job_id)
        worker = snapshot.get("worker") or {}
        if (
            job.get("state") in {"leased", "running", "uploading"}
            and worker.get("state") == "running"
            and worker.get("jobId") == job_id
            and worker.get("owner") == job.get("lease_owner")
            and isinstance(worker.get("runnerPgid"), int)
            and int(worker["runnerPgid"]) > 1
        ):
            return {"job": job, "worker": worker}
        if job.get("state") in {"ready", "failed"}:
            return None
        time.sleep(0.1)
    return None


def wait_for_released_attempt(
    client: LoopbackClient,
    job_id: str,
    *,
    before_attempts: int,
    old_owner: str,
    old_lease_expires: float,
    timeout_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last = None
    while time.monotonic() < deadline:
        snapshot = client.status()
        job = find_job(snapshot, job_id)
        state = (job.get("state"), job.get("attempts"), job.get("lease_owner"))
        if state != last:
            print(f"{job_id}: recovery state={state[0]} attempts={state[1]}", flush=True)
            last = state
        attempts = int(job.get("attempts") or 0)
        new_owner = str(job.get("lease_owner") or "")
        if (
            attempts > before_attempts
            and new_owner
            and new_owner != old_owner
            and job.get("state") in {"leased", "running", "uploading", "ready"}
        ):
            if time.time() + 1 < old_lease_expires:
                raise RuntimeError("same job was re-leased before its old 180-second lease expired")
            return job
        if job.get("state") == "failed":
            raise RuntimeError(f"recovery victim failed before a new lease: {job.get('error') or 'no error detail'}")
        time.sleep(1)
    raise TimeoutError("same job was not re-leased with a higher attempt and new owner after lease expiry")


def resolve_inside(path_text: str, root: Path, label: str) -> Path:
    path = Path(path_text).resolve()
    base = root.resolve()
    try:
        path.relative_to(base)
    except ValueError as exc:
        raise RuntimeError(f"{label} escaped WSL product root") from exc
    if not path.is_file():
        raise RuntimeError(f"{label} is missing inside WSL product root")
    return path


def choose_held_out_photos(manifest_path: Path, product_root: Path) -> list[Path]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("usedForTraining") is not False or manifest.get("heldOutViews") != 27:
        raise RuntimeError("held-out manifest does not prove 27 views were excluded from training")
    candidates = {Path(value).name: resolve_inside(value, product_root, "held-out photo") for value in manifest.get("heldOutPaths", [])}
    required = ["t0013_front.jpg", "t0026_right.jpg", "t0039_back.jpg"]
    if any(name not in candidates for name in required):
        raise RuntimeError("held-out manifest lacks the three fixed, spatially distinct canary photos")
    return [candidates[name] for name in required]


def linux_process_state(pid: int) -> str | None:
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
        return text.rsplit(")", 1)[1].strip().split()[0]
    except (OSError, IndexError):
        return None


def linux_process_group_members(pgid: int) -> dict[int, str]:
    members: dict[int, str] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            text = (entry / "stat").read_text(encoding="utf-8")
            fields = text.rsplit(")", 1)[1].strip().split()
            state, member_group = fields[0], int(fields[2])
        except (OSError, IndexError, ValueError):
            continue
        if member_group == pgid:
            members[int(entry.name)] = state
    return members


def terminate_worker_for_recovery(data_root: Path, active: dict[str, Any]) -> dict[str, int]:
    victim_job = active["job"]
    expected_worker = active["worker"]
    victim_job_id = str(victim_job["id"])
    pid_path = data_root / "reports/worker.pid"
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", errors="replace")
        current_worker = json.loads((data_root / "reports/worker-state.json").read_text(encoding="utf-8"))
        runner_pgid = int(current_worker["runnerPgid"])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("cannot safely identify the local GPU worker for recovery exercise") from exc
    if "unseen_local_product.py" not in command or " worker " not in f" {command} ":
        raise RuntimeError("worker PID file belongs to another process; refusing to signal it")
    expected = {
        "pid": int(expected_worker["pid"]),
        "owner": expected_worker["owner"],
        "jobId": victim_job_id,
        "runnerPgid": int(expected_worker["runnerPgid"]),
    }
    if any(current_worker.get(key) != value for key, value in expected.items()) or pid != expected["pid"]:
        raise RuntimeError("worker/job/runner changed before the recovery signal; refusing an ambiguous kill")
    if not linux_process_group_members(runner_pgid):
        raise RuntimeError("recorded runner PGID has no live process-group evidence")
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        state = linux_process_state(pid)
        if state is None or state == "Z":
            break
        time.sleep(0.1)
    else:
        raise RuntimeError("worker did not terminate during bounded recovery exercise")
    deadline = time.monotonic() + 20
    while linux_process_group_members(runner_pgid) and time.monotonic() < deadline:
        time.sleep(0.1)
    leftovers = linux_process_group_members(runner_pgid)
    if leftovers:
        raise RuntimeError(f"runner PGID still has members after worker termination: {sorted(leftovers)}")
    return {"workerPid": pid, "runnerPgid": runner_pgid}


def restart_product(install_root: Path, product_root: Path) -> int:
    script = install_root / "app/start-local-product.sh"
    if not script.is_file():
        raise RuntimeError("installed start-local-product.sh is missing")
    completed = subprocess.run(
        [str(script), "--install-root", str(install_root), "--data-root", str(product_root)],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if completed.returncode:
        raise RuntimeError("worker restart failed: " + (completed.stderr or completed.stdout)[-1000:])
    pid = int((product_root / "reports/worker.pid").read_text(encoding="utf-8").strip())
    return pid


def safe_gpu_summary() -> dict[str, Any]:
    summary: dict[str, Any] = {
        "name": None,
        "driver": None,
        "memoryMiB": None,
        "torch": None,
        "torchCuda": None,
        "torchCudaAvailable": False,
    }
    try:
        line = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.splitlines()[0]
        name, driver, memory = [value.strip() for value in line.split(",", 2)]
        summary.update(name=name, driver=driver, memoryMiB=int(memory))
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        pass
    try:
        import torch  # type: ignore

        summary["torch"] = str(torch.__version__)
        summary["torchCuda"] = str(torch.version.cuda) if torch.version.cuda else None
        summary["torchCudaAvailable"] = bool(torch.cuda.is_available())
    except Exception:
        pass
    return summary


def require_gpu_summary(summary: dict[str, Any]) -> None:
    name = summary.get("name")
    memory = summary.get("memoryMiB")
    if (
        not isinstance(name, str)
        or "RTX 4060" not in name.upper()
        or SAFE_TECHNICAL_TEXT.fullmatch(name) is None
        or not isinstance(summary.get("driver"), str)
        or SAFE_TECHNICAL_TEXT.fullmatch(summary["driver"]) is None
        or isinstance(memory, bool)
        or not isinstance(memory, int)
        or memory <= 0
        or not isinstance(summary.get("torch"), str)
        or SAFE_TECHNICAL_TEXT.fullmatch(summary["torch"]) is None
        or not isinstance(summary.get("torchCuda"), str)
        or SAFE_TECHNICAL_TEXT.fullmatch(summary["torchCuda"]) is None
        or summary.get("torchCudaAvailable") is not True
    ):
        raise RuntimeError(f"4060 CUDA evidence gate failed: {summary}")


def load_release_evidence(install_root: Path, runtime_fingerprint_sha256: str) -> dict[str, Any]:
    if not SHA256.fullmatch(runtime_fingerprint_sha256):
        raise RuntimeError("runtime fingerprint SHA256 is missing or invalid")
    try:
        value = json.loads((install_root / "release-evidence.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError("installed verified release evidence is missing or invalid") from exc
    asset_bytes = value.get("assetBytes")
    asset_sha256 = str(value.get("assetSha256") or "")
    control_commit = str(value.get("controlCommit") or "")
    payload_manifest_sha256 = str(value.get("payloadManifestSha256") or "")
    payload_file_count = value.get("payloadFileCount")
    if (
        value.get("jobId") != JOB_ID
        or not SAFE_ID.fullmatch(str(value.get("releaseTag") or ""))
        or not SAFE_ID.fullmatch(str(value.get("assetName") or ""))
        or not SHA256.fullmatch(asset_sha256)
        or isinstance(asset_bytes, bool)
        or not isinstance(asset_bytes, int)
        or asset_bytes <= 0
        or re.fullmatch(r"[0-9a-f]{40,64}", control_commit) is None
        or not SHA256.fullmatch(payload_manifest_sha256)
        or isinstance(payload_file_count, bool)
        or not isinstance(payload_file_count, int)
        or payload_file_count <= 0
    ):
        raise RuntimeError("installed release evidence does not bind the v15 release asset")
    return {
        "releaseTag": str(value["releaseTag"]),
        "assetName": str(value["assetName"]),
        "assetSha256": asset_sha256,
        "assetBytes": asset_bytes,
        "controlCommit": control_commit,
        "payloadManifestSha256": payload_manifest_sha256,
        "payloadFileCount": payload_file_count,
        "runtimeFingerprintSha256": runtime_fingerprint_sha256,
    }


def require_scene_metrics(result: dict[str, Any]) -> None:
    checks = [
        (int(result.get("registeredViews") or 0) >= 270, "registeredViews < 270"),
        (len(result.get("registeredDirections") or []) >= 6, "registeredDirections < 6"),
        (int(result.get("registeredTimeIndices") or 0) >= 30, "registeredTimeIndices < 30"),
        (result.get("trainingIterations") == 7000, "trainingIterations != 7000"),
        (result.get("oom") is False, "OOM flag is not false"),
        (int(result.get("sogBytes") or 0) > 0, "SOG is empty"),
        (bool(SHA256.fullmatch(str(result.get("sogSha256") or ""))), "SOG SHA256 missing"),
        (int(result.get("plyBytes") or 0) > 0, "PLY is empty"),
        (bool(SHA256.fullmatch(str(result.get("plySha256") or ""))), "PLY SHA256 missing"),
        (int(result.get("checkpointBytes") or 0) > 0, "checkpoint is empty"),
        (bool(SHA256.fullmatch(str(result.get("checkpointSha256") or ""))), "checkpoint SHA256 missing"),
    ]
    failures = [message for passed, message in checks if not passed]
    if failures:
        raise RuntimeError("scene result failed automated evidence gates: " + "; ".join(failures))


def require_photo_metrics(result: dict[str, Any]) -> None:
    if result.get("groundTruthRead") is not False or result.get("hardcodedPoseUsed") is not False:
        raise RuntimeError("photo result did not prove truth-free localization")
    metrics = result.get("registrationQuality") or {}
    inliers = int(metrics.get("geometricInliers") or 0)
    ratio = float(metrics.get("geometricInlierRatio") or 0)
    median = float(metrics.get("medianReprojectionPx") or 1e9)
    if (
        metrics.get("gatePassed") is not True
        or metrics.get("existingFramesFixed") is not True
        or metrics.get("inlierRatioDefinition") != "registered-3d-observations/query-keypoints"
        or inliers < 20
        or ratio < 0.10
        or median > 3.5
    ):
        raise RuntimeError(f"photo registration gate failed: inliers={inliers}, ratio={ratio}, medianPx={median}")


def require_completed_job_identity(job: dict[str, Any], expected_kind: str, scene_revision_id: str) -> dict[str, Any]:
    result = job.get("result")
    input_sha256 = str(job.get("input_sha256") or "")
    if not isinstance(result, dict) or not SHA256.fullmatch(input_sha256):
        raise RuntimeError("durable completed job lacks a valid result/input SHA256")
    expected = {
        "status": "ready",
        "kind": expected_kind,
        "inputSha256": input_sha256,
        "sceneRevisionId": scene_revision_id,
    }
    mismatches = [key for key, value in expected.items() if result.get(key) != value]
    if job.get("state") != "ready":
        mismatches.append("durable state")
    if mismatches:
        raise RuntimeError("completed job/result identity mismatch: " + ", ".join(mismatches))
    return result


def finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"{label} must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise RuntimeError(f"{label} must be finite")
    return number


def finite_vector(value: Any, length: int, label: str) -> list[float]:
    if not isinstance(value, list) or len(value) != length:
        raise RuntimeError(f"{label} must have exactly {length} values")
    return [finite_number(item, label) for item in value]


def nonnegative_int(value: Any, label: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise RuntimeError(f"{label} must be an integer >= {minimum}")
    return value


def strict_bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise RuntimeError(f"{label} must be a boolean")
    return value


def safe_identifier(value: Any, label: str) -> str:
    text = str(value or "")
    if not SAFE_ID.fullmatch(text):
        raise RuntimeError(f"{label} is not a safe identifier")
    return text


def safe_anchor(value: Any, scene_revision_id: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError("photo anchor is missing")
    if value.get("sceneRevisionId") != scene_revision_id:
        raise RuntimeError("photo anchor scene revision mismatch")
    quaternion = finite_vector(value.get("quaternion"), 4, "anchor quaternion")
    norm = math.sqrt(sum(component * component for component in quaternion))
    if abs(norm - 1.0) > 1e-3:
        raise RuntimeError("photo anchor quaternion is not normalized")
    fov = finite_number(value.get("fov"), "anchor fov")
    if not 1 < fov < 179:
        raise RuntimeError("photo anchor fov is outside a safe range")
    return {
        "id": safe_identifier(value.get("id"), "anchor id"),
        "sceneRevisionId": safe_identifier(scene_revision_id, "scene revision id"),
        "position": finite_vector(value.get("position"), 3, "anchor position"),
        "quaternion": quaternion,
        "fov": fov,
    }


def safe_registration_quality(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RuntimeError("photo registration quality is missing")
    if value.get("inlierRatioDefinition") != "registered-3d-observations/query-keypoints":
        raise RuntimeError("photo registration ratio definition changed")
    registration_images = value.get("registrationImageList")
    if (
        not isinstance(registration_images, list)
        or len(registration_images) != 1
        or not isinstance(registration_images[0], str)
        or re.fullmatch(r"query\.[A-Za-z0-9]{1,10}", registration_images[0]) is None
    ):
        raise RuntimeError("registration image list must contain only query.*")
    reference_frames = nonnegative_int(
        value.get("referenceFramesInIsolatedDatabase"),
        "isolated reference frame count",
        minimum=1,
    )
    isolation = value.get("localDatabaseIsolation")
    if not isinstance(isolation, dict):
        raise RuntimeError("local database isolation evidence is missing")
    safe_isolation = {
        "sourceDatabaseCopied": strict_bool(isolation.get("sourceDatabaseCopied"), "source database copied"),
        "sourceDatabaseSha256": str(isolation.get("sourceDatabaseSha256") or ""),
        "baseReferenceImages": nonnegative_int(isolation.get("baseReferenceImages"), "base reference images", minimum=1),
        "removedNonModelImages": nonnegative_int(isolation.get("removedNonModelImages"), "removed non-model images"),
        "removedOutOfModelPairRows": nonnegative_int(isolation.get("removedOutOfModelPairRows"), "removed pair rows"),
        "onlyQueryUnregistered": strict_bool(isolation.get("onlyQueryUnregistered"), "only query unregistered"),
        "queryDatabaseImageId": nonnegative_int(
            isolation.get("queryDatabaseImageId"), "query database image id", minimum=1
        ),
        "databaseImageCountAfterQuery": nonnegative_int(
            isolation.get("databaseImageCountAfterQuery"), "database image count", minimum=2
        ),
    }
    if not SHA256.fullmatch(safe_isolation["sourceDatabaseSha256"]):
        raise RuntimeError("source database isolation evidence lacks a SHA256")
    if not safe_isolation["sourceDatabaseCopied"] or not safe_isolation["onlyQueryUnregistered"]:
        raise RuntimeError("local database isolation evidence did not pass")
    if safe_isolation["baseReferenceImages"] != reference_frames:
        raise RuntimeError("isolated reference frame counts disagree")
    if safe_isolation["databaseImageCountAfterQuery"] != reference_frames + 1:
        raise RuntimeError("isolated database must contain references plus exactly one query")
    colmap_gpu_requested = strict_bool(value.get("colmapGpuRequested"), "COLMAP GPU requested")
    output: dict[str, Any] = {
        "geometricInliers": nonnegative_int(value.get("geometricInliers"), "geometric inliers"),
        "geometricInlierRatio": finite_number(value["geometricInlierRatio"], "geometric inlier ratio"),
        "medianReprojectionPx": finite_number(value["medianReprojectionPx"], "median reprojection"),
        "maxReprojectionPx": finite_number(value["maxReprojectionPx"], "max reprojection"),
        "queryKeypoints": nonnegative_int(value.get("queryKeypoints"), "query keypoints"),
        "inlierRatioDefinition": "registered-3d-observations/query-keypoints",
        "gatePassed": strict_bool(value.get("gatePassed"), "registration gate"),
        "existingFramesFixed": strict_bool(value.get("existingFramesFixed"), "existing frames fixed"),
        "registrationImageList": registration_images,
        "referenceFramesInIsolatedDatabase": reference_frames,
        "colmapGpuRequested": colmap_gpu_requested,
        "colmapFeatureMode": "gpu" if colmap_gpu_requested else "cpu-headless",
        "localDatabaseIsolation": safe_isolation,
    }
    for key in ("referenceFramesCompared", "referenceFramesWhitelisted"):
        if key in value:
            output[key] = nonnegative_int(value[key], key)
    for key in ("maxReferenceRotationDelta", "maxReferencePositionDelta", "referenceGaugeTolerance"):
        if key in value:
            output[key] = finite_number(value[key], key)
    if "onlyQueryAdded" in value:
        output["onlyQueryAdded"] = strict_bool(value.get("onlyQueryAdded"), "only query added")
    thresholds = value.get("thresholds")
    if not isinstance(thresholds, dict):
        raise RuntimeError("photo registration thresholds are missing")
    output["thresholds"] = {
        "minGeometricInliers": nonnegative_int(thresholds.get("minGeometricInliers"), "minimum geometric inliers"),
        "minGeometricInlierRatio": finite_number(thresholds["minGeometricInlierRatio"], "minimum inlier ratio"),
        "maxMedianReprojectionPx": finite_number(thresholds["maxMedianReprojectionPx"], "maximum median reprojection"),
    }
    if output["thresholds"] != {
        "minGeometricInliers": 20,
        "minGeometricInlierRatio": 0.1,
        "maxMedianReprojectionPx": 3.5,
    }:
        raise RuntimeError("photo registration thresholds changed from the frozen v15 contract")
    if not output["gatePassed"] or not output["existingFramesFixed"]:
        raise RuntimeError("photo registration safety evidence did not pass")
    if output.get("onlyQueryAdded") is not True:
        raise RuntimeError("photo registration did not prove query-only model output")
    for key in ("referenceFramesCompared", "referenceFramesWhitelisted"):
        if output.get(key) != reference_frames:
            raise RuntimeError(f"{key} disagrees with the isolated reference count")
    return output


def assert_safe_report_payload(*texts: str) -> None:
    for text in texts:
        if ABSOLUTE_PATH.search(text):
            raise RuntimeError("safe report contains an absolute local path")
        if SECRET_VALUE.search(text):
            raise RuntimeError("safe report contains a secret-like value")


def verify_loopback_listener(base_url: str, product_root: Path) -> dict[str, Any]:
    parsed = urlsplit(base_url)
    port = int(parsed.port or 0)
    try:
        state = json.loads((product_root / "reports/server-state.json").read_text(encoding="utf-8"))
        pid = int(state["pid"])
        command = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", errors="replace")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError("cannot identify the local product server listener") from exc
    if "unseen_local_product.py" not in command or " server " not in f" {command} ":
        raise RuntimeError("server-state PID does not belong to the local product server")
    try:
        rows = subprocess.run(
            ["ss", "-H", "-ltnp"], check=True, capture_output=True, text=True, timeout=10
        ).stdout.splitlines()
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError("ss is required to prove the listener is loopback-only") from exc
    addresses: list[str] = []
    pid_marker = re.compile(rf"pid={pid}(?:,|\))")
    for row in rows:
        fields = row.split()
        if len(fields) < 4 or not pid_marker.search(row):
            continue
        local = fields[3]
        try:
            host, port_text = local.rsplit(":", 1)
        except ValueError:
            continue
        if port_text == str(port):
            addresses.append(host.strip("[]"))
    if not addresses or any(address not in {"127.0.0.1", "::1"} for address in addresses):
        raise RuntimeError(f"product listener is not proven loopback-only: {addresses or 'not found'}")
    return {"state": "PASS_LOOPBACK_ONLY", "port": port, "addresses": sorted(set(addresses))}


def verify_viewer_http(client: LoopbackClient, scene_id: str, sog_bytes: int, sog_sha256: str) -> dict[str, Any]:
    viewer_status, _viewer_headers, viewer_body = client.request("GET", f"/view/{quote(scene_id)}/")
    if b"playcanvas" not in viewer_body.lower() and b"scene" not in viewer_body.lower():
        raise RuntimeError("Viewer entry returned unexpected content")
    head_status, head_headers, head_body = client.request("HEAD", f"/download/{quote(scene_id)}/scene.sog")
    if head_body:
        raise RuntimeError("SOG HEAD unexpectedly returned a body")
    if int(head_headers.get("content-length", "-1")) != sog_bytes:
        raise RuntimeError("SOG HEAD Content-Length disagrees with result")
    if head_headers.get("accept-ranges") != "bytes" or "attachment" not in head_headers.get("content-disposition", ""):
        raise RuntimeError("SOG download HEAD lacks byte-range or attachment headers")
    range_status, range_headers, range_body = client.request(
        "GET",
        f"/download/{quote(scene_id)}/scene.sog",
        headers={"Range": "bytes=0-63"},
        expected=(206,),
    )
    expected_end = min(63, sog_bytes - 1)
    if (
        len(range_body) != expected_end + 1
        or range_headers.get("accept-ranges") != "bytes"
        or range_headers.get("content-range") != f"bytes 0-{expected_end}/{sog_bytes}"
    ):
        raise RuntimeError("SOG byte-range response is invalid")
    invalid_status, invalid_headers, invalid_body = client.request(
        "GET",
        f"/download/{quote(scene_id)}/scene.sog",
        headers={"Range": f"bytes={sog_bytes}-"},
        expected=(416,),
    )
    if invalid_body or invalid_headers.get("content-range") != f"bytes */{sog_bytes}":
        raise RuntimeError("SOG unsatisfiable range did not return an empty 416 contract")
    full_status, full_headers, full_bytes, full_sha256 = client.stream_sha256(
        f"/download/{quote(scene_id)}/scene.sog"
    )
    if (
        full_bytes != sog_bytes
        or full_sha256 != sog_sha256
        or int(full_headers.get("content-length", "-1")) != sog_bytes
        or full_headers.get("accept-ranges") != "bytes"
        or "attachment" not in full_headers.get("content-disposition", "")
    ):
        raise RuntimeError("streamed SOG download bytes/SHA/headers disagree with the runner result")
    return {
        "entryHttpStatus": viewer_status,
        "headHttpStatus": head_status,
        "rangeHttpStatus": range_status,
        "rangeBytes": len(range_body),
        "invalidRangeHttpStatus": invalid_status,
        "fullDownloadHttpStatus": full_status,
        "fullDownloadBytes": full_bytes,
        "fullDownloadSha256": full_sha256,
    }


def verify_photo_anchor_http(
    client: LoopbackClient,
    scene_id: str,
    scene_revision_id: str,
    photo_jobs: list[dict[str, Any]],
) -> dict[str, Any]:
    if len(photo_jobs) != 3:
        raise RuntimeError("anchor HTTP verification requires exactly three photo jobs")
    anchor_ids: list[str] = []
    input_hashes: list[str] = []
    rows: list[dict[str, Any]] = []
    for job in photo_jobs:
        digest = str(job.get("input_sha256") or "")
        if not SHA256.fullmatch(digest):
            raise RuntimeError("photo anchor job lacks a valid input SHA256")
        expected = safe_anchor(job["result"].get("anchor"), scene_revision_id)
        anchor_id = expected["id"]
        page_status, _page_headers, page_body = client.request(
            "GET", f"/view/{quote(scene_id)}/anchor/{quote(anchor_id)}/"
        )
        if b"playcanvas" not in page_body.lower() and b"scene" not in page_body.lower():
            raise RuntimeError("photo anchor Viewer page returned unexpected content")
        manifest_status, _manifest_headers, manifest_body = client.request(
            "GET", f"/view/{quote(scene_id)}/anchor/{quote(anchor_id)}/scene.json"
        )
        try:
            manifest = json.loads(manifest_body)
            selected = manifest["photoAnchors"][0]
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise RuntimeError("photo anchor Viewer manifest is malformed") from exc
        actual = safe_anchor(selected, scene_revision_id)
        if manifest.get("defaultPhotoAnchorId") != anchor_id or actual["id"] != anchor_id:
            raise RuntimeError("photo anchor Viewer did not select the requested anchor")
        for key in ("position", "quaternion"):
            if any(abs(left - right) > 1e-9 for left, right in zip(actual[key], expected[key])):
                raise RuntimeError(f"photo anchor Viewer {key} disagrees with the job result")
        if abs(actual["fov"] - expected["fov"]) > 1e-9:
            raise RuntimeError("photo anchor Viewer fov disagrees with the job result")
        anchor_ids.append(anchor_id)
        input_hashes.append(digest)
        rows.append({"anchorId": anchor_id, "pageHttpStatus": page_status, "manifestHttpStatus": manifest_status})
    if len(set(anchor_ids)) != 3 or len(set(input_hashes)) != 3:
        raise RuntimeError("three photo jobs must have distinct anchor IDs and input SHA256 values")
    return {"verifiedAnchors": 3, "rows": rows}


def load_previous_passed_recovery(product_root: Path, run_id: str, scene_id: str, job_id: str) -> dict[str, Any]:
    """Load only a prior safe report that proves this exact ready job survived recovery."""
    path = product_root / "reports/v15-safe/V15-RESULT.json"
    try:
        text = path.read_text(encoding="utf-8")
        assert_safe_report_payload(text)
        value = json.loads(text)
        recovery = value["workerRecovery"]
        scene = value["scene"]
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            "same-lineage scene is already ready but has no valid local recovery proof; rerun with --new-run"
        ) from exc
    old_owner_hash = str(recovery.get("oldLeaseOwnerSha256") or "")
    new_owner_hash = str(recovery.get("newLeaseOwnerSha256") or "")
    before_attempts = recovery.get("beforeAttempts")
    victim_attempts = recovery.get("victimAttempts")
    checks = (
        value.get("canaryRunId") == run_id,
        scene.get("sceneId") == scene_id,
        scene.get("jobId") == job_id,
        recovery.get("state") == "PASS_LEASE_RECOVERED_SAME_JOB",
        recovery.get("victimJobId") == job_id,
        isinstance(before_attempts, int) and not isinstance(before_attempts, bool),
        isinstance(victim_attempts, int) and not isinstance(victim_attempts, bool),
        isinstance(before_attempts, int) and isinstance(victim_attempts, int) and victim_attempts > before_attempts,
        recovery.get("leaseTtlSeconds") == 180,
        bool(SHA256.fullmatch(old_owner_hash)),
        bool(SHA256.fullmatch(new_owner_hash)),
        old_owner_hash != new_owner_hash,
        recovery.get("leaseOwnerChanged") is True,
    )
    if not all(checks):
        raise RuntimeError(
            "same-lineage scene is already ready but its local recovery proof does not bind this run/scene/job; "
            "rerun with --new-run"
        )
    return recovery


def build_safe_result(
    *,
    run_id: str,
    video: Path,
    scene: dict[str, Any],
    scene_job: dict[str, Any],
    photo_jobs: list[dict[str, Any]],
    duplicate_upload_same_scene: bool,
    duplicate_same_job: bool,
    recovery: dict[str, Any],
    viewer_http: dict[str, Any],
    photo_anchor_http: dict[str, Any],
    listener_evidence: dict[str, Any],
    gpu_summary: dict[str, Any],
    release_evidence: dict[str, Any],
) -> dict[str, Any]:
    scene_result = scene_job["result"]
    scene_revision_id = safe_identifier(scene["revision_id"], "scene revision id")
    photos = []
    for job in photo_jobs:
        result = job["result"]
        input_sha256 = str(job.get("input_sha256") or "")
        if not SHA256.fullmatch(input_sha256):
            raise RuntimeError("photo input evidence lacks a SHA256")
        photos.append(
            {
                "jobId": safe_identifier(job["id"], "photo job id"),
                "state": "ready" if job.get("state") == "ready" else "failed",
                "attempts": int(job["attempts"]),
                "inputSha256": input_sha256,
                "groundTruthRead": result.get("groundTruthRead") is True,
                "hardcodedPoseUsed": result.get("hardcodedPoseUsed") is True,
                "registrationQuality": safe_registration_quality(result.get("registrationQuality")),
                "anchor": safe_anchor(result.get("anchor"), scene_revision_id),
            }
        )
    directions = [safe_identifier(value, "registered direction") for value in scene_result.get("registeredDirections") or []]
    model_counts_raw = scene_result.get("colmapModelCounts") or {}
    if not isinstance(model_counts_raw, dict):
        raise RuntimeError("COLMAP model counts are malformed")
    model_counts = {safe_identifier(key, "COLMAP model id"): int(value) for key, value in model_counts_raw.items()}
    safe_recovery = {
        "state": safe_identifier(recovery.get("state"), "recovery state"),
    }
    for key in ("victimJobId",):
        if recovery.get(key) is not None:
            safe_recovery[key] = safe_identifier(recovery[key], key)
    for key in (
        "beforeAttempts", "victimAttempts", "oldWorkerPid", "newWorkerPid",
        "oldRunnerPgid", "leaseTtlSeconds",
    ):
        if recovery.get(key) is not None:
            safe_recovery[key] = int(recovery[key])
    for key in ("oldLeaseExpiresUnix", "reLeasedAtUnix"):
        if recovery.get(key) is not None:
            safe_recovery[key] = finite_number(recovery[key], key)
    for key in ("oldLeaseOwnerSha256", "newLeaseOwnerSha256"):
        if recovery.get(key) is not None:
            digest = str(recovery[key])
            if not SHA256.fullmatch(digest):
                raise RuntimeError(f"{key} is not a SHA256")
            safe_recovery[key] = digest
    if recovery.get("leaseOwnerChanged") is not None:
        safe_recovery["leaseOwnerChanged"] = strict_bool(recovery["leaseOwnerChanged"], "lease owner changed")
    if safe_recovery["state"] == "PASS_LEASE_RECOVERED_SAME_JOB":
        if (
            safe_recovery.get("leaseOwnerChanged") is not True
            or safe_recovery.get("oldLeaseOwnerSha256") == safe_recovery.get("newLeaseOwnerSha256")
            or safe_recovery.get("leaseTtlSeconds") != 180
            or int(safe_recovery.get("victimAttempts", 0)) <= int(safe_recovery.get("beforeAttempts", 0))
        ):
            raise RuntimeError("safe recovery evidence does not prove expiry and a different lease owner")
    return {
        "schemaVersion": "1.0",
        "jobId": JOB_ID,
        "canaryRunId": safe_identifier(run_id, "canary run id"),
        "generatedAtUnix": int(time.time()),
        "state": "RUNNING_PENDING_4060_AGENT_VISUAL",
        "overallProductGoal": "ACTIVE_PENDING_NEW_UNSEEN_VIDEO_AND_3_REAL_PHOTOS",
        "productionConnected": False,
        "release": release_evidence,
        "input": {"kind": "frozen-public-v11-panorama-sequence-as-mp4", "bytes": video.stat().st_size, "sha256": file_sha256(video), "authorPosePassedToProduct": False},
        "gpu": gpu_summary,
        "scene": {
            "sceneId": safe_identifier(scene["id"], "scene id"),
            "sceneRevisionId": scene_revision_id,
            "jobId": safe_identifier(scene_job["id"], "scene job id"),
            "jobAttempts": int(scene_job["attempts"]),
            "duplicateUploadReturnedSameSceneId": bool(duplicate_upload_same_scene),
            "duplicateStartReturnedSameJobId": duplicate_same_job,
            "registeredViews": int(scene_result["registeredViews"]),
            "registeredDirections": directions,
            "registeredTimeIndices": int(scene_result["registeredTimeIndices"]),
            "colmapModelCounts": model_counts,
            "trainingIterations": int(scene_result["trainingIterations"]),
            "trainingResumedFromStep": None if scene_result.get("trainingResumedFromStep") is None else int(scene_result["trainingResumedFromStep"]),
            "trainingLastAttemptWallSeconds": None if scene_result.get("trainingLastAttemptWallSeconds") is None else finite_number(scene_result["trainingLastAttemptWallSeconds"], "training wall seconds"),
            "trainingLastAttemptPeakVramMiB": None if scene_result.get("trainingLastAttemptPeakVramMiB") is None else int(scene_result["trainingLastAttemptPeakVramMiB"]),
            "oom": scene_result.get("oom") is True,
            "checkpointBytes": int(scene_result["checkpointBytes"]),
            "checkpointSha256": str(scene_result["checkpointSha256"]),
            "plyBytes": int(scene_result["plyBytes"]),
            "plySha256": str(scene_result["plySha256"]),
            "sogBytes": int(scene_result["sogBytes"]),
            "sogSha256": str(scene_result["sogSha256"]),
        },
        "viewerHttp": viewer_http,
        "photoAnchorHttp": photo_anchor_http,
        "viewerVisual": {
            "state": "PENDING_4060_AGENT_VISUAL_WALK_ZOOM_ORIENTATION",
            "walk": None,
            "zoomInOut": None,
            "horizonLevel": None,
            "sixDirections": None,
            "threePhotoAnchors": None,
            "pageErrors": None,
            "viewerFps": None,
            "checkedAt": None,
            "checkedBy": None,
        },
        "photoLocalizations": photos,
        "workerRecovery": safe_recovery,
        "security": {
            "listener": listener_evidence,
            "bridgeFilesWritten": ["V15-RESULT.json", "V15-REPORT.md"],
            "reportBoundaryValidated": True,
            "productionConnectionRequestedByCanary": False,
        },
    }


def render_report(result: dict[str, Any]) -> str:
    scene = result["scene"]
    recovery = result["workerRecovery"]
    photo_rows = "\n".join(
        f"| {index} | `{photo['jobId']}` | {photo['state']} | {photo['attempts']} | {json.dumps(photo['registrationQuality'], ensure_ascii=False)} |"
        for index, photo in enumerate(result["photoLocalizations"], 1)
    )
    return f"""# V15 4060 Automated Canary Report

- Canary run: `{result['canaryRunId']}`
- State: `{result['state']}`
- Overall product goal: `{result['overallProductGoal']}`
- Production connected: `false`
- Release: `{result['release']['releaseTag']}` / `{result['release']['assetName']}` / `{result['release']['assetSha256']}` / `{result['release']['assetBytes']}` bytes / manifest `{result['release']['payloadManifestSha256']}` ({result['release']['payloadFileCount']} files) / control `{result['release']['controlCommit']}` / runtime `{result['release']['runtimeFingerprintSha256']}`
- GPU: `{result['gpu'].get('name')}` / driver `{result['gpu'].get('driver')}` / `{result['gpu'].get('memoryMiB')}` MiB
- Torch/CUDA: `{result['gpu'].get('torch')}` / `{result['gpu'].get('torchCuda')}`; CUDA available `{result['gpu'].get('torchCudaAvailable')}`
- Public fixture MP4: `{result['input']['bytes']}` bytes / `{result['input']['sha256']}`; author pose passed: `false`

## Scene

- Scene revision: `{scene['sceneRevisionId']}`
- Unknown-pose registration: `{scene['registeredViews']}/450`, directions `{scene['registeredDirections']}`, time indices `{scene['registeredTimeIndices']}`
- COLMAP candidate counts: `{scene['colmapModelCounts']}`
- Training: `{scene['trainingIterations']}` iterations; resumed from `{scene['trainingResumedFromStep']}`; last attempt `{scene['trainingLastAttemptWallSeconds']}` s; peak `{scene['trainingLastAttemptPeakVramMiB']}` MiB; OOM `{scene['oom']}`
- Final checkpoint: `{scene['checkpointBytes']}` bytes / `{scene['checkpointSha256']}` (local only)
- PLY: `{scene['plyBytes']}` bytes / `{scene['plySha256']}` (local only)
- SOG: `{scene['sogBytes']}` bytes / `{scene['sogSha256']}` (local only)
- Duplicate upload reused scene: `{scene['duplicateUploadReturnedSameSceneId']}`
- Duplicate start reused job: `{scene['duplicateStartReturnedSameJobId']}`
- Viewer HTTP/Range: `{result['viewerHttp']}`
- Photo anchor Viewer HTTP: `{result['photoAnchorHttp']}`
- Viewer visual walk/zoom/orientation: `{result['viewerVisual']['state']}`

## Three truth-free held-out photos

| # | job | state | attempts | registration metrics |
|---:|---|---|---:|---|
{photo_rows}

## Recovery and safety

- Worker recovery: `{recovery}`
- Listener evidence: `{result['security']['listener']}`.
- Bridge files written: `{result['security']['bridgeFilesWritten']}`; report boundary validation: `{result['security']['reportBoundaryValidated']}`.
- No MP4, frame, photo, SOG, PLY, checkpoint, database, weight, token, `.env` or work directory is included with this report.

This automated pass is not the final product claim. The 4060 Agent must visually verify walk/zoom/orientation, then keep the goal open for one brand-new real 360 upload and three genuinely distinct real photos.
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8780")
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--product-root", type=Path, default=Path("/home/max/unseen-local-product"))
    parser.add_argument("--install-root", type=Path, default=Path("/home/max/src/unseen-local-product"))
    parser.add_argument("--bridge-root", type=Path, required=True)
    parser.add_argument("--run-id", default="")
    parser.add_argument("--runtime-fingerprint-sha256", required=True)
    parser.add_argument("--wait-seconds", type=float, default=8 * 60 * 60)
    parser.add_argument("--exercise-worker-recovery", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    run_id = args.run_id or ("run-" + secrets.token_hex(8))
    safe_identifier(run_id, "canary run id")
    for root, label in ((args.product_root, "product root"), (args.install_root, "install root")):
        if not str(root.resolve()).startswith("/home/"):
            raise SystemExit(f"{label} must be WSL ext4 under /home")
    if not args.video.is_file():
        raise SystemExit(f"canary video missing: {args.video}")

    client = LoopbackClient(args.url)
    client.initialize_token()
    release_evidence = load_release_evidence(args.install_root, args.runtime_fingerprint_sha256)
    gpu_summary = safe_gpu_summary()
    require_gpu_summary(gpu_summary)
    upload_path = f"/api/scenes?filename=v11-sequence-without-poses-{quote(run_id)}.mp4"
    upload = client.json("PUT", upload_path, body=args.video, expected=(201,))
    duplicate_upload = client.json("PUT", upload_path, body=args.video, expected=(201,))
    scene = upload["scene"]
    scene_id = scene["id"]
    duplicate_upload_same_scene = duplicate_upload["scene"]["id"] == scene_id
    if not duplicate_upload_same_scene:
        raise RuntimeError("same-run duplicate video upload created a second scene revision")
    first_start = client.json("POST", f"/api/scenes/{quote(scene_id)}/start", body=b"", expected=(202,))
    duplicate_start = client.json("POST", f"/api/scenes/{quote(scene_id)}/start", body=b"", expected=(202,))
    scene_job_id = first_start["job"]["id"]
    duplicate_same_job = duplicate_start["job"]["id"] == scene_job_id
    if not duplicate_same_job:
        raise RuntimeError("duplicate scene start created a second GPU job")
    print(f"Queued exactly one fresh unknown-pose preview: {scene_id} / {scene_job_id}", flush=True)

    recovery: dict[str, Any]
    performed_recovery = False
    if args.exercise_worker_recovery:
        if first_start["job"].get("state") == "ready":
            recovery = load_previous_passed_recovery(
                args.product_root, run_id, scene_id, scene_job_id
            )
            print("Same-lineage scene is ready; preserved its exact local recovery proof.", flush=True)
        else:
            active = wait_for_active_job(client, scene_job_id, 120)
            if active is None:
                raise RuntimeError("scene preview completed before in-flight recovery could be observed")
            before_job = active["job"]
            before_attempts = int(before_job["attempts"])
            old_owner = str(before_job.get("lease_owner") or "")
            old_lease_expires = float(before_job.get("lease_expires") or 0)
            lease_ttl = int(active["worker"].get("leaseTtlSeconds") or 0)
            if lease_ttl != 180 or not old_owner or old_lease_expires <= time.time():
                raise RuntimeError("active victim lacks the expected live 180-second lease evidence")
            terminated = terminate_worker_for_recovery(args.product_root, active)
            new_pid = restart_product(args.install_root, args.product_root)
            if new_pid == terminated["workerPid"]:
                raise RuntimeError("worker restart reused the terminated PID unexpectedly")
            re_leased = wait_for_released_attempt(
                client,
                scene_job_id,
                before_attempts=before_attempts,
                old_owner=old_owner,
                old_lease_expires=old_lease_expires,
                timeout_seconds=args.wait_seconds,
            )
            new_owner = str(re_leased.get("lease_owner") or "")
            recovery = {
                "state": "RELEASED_SAME_JOB_PENDING_COMPLETION",
                "victimJobId": scene_job_id,
                "beforeAttempts": before_attempts,
                "victimAttempts": int(re_leased["attempts"]),
                "oldWorkerPid": terminated["workerPid"],
                "newWorkerPid": new_pid,
                "oldRunnerPgid": terminated["runnerPgid"],
                "leaseTtlSeconds": lease_ttl,
                "oldLeaseExpiresUnix": old_lease_expires,
                "reLeasedAtUnix": time.time(),
                "oldLeaseOwnerSha256": text_sha256(old_owner),
                "newLeaseOwnerSha256": text_sha256(new_owner),
                "leaseOwnerChanged": bool(new_owner and new_owner != old_owner),
            }
            performed_recovery = True
    else:
        recovery = {"state": "NOT_EXERCISED"}

    scene_job, scene_snapshot = wait_for_job(client, scene_job_id, args.wait_seconds)
    scene = find_scene(scene_snapshot, scene_id)
    require_scene_metrics(require_completed_job_identity(scene_job, "scene_preview", scene["revision_id"]))
    if performed_recovery:
        if int(scene_job.get("attempts") or 0) <= int(recovery["beforeAttempts"]):
            raise RuntimeError("recovery victim completed without a higher lease attempt")
        recovery["state"] = "PASS_LEASE_RECOVERED_SAME_JOB"
        recovery["victimAttempts"] = int(scene_job["attempts"])

    held_manifest = resolve_inside(scene_job["result"]["heldOutManifest"], args.product_root, "held-out manifest")
    held_photos = choose_held_out_photos(held_manifest, args.product_root)
    photo_job_ids: list[str] = []
    for index, photo in enumerate(held_photos, 1):
        response = client.json(
            "PUT",
            f"/api/scenes/{quote(scene_id)}/photos?filename=truth-free-heldout-{index}.jpg",
            body=photo,
            expected=(202,),
        )
        photo_job_ids.append(response["job"]["id"])
    if len(set(photo_job_ids)) != 3:
        raise RuntimeError("three distinct held-out photos did not produce three distinct idempotent jobs")

    photo_jobs = []
    for job_id in photo_job_ids:
        job, _snapshot = wait_for_job(client, job_id, args.wait_seconds)
        require_photo_metrics(require_completed_job_identity(job, "photo_localize", scene["revision_id"]))
        photo_jobs.append(job)
    viewer_http = verify_viewer_http(
        client,
        scene_id,
        int(scene_job["result"]["sogBytes"]),
        str(scene_job["result"]["sogSha256"]),
    )
    photo_anchor_http = verify_photo_anchor_http(
        client, scene_id, scene["revision_id"], photo_jobs
    )
    listener_evidence = verify_loopback_listener(args.url, args.product_root)
    safe_result = build_safe_result(
        run_id=run_id,
        video=args.video,
        scene=scene,
        scene_job=scene_job,
        photo_jobs=photo_jobs,
        duplicate_upload_same_scene=duplicate_upload_same_scene,
        duplicate_same_job=duplicate_same_job,
        recovery=recovery,
        viewer_http=viewer_http,
        photo_anchor_http=photo_anchor_http,
        listener_evidence=listener_evidence,
        gpu_summary=gpu_summary,
        release_evidence=release_evidence,
    )
    json_text = json.dumps(safe_result, indent=2, ensure_ascii=False) + "\n"
    report_text = render_report(safe_result)
    assert_safe_report_payload(json_text, report_text)
    local_report_root = args.product_root / "reports/v15-safe"
    bridge_report_root = args.bridge_root / "results/from-4060" / JOB_ID
    for root in (local_report_root, bridge_report_root):
        write_atomic(root / "V15-RESULT.json", json_text)
        write_atomic(root / "V15-REPORT.md", report_text)
    print(f"RUNNING_PENDING_4060_AGENT_VISUAL. Safe report staged at {bridge_report_root}", flush=True)
    print(f"Open {args.url.rstrip('/')}/view/{scene_id}/ and complete the visual walk/zoom/orientation check.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
