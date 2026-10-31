#!/usr/bin/env python3
"""Loopback-only local appliance for UNSEEN 360 scene and photo jobs.

The browser uploads directly into WSL ext4. SQLite is the durable local source
of truth. A separate single-flight worker leases one job at a time and invokes
an explicit runner. Nothing in this module connects to production or uploads
media to GitHub/iCloud.
"""

from __future__ import annotations

import argparse
import ctypes
import fcntl
import hashlib
import html
import importlib.metadata
import json
import mimetypes
import os
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit


VIDEO_EXTENSIONS = {".mp4", ".mov"}
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png"}
TERMINAL_STATES = {"ready", "failed"}
JOB_STATES = {"queued", "leased", "running", "uploading", "ready", "failed"}
CHUNK_BYTES = 4 * 1024 * 1024
SUPERVISOR_COMMAND = "_supervise-runner"
JSONSCHEMA_VERSION = "4.26.0"
SCHEMA_ROOT = Path(__file__).resolve().parents[1] / "schemas"
# Unit tests on the Mac handoff host have no third-party packages. Tests must
# set this in-process hook explicitly; there is no environment/CLI bypass in
# the installed 4060 runtime.
_SCHEMA_VALIDATOR_FOR_TESTS = None
_SCHEMA_VALIDATORS: dict[str, Any] = {}


def validate_json_contract(value: Any, schema_name: str) -> Any:
    """Validate one installed JSON contract, failing closed on dependency drift."""
    if _SCHEMA_VALIDATOR_FOR_TESTS is not None:
        _SCHEMA_VALIDATOR_FOR_TESTS(value, schema_name)
        return value
    try:
        json.dumps(value, allow_nan=False)
    except (ValueError, TypeError) as exc:
        raise RuntimeError(f"could not validate {schema_name}: {exc}") from exc
    validator = _SCHEMA_VALIDATORS.get(schema_name)
    if validator is None:
        try:
            import jsonschema
            actual_version = importlib.metadata.version("jsonschema")
        except (ImportError, importlib.metadata.PackageNotFoundError) as exc:
            raise RuntimeError(
                f"jsonschema {JSONSCHEMA_VERSION} is required for runtime contract validation"
            ) from exc
        if actual_version != JSONSCHEMA_VERSION:
            raise RuntimeError(
                f"jsonschema {JSONSCHEMA_VERSION} is required; found {actual_version}"
            )
        schema_path = SCHEMA_ROOT / schema_name
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"could not load {schema_name}: {exc}") from exc
        jsonschema.Draft202012Validator.check_schema(schema)
        validator = jsonschema.Draft202012Validator(schema)
        _SCHEMA_VALIDATORS[schema_name] = validator
    errors = sorted(
        validator.iter_errors(value),
        key=lambda error: "/".join(str(part) for part in error.absolute_path),
    )
    if errors:
        error = errors[0]
        location = "$" + "".join(f"[{part!r}]" for part in error.absolute_path)
        raise RuntimeError(f"{schema_name} contract violation at {location}: {error.message}")
    return value


def validate_queue_record(record: Any) -> dict[str, Any]:
    if not isinstance(record, dict):
        raise RuntimeError("durable queue record is not an object")
    return validate_json_contract(record, "queue-state.schema.json")


class ProductError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def epoch() -> float:
    return time.time()


def process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return False


def process_group_members(pgid: int) -> dict[int, str]:
    """Return current PID -> state members for a process group.

    Linux /proc is the production path. The ps fallback keeps the supervisor
    contract testable on the Mac handoff machine without weakening WSL.
    """
    if pgid <= 0:
        return {}
    members: dict[int, str] = {}
    proc_root = Path("/proc")
    if proc_root.is_dir():
        for entry in proc_root.iterdir():
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
    try:
        rows = subprocess.run(
            ["ps", "-axo", "pid=,pgid=,stat="],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
            start_new_session=True,
        ).stdout.splitlines()
    except (OSError, subprocess.SubprocessError):
        return members
    for row in rows:
        fields = row.split(None, 2)
        if len(fields) != 3:
            continue
        try:
            pid, member_group = int(fields[0]), int(fields[1])
        except ValueError:
            continue
        if member_group == pgid:
            members[pid] = fields[2]
    return members


def process_group_active(pgid: int, *, exclude_pid: int | None = None) -> bool:
    return any(
        pid != exclude_pid and not state.upper().startswith("Z")
        for pid, state in process_group_members(pgid).items()
    )


def reap_children_nonblocking() -> None:
    while True:
        try:
            pid, _status = os.waitpid(-1, os.WNOHANG)
        except (ChildProcessError, OSError):
            return
        if pid == 0:
            return


def terminate_known_process_group(
    pgid: int,
    *,
    exclude_pid: int | None = None,
    grace_seconds: float = 5.0,
) -> bool:
    """TERM, wait, then KILL every live member of a known process group."""
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    deadline = time.monotonic() + grace_seconds
    while process_group_active(pgid, exclude_pid=exclude_pid) and time.monotonic() < deadline:
        reap_children_nonblocking()
        time.sleep(0.05)
    if process_group_active(pgid, exclude_pid=exclude_pid):
        if exclude_pid is None:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            for pid, state in process_group_members(pgid).items():
                if pid == exclude_pid or state.upper().startswith("Z"):
                    continue
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
    deadline = time.monotonic() + grace_seconds
    while process_group_active(pgid, exclude_pid=exclude_pid) and time.monotonic() < deadline:
        reap_children_nonblocking()
        time.sleep(0.05)
    reap_children_nonblocking()
    return not process_group_active(pgid, exclude_pid=exclude_pid)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_byte_range(value: str | None, size: int) -> tuple[int, int] | None:
    """Parse one RFC 7233 bytes range, returning an inclusive interval."""
    if value is None:
        return None
    if size <= 0 or not value.startswith("bytes="):
        raise ValueError("unsatisfiable range")
    specification = value[6:].strip()
    if not specification or "," in specification or "-" not in specification:
        raise ValueError("only one bytes range is supported")
    start_text, end_text = specification.split("-", 1)
    try:
        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else size - 1
            if start < 0 or end < start or start >= size:
                raise ValueError("unsatisfiable range")
            return start, min(end, size - 1)
        suffix = int(end_text)
        if suffix <= 0:
            raise ValueError("unsatisfiable range")
        return max(0, size - suffix), size - 1
    except (TypeError, ValueError) as exc:
        raise ValueError("unsatisfiable range") from exc


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def validate_loopback_host(host: str) -> str:
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("refusing non-loopback bind; use 127.0.0.1")
    return host


def validate_ext4_root(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    text = str(resolved)
    if text == "/mnt" or text.startswith("/mnt/"):
        raise ValueError("product root must be on WSL ext4, not /mnt/<drive>")
    return resolved


def safe_display_name(raw: str, allowed: set[str]) -> tuple[str, str]:
    basename = raw.replace("\\", "/").rsplit("/", 1)[-1].strip()
    extension = Path(basename).suffix.lower()
    if extension not in allowed:
        raise ProductError(415, f"allowed extensions: {', '.join(sorted(allowed))}")
    stem = "".join(character if character.isalnum() or character in "._-" else "-" for character in Path(basename).stem)
    stem = stem.strip(".-_")[:80] or "capture"
    return stem + extension, extension


def check_signature(path: Path, kind: str) -> None:
    with path.open("rb") as handle:
        header = handle.read(16)
    if kind == "scene":
        valid = len(header) >= 12 and header[4:8] == b"ftyp"
    else:
        valid = header.startswith(b"\xff\xd8\xff") or header.startswith(b"\x89PNG\r\n\x1a\n")
    if not valid:
        raise ProductError(415, f"file signature is not a supported {kind} container")


def ffprobe(path: Path) -> dict[str, Any]:
    command = [
        "ffprobe", "-v", "error", "-show_entries",
        "format=duration,size,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate",
        "-of", "json", str(path),
    ]
    try:
        completed = subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
        payload = json.loads(completed.stdout)
    except FileNotFoundError as exc:
        raise ProductError(503, "ffprobe is missing in WSL") from exc
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        raise ProductError(422, "ffprobe could not validate this file") from exc
    videos = [row for row in payload.get("streams", []) if row.get("codec_type") == "video"]
    if not videos:
        raise ProductError(422, "no video/image stream was found")
    stream = videos[0]
    try:
        width, height = int(stream["width"]), int(stream["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ProductError(422, "media dimensions are unavailable") from exc
    payload["normalizedWidth"] = width
    payload["normalizedHeight"] = height
    if "duration" in payload.get("format", {}):
        try:
            payload["normalizedDurationSeconds"] = float(payload["format"]["duration"])
        except (TypeError, ValueError):
            pass
    return payload


class Store:
    def __init__(self, root: Path):
        self.root = validate_ext4_root(root)
        self.db_path = self.root / "state/product.sqlite3"
        self.media_root = self.root / "media"
        self.work_root = self.root / "work"
        self.reports_root = self.root / "reports"
        for path in (self.db_path.parent, self.media_root, self.work_root, self.reports_root):
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.initialize()

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.db_path, timeout=30, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        try:
            yield connection
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS scenes (
                    id TEXT PRIMARY KEY, revision_id TEXT UNIQUE NOT NULL,
                    display_name TEXT NOT NULL, source_path TEXT NOT NULL,
                    source_sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
                    width INTEGER NOT NULL, height INTEGER NOT NULL,
                    duration_seconds REAL NOT NULL, state TEXT NOT NULL,
                    result_json TEXT, error TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL,
                    idempotency_key TEXT UNIQUE NOT NULL, scene_id TEXT NOT NULL,
                    input_path TEXT NOT NULL, input_sha256 TEXT NOT NULL,
                    state TEXT NOT NULL, stage TEXT NOT NULL, progress REAL NOT NULL,
                    lease_owner TEXT, lease_expires REAL, heartbeat_at TEXT,
                    attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
                    result_json TEXT, error TEXT, created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(scene_id) REFERENCES scenes(id)
                );
                CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT,
                    at TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(state, created_at);
            """)

    @staticmethod
    def row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        value = dict(row)
        for key in ("result_json",):
            if value.get(key):
                value[key[:-5]] = json.loads(value.pop(key))
            else:
                value.pop(key, None)
                value[key[:-5]] = None
        return value

    def event(self, db: sqlite3.Connection, job_id: str | None, state: str, detail: str) -> None:
        db.execute("INSERT INTO events(job_id,at,state,detail) VALUES(?,?,?,?)", (job_id, utc_now(), state, detail[:1000]))

    def add_scene(self, *, display_name: str, path: Path, digest: str, size: int, probe: dict[str, Any]) -> dict[str, Any]:
        scene_id = "scene-" + uuid.uuid4().hex[:12]
        revision_id = scene_id + "-r001"
        now = utc_now()
        with self.connect() as db:
            db.execute(
                "INSERT INTO scenes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (scene_id, revision_id, display_name, str(path), digest, size,
                 probe["normalizedWidth"], probe["normalizedHeight"], probe["normalizedDurationSeconds"],
                 "uploaded", None, None, now, now),
            )
        return self.get_scene(scene_id)

    def get_scene(self, scene_id: str) -> dict[str, Any]:
        with self.connect() as db:
            value = self.row(db.execute("SELECT * FROM scenes WHERE id=?", (scene_id,)).fetchone())
        if value is None:
            raise ProductError(404, "scene not found")
        return value

    def find_scene_by_source(self, digest: str) -> dict[str, Any] | None:
        with self.connect() as db:
            return self.row(db.execute(
                "SELECT * FROM scenes WHERE source_sha256=? ORDER BY created_at LIMIT 1",
                (digest,),
            ).fetchone())

    def list_scenes(self) -> list[dict[str, Any]]:
        with self.connect() as db:
            return [self.row(row) for row in db.execute("SELECT * FROM scenes ORDER BY created_at DESC")]

    def list_jobs(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as db:
            records = [self.row(row) for row in db.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,))]
        return [validate_queue_record(record) for record in records]

    def worker_status(self) -> dict[str, Any]:
        state_path = self.reports_root / "worker-state.json"
        try:
            reported = json.loads(state_path.read_text(encoding="utf-8"))
            pid = int(reported["pid"])
            age = max(0.0, epoch() - float(reported["updatedEpoch"]))
            stale_after = max(30.0, 3 * float(reported.get("pollSeconds", 5)))
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            return {"state": "offline", "alive": False, "detail": "worker has not reported"}
        if reported.get("state") == "stopped":
            return {**reported, "alive": False, "heartbeatAgeSeconds": round(age, 1)}
        alive = process_is_alive(pid)
        if not alive:
            return {**reported, "state": "offline", "alive": False, "heartbeatAgeSeconds": round(age, 1), "detail": "worker process is not running"}
        if age > stale_after:
            return {**reported, "state": "unresponsive", "alive": True, "heartbeatAgeSeconds": round(age, 1), "detail": "worker heartbeat is stale"}
        return {**reported, "alive": True, "heartbeatAgeSeconds": round(age, 1)}

    def queue(self, kind: str, scene_id: str, input_path: Path, input_sha: str) -> dict[str, Any]:
        if kind not in {"scene_preview", "photo_localize"}:
            raise ValueError(kind)
        identity = hashlib.sha256(f"{kind}:{scene_id}:{input_sha}".encode()).hexdigest()
        now = utc_now()
        with self.connect() as db:
            existing = db.execute("SELECT * FROM jobs WHERE idempotency_key=?", (identity,)).fetchone()
            if existing is not None:
                if existing["state"] == "failed" and existing["attempts"] < existing["max_attempts"]:
                    db.execute(
                        "UPDATE jobs SET state='queued',stage='waiting',error=NULL,lease_owner=NULL,lease_expires=NULL,updated_at=? WHERE id=?",
                        (now, existing["id"]),
                    )
                    if kind == "scene_preview":
                        db.execute(
                            "UPDATE scenes SET state='queued',error=NULL,updated_at=? WHERE id=?",
                            (now, scene_id),
                        )
                    self.event(db, existing["id"], "queued", "explicit retry of same idempotent job")
                    existing = db.execute("SELECT * FROM jobs WHERE id=?", (existing["id"],)).fetchone()
                return validate_queue_record(self.row(existing))
            job_id = "job-" + uuid.uuid4().hex[:12]
            db.execute(
                "INSERT INTO jobs(id,kind,idempotency_key,scene_id,input_path,input_sha256,state,stage,progress,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (job_id, kind, identity, scene_id, str(input_path), input_sha, "queued", "waiting", 0.0, now, now),
            )
            if kind == "scene_preview":
                db.execute("UPDATE scenes SET state='queued',updated_at=?,error=NULL WHERE id=?", (now, scene_id))
            self.event(db, job_id, "queued", "durable local job accepted")
            return validate_queue_record(self.row(db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()))

    def recover_expired(self) -> int:
        now_value = epoch()
        now = utc_now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = list(db.execute(
                "SELECT id,scene_id,kind,attempts,max_attempts FROM jobs WHERE state IN ('leased','running','uploading') AND lease_expires < ?",
                (now_value,),
            ))
            for row in rows:
                state = "queued" if row["attempts"] < row["max_attempts"] else "failed"
                detail = "expired lease recovered" if state == "queued" else "retry budget exhausted after expired lease"
                db.execute(
                    "UPDATE jobs SET state=?,stage=?,lease_owner=NULL,lease_expires=NULL,error=?,updated_at=? WHERE id=?",
                    (state, "waiting" if state == "queued" else "failed", None if state == "queued" else detail, now, row["id"]),
                )
                if row["kind"] == "scene_preview":
                    db.execute(
                        "UPDATE scenes SET state=?,error=?,updated_at=? WHERE id=?",
                        (state, None if state == "queued" else detail, now, row["scene_id"]),
                    )
                self.event(db, row["id"], state, detail)
                validate_queue_record(self.row(db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()))
            db.execute("COMMIT")
        return len(rows)

    def lease_next(self, owner: str, ttl: int) -> dict[str, Any] | None:
        self.recover_expired()
        now = utc_now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM jobs WHERE state='queued' ORDER BY created_at LIMIT 1").fetchone()
            if row is None:
                db.execute("COMMIT")
                return None
            changed = db.execute(
                "UPDATE jobs SET state='leased',stage='leased',lease_owner=?,lease_expires=?,heartbeat_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND state='queued'",
                (owner, epoch() + ttl, now, now, row["id"]),
            ).rowcount
            if changed != 1:
                db.execute("ROLLBACK")
                return None
            self.event(db, row["id"], "leased", f"leased by {owner}")
            validate_queue_record(self.row(db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone()))
            db.execute("COMMIT")
        return self.get_job(row["id"])

    def get_job(self, job_id: str) -> dict[str, Any]:
        with self.connect() as db:
            value = self.row(db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())
        if value is None:
            raise ProductError(404, "job not found")
        return validate_queue_record(value)

    def transition(self, job_id: str, owner: str, state: str, stage: str, progress: float, *, ttl: int = 180, result: dict[str, Any] | None = None, error: str | None = None) -> None:
        if state not in JOB_STATES:
            raise ValueError(state)
        now = utc_now()
        terminal = state in TERMINAL_STATES
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                changed = db.execute(
                    "UPDATE jobs SET state=?,stage=?,progress=?,lease_expires=?,heartbeat_at=?,result_json=?,error=?,updated_at=? WHERE id=? AND lease_owner=?",
                    (state, stage, max(0.0, min(1.0, progress)), None if terminal else epoch() + ttl,
                     now, json.dumps(result, ensure_ascii=False) if result else None, error, now, job_id, owner),
                ).rowcount
                if changed != 1:
                    raise RuntimeError("lease ownership was lost")
                job = db.execute("SELECT scene_id,kind FROM jobs WHERE id=?", (job_id,)).fetchone()
                if job["kind"] == "scene_preview" and state in TERMINAL_STATES:
                    db.execute("UPDATE scenes SET state=?,result_json=?,error=?,updated_at=? WHERE id=?",
                               (state, json.dumps(result, ensure_ascii=False) if result else None, error, now, job["scene_id"]))
                self.event(db, job_id, state, error or stage)
                validate_queue_record(self.row(db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def heartbeat(self, job_id: str, owner: str, ttl: int, stage: str, progress: float) -> None:
        now = utc_now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                changed = db.execute(
                    "UPDATE jobs SET state='running',stage=?,progress=?,lease_expires=?,heartbeat_at=?,updated_at=? WHERE id=? AND lease_owner=? AND state IN ('leased','running')",
                    (stage, max(0.0, min(0.94, progress)), epoch() + ttl, now, now, job_id, owner),
                ).rowcount
                if changed != 1:
                    raise RuntimeError("cannot heartbeat a job without its active lease")
                validate_queue_record(self.row(db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise


def render_page(token: str, max_video: int, max_photo: int) -> bytes:
    page = f"""<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"unseen-token\" content=\"{html.escape(token, quote=True)}\"><title>UNSEEN 本机空间工厂</title><style>
body{{font:16px system-ui;background:#0c1117;color:#e8eef4;margin:0}}main{{max-width:980px;margin:auto;padding:32px 18px}}.card{{background:#151d26;border:1px solid #344252;border-radius:16px;padding:22px;margin:16px 0}}button{{background:#2e8b57;color:white;border:0;border-radius:9px;padding:11px 16px;font-weight:700}}button:disabled{{opacity:.45}}input{{max-width:100%}}pre{{white-space:pre-wrap;background:#090d12;padding:14px;border-radius:10px;min-height:44px}}a{{color:#78b8ff}}.ok{{color:#64d98b}}.bad{{color:#ff8f8f}}.muted{{color:#aab7c4}}table{{width:100%;border-collapse:collapse}}td,th{{padding:8px;border-bottom:1px solid #2b3947;text-align:left;vertical-align:top}}
</style></head><body><main><div class=\"ok\">只在 127.0.0.1 · 视频与照片不离开本机</div><h1>UNSEEN 本机空间工厂</h1><p class=\"muted\">上传一段室内移动 360 全景视频，生成可漫游预览；场景完成后可提交新照片回位。断电或重启后队列会继续。</p>
<section class=\"card\"><h2>1. 上传 2:1 全景视频</h2><input id=\"video\" type=\"file\" accept=\".mp4,.mov\"><button id=\"upload\">上传并校验</button><pre id=\"status\">等待视频。建议 60–180 秒、慢走、不开变焦、光线稳定。</pre></section>
<section class=\"card\"><h2>2. 场景与任务</h2><button id=\"refresh\">刷新</button><p id=\"workerStatus\" class=\"muted\">正在读取 Worker 心跳…</p><div id=\"items\"></div></section>
<section class=\"card\"><h2>3. 新照片回位</h2><select id=\"scene\"></select> <input id=\"photo\" type=\"file\" accept=\".jpg,.jpeg,.png\"><button id=\"photoUpload\">上传照片并定位</button><pre id=\"photoStatus\">场景 ready 后可用。</pre></section>
<script>
const token=document.querySelector('meta[name=unseen-token]').content;const status=document.querySelector('#status');const items=document.querySelector('#items');const sceneSelect=document.querySelector('#scene');const photoStatus=document.querySelector('#photoStatus');const workerStatus=document.querySelector('#workerStatus');let watchedPhotoJobId=null;
const esc=value=>String(value??'').replace(/[&<>\"']/g,ch=>({{'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}}[ch]));
async function api(url,opt={{}}){{opt.headers={{...(opt.headers||{{}}),'X-UNSEEN-CSRF':token}};const r=await fetch(url,opt);const p=await r.json();if(!r.ok)throw Error(p.error||r.statusText);return p}}
async function putFile(url,file,onprogress){{return new Promise((resolve,reject)=>{{const x=new XMLHttpRequest();x.open('PUT',url);x.setRequestHeader('X-UNSEEN-CSRF',token);x.upload.onprogress=e=>e.lengthComputable&&onprogress(Math.round(100*e.loaded/e.total));x.onload=()=>{{let p={{}};try{{p=JSON.parse(x.responseText)}}catch(_e){{}}x.status<300?resolve(p):reject(Error(p.error||x.statusText))}};x.onerror=()=>reject(Error('本机上传连接失败'));x.send(file)}})}}
function photoResult(job){{if(job.state==='ready'){{const anchor=job.result&&job.result.anchor;const label=anchor?`${{anchor.label||'照片锚点'}} [${{anchor.id}}]`:'照片锚点';const url=anchor?`/view/${{encodeURIComponent(job.scene_id)}}/anchor/${{encodeURIComponent(anchor.id)}}/`:`/view/${{encodeURIComponent(job.scene_id)}}/`;return `<span class="ok">ready</span> · <a target="_blank" rel="noopener" href="${{url}}">打开 Viewer 并选择“${{esc(label)}}”</a>`}}if(job.state==='failed'){{const retry=job.attempts<job.max_attempts?`<button onclick="retryJob('${{job.id}}')">重试照片回位</button>`:'重试次数已用完';return `<span class="bad">failed · ${{esc(job.error||'定位失败')}}</span> ${{retry}}`}}return `${{esc(job.state)}} · ${{esc(job.stage)}} · ${{Math.round(job.progress*100)}}%`}}
async function refresh(){{const p=await api('/api/status');const worker=p.worker||{{state:'offline',alive:false}};workerStatus.className=worker.alive?'ok':worker.state==='stopped'?'muted':'bad';workerStatus.textContent=`GPU Worker：${{worker.state}}${{worker.jobId?' · '+worker.jobId:''}}${{worker.stage?' · '+worker.stage:''}}${{worker.heartbeatAgeSeconds!=null?' · 心跳 '+worker.heartbeatAgeSeconds+' 秒前':''}}`;const selected=sceneSelect.value;const readyScenes=p.scenes.filter(s=>s.state==='ready');sceneSelect.innerHTML=readyScenes.map(s=>`<option value="${{esc(s.id)}}">${{esc(s.revision_id)}}</option>`).join('');if(readyScenes.some(s=>s.id===selected))sceneSelect.value=selected;const sceneRows=p.scenes.map(s=>{{let action='';if(s.state==='uploaded')action=`<button onclick="startScene('${{s.id}}')">生成 7k 预览</button>`;else if(s.state==='failed')action=`<button onclick="startScene('${{s.id}}')">重试失败阶段</button> <span class="bad">${{esc(s.error||'')}}</span>`;else if(s.state==='ready')action=`<a class="ok" target="_blank" rel="noopener" href="/view/${{encodeURIComponent(s.id)}}/">打开可漫游场景</a> · <a href="/download/${{encodeURIComponent(s.id)}}/scene.sog">下载 scene.sog</a>`;return `<tr><td>${{esc(s.revision_id)}}</td><td>${{esc(s.state)}}</td><td>${{action}}</td></tr>`}}).join('');const photoJobs=p.jobs.filter(j=>j.kind==='photo_localize');const photoRows=photoJobs.map(j=>`<tr><td>${{esc(j.id)}}</td><td>${{esc(j.scene_id)}}</td><td>${{photoResult(j)}}</td></tr>`).join('');const watched=photoJobs.find(j=>j.id===watchedPhotoJobId)||photoJobs[0];if(watched){{watchedPhotoJobId=watched.id;photoStatus.textContent=watched.state==='ready'?`照片已回位（ready）：${{watched.id}}。请点击对应照片的 Viewer 入口。`:watched.state==='failed'?`照片回位失败（failed）：${{watched.error||'请查看任务日志'}}`:`照片任务 ${{watched.state}}：${{watched.stage}} · ${{Math.round(watched.progress*100)}}%`}}items.innerHTML=`<table><tr><th>场景</th><th>状态</th><th>操作/进度</th></tr>${{sceneRows}}</table><h3>照片回位结果</h3><table><tr><th>任务</th><th>场景</th><th>结果/锚点</th></tr>${{photoRows||'<tr><td colspan="3">暂无照片任务</td></tr>'}}</table><h3>任务 / Worker 状态（本地租约真源）</h3><pre>${{p.jobs.map(j=>esc(`${{j.kind}} · ${{j.state}} · attempt ${{j.attempts}}/${{j.max_attempts}} · 当前阶段/训练 step: ${{j.stage}} · ${{Math.round(j.progress*100)}}%${{j.error?' · '+j.error:''}}`)).join('\\n')||'暂无任务'}}</pre>`}}
async function startScene(id){{await api(`/api/scenes/${{id}}/start`,{{method:'POST'}});await refresh()}}window.startScene=startScene;
async function retryJob(id){{try{{await api(`/api/jobs/${{id}}/retry`,{{method:'POST'}});watchedPhotoJobId=id;await refresh()}}catch(e){{photoStatus.textContent='重试失败：'+e.message}}}}window.retryJob=retryJob;
document.querySelector('#upload').onclick=async()=>{{const f=document.querySelector('#video').files[0];if(!f)return;try{{const p=await putFile('/api/scenes?filename='+encodeURIComponent(f.name),f,n=>status.textContent=`上传 ${{n}}%`);status.textContent=`已校验 ${{p.scene.revision_id}}，点击“生成 7k 预览”开始。`;await refresh()}}catch(e){{status.textContent='失败：'+e.message}}}};
document.querySelector('#photoUpload').onclick=async()=>{{const f=document.querySelector('#photo').files[0],sid=sceneSelect.value;if(!f||!sid)return;try{{const p=await putFile(`/api/scenes/${{sid}}/photos?filename=${{encodeURIComponent(f.name)}}`,f,n=>photoStatus.textContent=`上传 ${{n}}%`);watchedPhotoJobId=p.job.id;photoStatus.textContent=`定位任务已入队：${{p.job.id}}`;await refresh()}}catch(e){{photoStatus.textContent='失败：'+e.message}}}};
document.querySelector('#refresh').onclick=refresh;refresh();setInterval(refresh,5000);
</script></main></body></html>"""
    return page.encode()


class ProductServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], store: Store, token: str, max_video: int, max_photo: int):
        self.store, self.token, self.max_video, self.max_photo = store, token, max_video, max_photo
        # This is captured once at process start. If an installer later
        # replaces the file at the same path, start-local-product.sh can tell
        # that the live process still has the old code loaded.
        self.app_sha256 = sha256_file(Path(__file__).resolve())
        super().__init__(address, ProductHandler)


class ProductHandler(BaseHTTPRequestHandler):
    server: ProductServer
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write(f"{self.client_address[0]} [{self.log_date_time_string()}] {self.command} {urlsplit(self.path).path}\n")

    def respond(self, status: int, payload: dict[str, Any]) -> None:
        body = (json.dumps(payload, ensure_ascii=False) + "\n").encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def mutation_allowed(self) -> bool:
        origin = self.headers.get("Origin")
        port = self.server.server_address[1]
        if origin and origin not in {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}:
            return False
        return secrets.compare_digest(self.headers.get("X-UNSEEN-CSRF", ""), self.server.token)

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/":
            body = render_page(self.server.token, self.server.max_video, self.server.max_photo)
            self.send_response(200)
            for key, value in {
                "Content-Type": "text/html; charset=utf-8", "Content-Length": str(len(body)),
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
            }.items(): self.send_header(key, value)
            self.end_headers(); self.wfile.write(body); return
        if path == "/api/health":
            # Health is used by the read-only doctor and startup fingerprint
            # gate. It must not recover leases or otherwise mutate SQLite.
            self.respond(200, {
                "status": "ready",
                "productionConnected": False,
                "server": {"pid": os.getpid(), "appSha256": self.server.app_sha256},
                "worker": self.server.store.worker_status(),
            })
            return
        if path == "/api/status":
            self.server.store.recover_expired()
            self.respond(200, {
                "status": "ready",
                "productionConnected": False,
                "server": {"pid": os.getpid(), "appSha256": self.server.app_sha256},
                "worker": self.server.store.worker_status(),
                "scenes": self.server.store.list_scenes(),
                "jobs": self.server.store.list_jobs(),
            })
            return
        download_parts = path.strip("/").split("/")
        if len(download_parts) == 3 and download_parts[0] == "download" and download_parts[2] == "scene.sog":
            self.serve_sog_download(download_parts[1])
            return
        if path.startswith("/view/"):
            self.serve_viewer(path)
            return
        self.respond(404, {"error": "not found"})

    def stream_file(self, candidate: Path, *, download_name: str | None = None, send_body: bool = True) -> None:
        try:
            handle = candidate.open("rb")
        except OSError:
            self.respond(404, {"error": "file not found"})
            return
        with handle:
            size = os.fstat(handle.fileno()).st_size
            try:
                interval = parse_byte_range(self.headers.get("Range"), size)
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                return
            start, end = interval if interval is not None else (0, size - 1)
            length = max(0, end - start + 1)
            media_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            if candidate.suffix == ".mjs":
                media_type = "text/javascript"
            self.send_response(206 if interval is not None else 200)
            self.send_header("Content-Type", media_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Accept-Ranges", "bytes")
            if interval is not None:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            if download_name is not None:
                safe_name = "".join(character for character in download_name if character.isalnum() or character in "._-") or "scene.sog"
                self.send_header("Content-Disposition", f'attachment; filename="{safe_name}"')
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if not send_body or length == 0:
                return
            handle.seek(start)
            remaining = length
            try:
                while remaining:
                    chunk = handle.read(min(CHUNK_BYTES, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                return

    def serve_sog_download(self, scene_id: str, *, send_body: bool = True) -> None:
        try:
            scene = self.server.store.get_scene(scene_id)
        except ProductError as exc:
            self.respond(exc.status, {"error": exc.message})
            return
        result = scene.get("result")
        if scene.get("state") != "ready" or not isinstance(result, dict) or not result.get("sogPath"):
            self.respond(409, {"error": "scene SOG is not ready"})
            return
        try:
            product_root = self.server.store.root.resolve()
            viewer_root = Path(result["viewerRoot"]).resolve()
            candidate = Path(result["sogPath"]).resolve()
            viewer_root.relative_to(product_root)
            candidate.relative_to(viewer_root)
        except (KeyError, TypeError, ValueError):
            self.respond(409, {"error": "scene SOG path failed the local product boundary"})
            return
        if candidate.suffix.lower() != ".sog" or not candidate.is_file():
            self.respond(404, {"error": "scene SOG file is missing"})
            return
        self.stream_file(candidate, download_name=f"{scene['revision_id']}.sog", send_body=send_body)

    def do_HEAD(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        download_parts = path.strip("/").split("/")
        if len(download_parts) == 3 and download_parts[0] == "download" and download_parts[2] == "scene.sog":
            self.serve_sog_download(download_parts[1], send_body=False)
            return
        if path.startswith("/view/"):
            self.serve_viewer(path, send_body=False)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def serve_viewer(self, path: str, *, send_body: bool = True) -> None:
        parts = path.strip("/").split("/")
        if len(parts) < 2 or parts[0] != "view":
            self.respond(404, {"error": "viewer not found"}); return
        try:
            scene = self.server.store.get_scene(parts[1])
        except ProductError as exc:
            self.respond(exc.status, {"error": exc.message}); return
        result = scene.get("result")
        if scene.get("state") != "ready" or not isinstance(result, dict) or not result.get("viewerRoot"):
            self.respond(409, {"error": "scene viewer is not ready"}); return
        anchor_id = None
        if len(parts) >= 4 and parts[2] == "anchor":
            anchor_id = parts[3]
            segments = parts[4:] or ["index.html"]
        else:
            segments = parts[2:] or ["index.html"]
        if any(segment in {"", ".", ".."} or "\\" in segment for segment in segments):
            self.respond(404, {"error": "viewer file not found"}); return
        root = Path(result["viewerRoot"]).resolve()
        candidate = root.joinpath(*segments).resolve()
        try:
            root.relative_to(self.server.store.root.resolve())
            candidate.relative_to(root)
        except ValueError:
            self.respond(404, {"error": "viewer file not found"}); return
        if not candidate.is_file():
            self.respond(404, {"error": "viewer file not found"}); return
        if anchor_id is not None:
            manifest_path = root / "scene.json"
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                anchors = manifest["photoAnchors"]
                selected = next(anchor for anchor in anchors if isinstance(anchor, dict) and anchor.get("id") == anchor_id)
            except (OSError, KeyError, TypeError, json.JSONDecodeError, StopIteration):
                self.respond(404, {"error": "photo anchor not found"})
                return
            if candidate == manifest_path:
                manifest["photoAnchors"] = [selected, *(anchor for anchor in anchors if isinstance(anchor, dict) and anchor.get("id") != anchor_id)]
                manifest["defaultPhotoAnchorId"] = anchor_id
                body = (json.dumps(manifest, ensure_ascii=False) + "\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                if send_body:
                    self.wfile.write(body)
                return
        self.stream_file(candidate, send_body=send_body)

    def do_POST(self) -> None:  # noqa: N802
        if not self.mutation_allowed(): self.respond(403, {"error": "loopback token/origin check failed"}); return
        parts = urlsplit(self.path).path.strip("/").split("/")
        try:
            if len(parts) == 4 and parts[:2] == ["api", "scenes"] and parts[3] == "start":
                scene = self.server.store.get_scene(parts[2])
                job = self.server.store.queue("scene_preview", scene["id"], Path(scene["source_path"]), scene["source_sha256"])
                if job["state"] == "failed":
                    raise ProductError(409, "scene retry budget is exhausted")
                self.respond(202, {"job": job}); return
            if len(parts) == 4 and parts[:2] == ["api", "jobs"] and parts[3] == "retry":
                job = self.server.store.get_job(parts[2])
                if job["state"] != "failed":
                    raise ProductError(409, "only a failed job can be retried")
                retried = self.server.store.queue(job["kind"], job["scene_id"], Path(job["input_path"]), job["input_sha256"])
                if retried["state"] != "queued":
                    raise ProductError(409, "job retry budget is exhausted")
                self.respond(202, {"job": retried}); return
            raise ProductError(404, "not found")
        except ProductError as exc: self.respond(exc.status, {"error": exc.message})

    def do_PUT(self) -> None:  # noqa: N802
        if not self.mutation_allowed(): self.respond(403, {"error": "loopback token/origin check failed"}); return
        path = urlsplit(self.path).path
        try:
            if path == "/api/scenes":
                self.respond(201, {"scene": self.receive("scene", None)}); return
            parts = path.strip("/").split("/")
            if len(parts) == 4 and parts[:2] == ["api", "scenes"] and parts[3] == "photos":
                scene = self.server.store.get_scene(parts[2])
                if scene["state"] != "ready": raise ProductError(409, "scene must be ready before photo localization")
                photo = self.receive("photo", scene)
                job = self.server.store.queue("photo_localize", scene["id"], Path(photo["localPath"]), photo["sha256"])
                self.respond(202, {"photo": photo, "job": job}); return
            raise ProductError(404, "not found")
        except ProductError as exc: self.respond(exc.status, {"error": exc.message})
        except Exception:
            self.respond(500, {"error": "unexpected local product error; inspect local log"}); raise

    def receive(self, kind: str, scene: dict[str, Any] | None) -> dict[str, Any]:
        length_text = self.headers.get("Content-Length")
        try: length = int(length_text or "")
        except ValueError as exc: raise ProductError(411, "valid Content-Length required") from exc
        maximum = self.server.max_video if kind == "scene" else self.server.max_photo
        if length <= 0: raise ProductError(400, "empty upload")
        if length > maximum: raise ProductError(413, "file exceeds local size limit")
        query = parse_qs(urlsplit(self.path).query)
        display, extension = safe_display_name(query.get("filename", [""])[0], VIDEO_EXTENSIONS if kind == "scene" else PHOTO_EXTENSIONS)
        media_id = ("incoming-scene-" if kind == "scene" else "photo-") + uuid.uuid4().hex[:12]
        folder = self.server.store.media_root / media_id
        folder.mkdir(mode=0o700)
        part, final = folder / ".upload.part", folder / ("source" + extension)
        digest = hashlib.sha256(); remaining = length
        try:
            with part.open("xb") as output:
                while remaining:
                    chunk = self.rfile.read(min(CHUNK_BYTES, remaining))
                    if not chunk: raise ProductError(400, "upload ended early")
                    output.write(chunk); digest.update(chunk); remaining -= len(chunk)
                output.flush(); os.fsync(output.fileno())
            check_signature(part, kind)
            probe = ffprobe(part)
            if kind == "scene":
                duration = probe.get("normalizedDurationSeconds")
                if duration is None or not 10 <= duration <= 600: raise ProductError(422, "360 video must be 10 seconds to 10 minutes")
                ratio = probe["normalizedWidth"] / probe["normalizedHeight"]
                if not 1.90 <= ratio <= 2.10: raise ProductError(422, "expected a 2:1 equirectangular 360 video")
                existing = self.server.store.find_scene_by_source(digest.hexdigest())
                if existing is not None:
                    shutil.rmtree(folder, ignore_errors=True)
                    return existing
            os.replace(part, final)
            if kind == "scene":
                return self.server.store.add_scene(display_name=display, path=final, digest=digest.hexdigest(), size=length, probe=probe)
            return {"localDisplayName": display, "localPath": str(final), "bytes": length, "sha256": digest.hexdigest(), "width": probe["normalizedWidth"], "height": probe["normalizedHeight"], "sceneRevisionId": scene["revision_id"]}
        except Exception:
            shutil.rmtree(folder, ignore_errors=True); raise


def supervise_runner(expected_parent_pid: int, command: list[str]) -> int:
    """Keep the runner and all of its GPU children tied to the worker lifetime."""
    if not command:
        return 125

    requested_signal: int | None = None

    def request_termination(signum: int, _frame: object) -> None:
        nonlocal requested_signal
        if requested_signal is None:
            requested_signal = signum

    for forwarded in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(forwarded, request_termination)

    if sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        # Linux PR_SET_PDEATHSIG: terminate this supervisor if its worker dies.
        if libc.prctl(1, int(signal.SIGTERM), 0, 0, 0) != 0:
            return 125
        # Adopt and reap runner grandchildren instead of leaving zombies behind.
        if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
            return 125
    # Close the race where the worker died just before PR_SET_PDEATHSIG.
    if os.getppid() != expected_parent_pid:
        return 125
    child = subprocess.Popen(command)
    while child.poll() is None and requested_signal is None:
        time.sleep(0.05)
    returncode = child.poll()
    for forwarded in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(forwarded, signal.SIG_IGN)
    clean = terminate_known_process_group(
        os.getpgrp(), exclude_pid=os.getpid(), grace_seconds=5.0
    )
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        clean = False
    reap_children_nonblocking()
    if not clean:
        return 125
    if requested_signal is not None:
        return 128 + requested_signal
    return int(returncode if returncode is not None else child.returncode)


def terminate_runner_group(process: subprocess.Popen[Any], grace_seconds: float = 5.0) -> None:
    """Stop the dedicated runner process group before another lease can run."""
    clean = terminate_known_process_group(process.pid, grace_seconds=grace_seconds)
    try:
        process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        clean = False
    if not clean or process_group_active(process.pid):
        raise RuntimeError("runner process group could not be terminated; worker is stopping")


def validate_runner_result(result: Any, job: dict[str, Any], scene: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise RuntimeError("runner result is not an object")
    validate_json_contract(result, "result.schema.json")
    expected = {
        "status": "ready",
        "kind": job["kind"],
        "inputSha256": job["input_sha256"],
        "sceneRevisionId": scene["revision_id"],
    }
    mismatches = [key for key, value in expected.items() if result.get(key) != value]
    if mismatches:
        raise RuntimeError("runner result contract mismatch: " + ", ".join(mismatches))
    return result


def run_worker(store: Store, runner: Path, once: bool, ttl: int, interval: float) -> int:
    app_sha256 = sha256_file(Path(__file__).resolve())
    runner_sha256 = sha256_file(runner.resolve())
    lock_path = store.db_path.parent / "gpu-worker.lock"
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError("another GPU worker is already active") from exc
        owner = f"{os.uname().nodename}-{os.getpid()}-{uuid.uuid4().hex[:6]}"

        def report_worker(
            state: str,
            *,
            job_id: str | None = None,
            stage: str | None = None,
            detail: str | None = None,
            runner_pgid: int | None = None,
        ) -> None:
            write_json_atomic(store.reports_root / "worker-state.json", {
                "state": state, "alive": state != "stopped", "pid": os.getpid(), "owner": owner,
                "jobId": job_id, "stage": stage, "detail": detail, "runnerPgid": runner_pgid,
                "appSha256": app_sha256, "runnerSha256": runner_sha256,
                "leaseTtlSeconds": ttl,
                "pollSeconds": interval, "updatedAt": utc_now(), "updatedEpoch": epoch(),
            })

        report_worker("idle", stage="waiting for a local job")
        while True:
            job = store.lease_next(owner, ttl)
            if job is None:
                if once:
                    report_worker("stopped", stage="once mode complete")
                    return 0
                report_worker("idle", stage="waiting for a local job")
                time.sleep(interval); continue
            report_worker("running", job_id=job["id"], stage="leased")
            scene = store.get_scene(job["scene_id"])
            job_dir = store.work_root / job["id"]
            job_dir.mkdir(parents=True, exist_ok=True)
            progress_path, result_path = job_dir / "progress.json", job_dir / "result.json"
            spec = {"schemaVersion": "1.0", "jobId": job["id"], "kind": job["kind"], "scene": scene,
                    "inputPath": job["input_path"], "inputSha256": job["input_sha256"],
                    "productRoot": str(store.root), "workDir": str(job_dir),
                    "progressPath": str(progress_path), "resultPath": str(result_path)}
            validate_json_contract(spec, "job.schema.json")
            spec_path = job_dir / "job.json"; write_json_atomic(spec_path, spec)
            log_path = job_dir / "runner.log"
            process: subprocess.Popen[Any] | None = None
            try:
                store.heartbeat(job["id"], owner, ttl, "starting runner", 0.01)
                with log_path.open("a", encoding="utf-8") as log:
                    process = subprocess.Popen(
                        [sys.executable, str(Path(__file__).resolve()), SUPERVISOR_COMMAND, str(os.getpid()),
                         sys.executable, str(runner.resolve()), "--job-spec", str(spec_path)],
                        stdout=log, stderr=subprocess.STDOUT, text=True, start_new_session=True,
                    )
                    report_worker(
                        "running", job_id=job["id"], stage="runner process group started",
                        runner_pgid=process.pid,
                    )
                    while process.poll() is None:
                        stage, progress = "runner active", 0.1
                        if progress_path.is_file():
                            try:
                                value = json.loads(progress_path.read_text(encoding="utf-8")); stage = str(value.get("stage", stage)); progress = float(value.get("progress", progress))
                            except (OSError, ValueError, json.JSONDecodeError): pass
                        store.heartbeat(job["id"], owner, ttl, stage, progress)
                        report_worker(
                            "running", job_id=job["id"], stage=stage,
                            runner_pgid=process.pid,
                        )
                        time.sleep(min(5.0, ttl / 3, max(0.2, interval)))
                if process.returncode != 0: raise RuntimeError(f"runner exited {process.returncode}; see {log_path}")
                if not result_path.is_file(): raise RuntimeError("runner succeeded without result.json")
                result = validate_runner_result(
                    json.loads(result_path.read_text(encoding="utf-8")), job, scene
                )
                report_worker("running", job_id=job["id"], stage="publishing local result")
                store.transition(job["id"], owner, "uploading", "publishing local result", 0.97, ttl=ttl)
                store.transition(job["id"], owner, "ready", "complete", 1.0, result=result)
            except Exception as exc:
                if process is not None:
                    terminate_runner_group(process)
                try:
                    store.transition(job["id"], owner, "failed", "failed", 1.0, error=str(exc))
                except Exception as transition_error:
                    with log_path.open("a", encoding="utf-8") as log:
                        log.write(f"worker could not record failure after lease/heartbeat loss: {transition_error}\n")
                report_worker("idle", job_id=job["id"], stage="job failed", detail=str(exc))
            if once:
                report_worker("stopped", job_id=job["id"], stage="once mode complete")
                return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("~/unseen-local-product").expanduser())
    sub = parser.add_subparsers(dest="command", required=True)
    server = sub.add_parser("server"); server.add_argument("--host", default="127.0.0.1"); server.add_argument("--port", type=int, default=8780); server.add_argument("--max-video-bytes", type=int, default=2 * 1024**3); server.add_argument("--max-photo-bytes", type=int, default=50 * 1024**2)
    worker = sub.add_parser("worker"); worker.add_argument("--runner", type=Path, required=True); worker.add_argument("--once", action="store_true"); worker.add_argument("--lease-ttl", type=int, default=180); worker.add_argument("--poll-seconds", type=float, default=5)
    sub.add_parser("status"); sub.add_parser("recover")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    if raw and raw[0] == SUPERVISOR_COMMAND:
        if len(raw) < 4:
            return 125
        try:
            expected_parent_pid = int(raw[1])
        except ValueError:
            return 125
        return supervise_runner(expected_parent_pid, raw[2:])
    args = parse_args(raw); os.umask(0o077); store = Store(args.root)
    if args.command == "status": print(json.dumps({"scenes": store.list_scenes(), "jobs": store.list_jobs()}, indent=2, ensure_ascii=False)); return 0
    if args.command == "recover": print(json.dumps({"recovered": store.recover_expired()})); return 0
    if args.command == "worker":
        if not args.runner.is_file(): raise SystemExit(f"runner not found: {args.runner}")
        if args.lease_ttl < 30: raise SystemExit("lease TTL must be at least 30 seconds")
        return run_worker(store, args.runner, args.once, args.lease_ttl, args.poll_seconds)
    host = validate_loopback_host(args.host)
    if shutil.which("ffprobe") is None: raise SystemExit("ffprobe is required")
    token = secrets.token_urlsafe(32); server = ProductServer((host, args.port), store, token, args.max_video_bytes, args.max_photo_bytes)
    state = {
        "url": f"http://127.0.0.1:{server.server_address[1]}/",
        "pid": os.getpid(),
        "root": str(store.root),
        "appSha256": server.app_sha256,
        "startedAt": utc_now(),
        "productionConnected": False,
    }
    write_json_atomic(store.reports_root / "server-state.json", state); print(json.dumps(state, ensure_ascii=False), flush=True)
    try: server.serve_forever(0.25)
    except KeyboardInterrupt: pass
    finally: server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
