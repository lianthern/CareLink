#!/usr/bin/env python3
"""Loopback-only video intake for the isolated UNSEEN SceneWorker.

The browser sends the selected file directly to WSL. The server streams it to
WSL ext4, verifies an ISO-BMFF signature, hashes it, and runs ffprobe. It never
starts training and it never sends the video anywhere else.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INTAKE_ROOT = PROJECT_ROOT / "data/local-intake"
DEFAULT_STATE_PATH = PROJECT_ROOT / "reports/local-intake/server-state.json"
ALLOWED_EXTENSIONS = {".mp4", ".mov"}
CHUNK_BYTES = 4 * 1024 * 1024


class IntakeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def validate_loopback_host(host: str) -> str:
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("refusing non-loopback bind; use 127.0.0.1")
    return host


def validate_ext4_destination(path: Path) -> Path:
    resolved = path.expanduser().resolve()
    text = str(resolved)
    if text == "/mnt" or text.startswith("/mnt/"):
        raise ValueError("intake root must be on WSL ext4, not /mnt/<drive>")
    return resolved


def normalize_filename(raw: str) -> tuple[str, str]:
    basename = raw.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not basename:
        raise IntakeError(400, "missing filename")
    extension = Path(basename).suffix.lower()
    if extension not in ALLOWED_EXTENSIONS:
        raise IntakeError(415, "only .mp4 and .mov are accepted")
    stem = Path(basename).stem
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip(".-_")
    if not stem:
        stem = "capture"
    return f"{stem[:80]}{extension}", extension


def is_iso_bmff_video(path: Path) -> bool:
    with path.open("rb") as handle:
        header = handle.read(12)
    return len(header) >= 12 and header[4:8] == b"ftyp"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ffprobe_video(path: Path, timeout_seconds: int = 45) -> dict[str, Any]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,format_name:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate",
        "-of",
        "json",
        str(path),
    ]
    try:
        completed = subprocess.run(
            command,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout_seconds,
        )
    except FileNotFoundError as exc:
        raise IntakeError(503, "ffprobe is not installed in WSL") from exc
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise IntakeError(422, "ffprobe could not validate this video") from exc
    try:
        result = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise IntakeError(422, "ffprobe returned invalid metadata") from exc
    streams = result.get("streams", [])
    if not any(stream.get("codec_type") == "video" for stream in streams):
        raise IntakeError(422, "the uploaded file has no video stream")
    try:
        duration = float(result["format"]["duration"])
    except (KeyError, TypeError, ValueError) as exc:
        raise IntakeError(422, "the uploaded video duration is unavailable") from exc
    result["normalizedDurationSeconds"] = duration
    return result


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def render_page(csrf_token: str, max_bytes: int, max_duration_seconds: float) -> bytes:
    max_gib = max_bytes / (1024**3)
    page = f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="unseen-csrf" content="{html.escape(csrf_token, quote=True)}">
  <title>UNSEEN 本机视频入口</title>
  <style>
    :root {{ color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }}
    body {{ margin: 0; background: #0d1117; color: #e6edf3; }}
    main {{ max-width: 760px; margin: 0 auto; padding: 40px 20px 72px; }}
    .card {{ background: #161b22; border: 1px solid #30363d; border-radius: 16px; padding: 24px; margin-top: 18px; }}
    h1 {{ font-size: clamp(28px, 5vw, 46px); margin: 0 0 8px; }}
    h2 {{ font-size: 19px; margin: 0 0 12px; }}
    p, li {{ line-height: 1.6; color: #b1bac4; }}
    label {{ display: block; border: 1px dashed #58a6ff; border-radius: 12px; padding: 28px; text-align: center; cursor: pointer; }}
    input {{ margin-top: 12px; max-width: 100%; }}
    button {{ margin-top: 18px; border: 0; border-radius: 10px; padding: 12px 18px; background: #238636; color: white; font-weight: 700; cursor: pointer; }}
    button:disabled {{ opacity: .45; cursor: not-allowed; }}
    progress {{ width: 100%; height: 18px; margin-top: 18px; }}
    pre {{ white-space: pre-wrap; overflow-wrap: anywhere; background: #0d1117; border-radius: 10px; padding: 14px; min-height: 24px; }}
    .safe {{ color: #3fb950; font-weight: 700; }}
  </style>
</head>
<body><main>
  <div class="safe">仅在这台 4060 的 127.0.0.1 运行</div>
  <h1>把视频送进 WSL</h1>
  <p>文件直接写入这台电脑的 WSL ext4，不经过 GitHub、iCloud 或生产服务器。上传完成后只做格式检查，不会自动训练。</p>
  <section class="card">
    <h2>教室 / 房间拍摄建议</h2>
    <ol>
      <li>拍 60–120 秒，慢慢走一圈并尽量回到起点；镜头始终看向房间内部。</li>
      <li>相邻画面保持大量重叠；不要变焦、突然甩镜头或频繁切换镜头。</li>
      <li>尽量保持光线稳定，移走走动的人；玻璃、镜子和纯白墙少占画面。</li>
    </ol>
  </section>
  <section class="card">
    <label>选择 MP4 或 MOV（最大 {max_gib:.1f} GiB，最长 {max_duration_seconds / 60:.0f} 分钟）
      <input id="file" type="file" accept="video/mp4,video/quicktime,.mp4,.mov">
    </label>
    <button id="upload" disabled>上传并校验</button>
    <progress id="progress" max="100" value="0" hidden></progress>
    <pre id="status">等待选择视频。</pre>
  </section>
</main>
<script>
const input = document.querySelector('#file');
const button = document.querySelector('#upload');
const progress = document.querySelector('#progress');
const status = document.querySelector('#status');
const csrf = document.querySelector('meta[name="unseen-csrf"]').content;
input.addEventListener('change', () => {{
  button.disabled = !input.files.length;
  status.textContent = input.files.length ? `已选择：${{input.files[0].name}}` : '等待选择视频。';
}});
button.addEventListener('click', () => {{
  const file = input.files[0];
  if (!file) return;
  button.disabled = true;
  progress.hidden = false;
  progress.value = 0;
  status.textContent = '正在上传到本机 WSL ext4…';
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', `/api/upload?filename=${{encodeURIComponent(file.name)}}`);
  xhr.setRequestHeader('X-UNSEEN-CSRF', csrf);
  xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
  xhr.upload.onprogress = event => {{
    if (event.lengthComputable) progress.value = (event.loaded / event.total) * 100;
  }};
  xhr.onload = () => {{
    button.disabled = false;
    let payload = {{}};
    try {{ payload = JSON.parse(xhr.responseText); }} catch (_) {{}}
    if (xhr.status === 201) {{
      progress.value = 100;
      status.textContent = `校验通过。\nJob ID：${{payload.jobId}}\n时长：${{payload.durationSeconds.toFixed(1)}} 秒\n状态：等待你明确启动 preview；当前没有训练。`;
    }} else {{
      status.textContent = `失败：${{payload.error || xhr.statusText || xhr.status}}`;
    }}
  }};
  xhr.onerror = () => {{ button.disabled = false; status.textContent = '上传连接失败。'; }};
  xhr.send(file);
}});
</script></body></html>"""
    return page.encode("utf-8")


class IntakeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        address: tuple[str, int],
        *,
        intake_root: Path,
        csrf_token: str,
        max_bytes: int,
        min_duration_seconds: float,
        max_duration_seconds: float,
    ) -> None:
        self.intake_root = intake_root
        self.csrf_token = csrf_token
        self.max_bytes = max_bytes
        self.min_duration_seconds = min_duration_seconds
        self.max_duration_seconds = max_duration_seconds
        super().__init__(address, IntakeHandler)


class IntakeHandler(BaseHTTPRequestHandler):
    server: IntakeHTTPServer
    protocol_version = "HTTP/1.0"

    def log_message(self, format_string: str, *args: object) -> None:
        # Do not log original filenames or query strings.
        safe_path = urlsplit(self.path).path
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (self.client_address[0], self.log_date_time_string(), format_string % ((safe_path,) + args[1:]))
        )

    def _json(self, status: int, payload: dict[str, Any]) -> None:
        body = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _allowed_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if origin is None:
            return True
        port = self.server.server_address[1]
        return origin in {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self._allowed_origin():
            self._json(403, {"error": "cross-origin upload refused"})
            return
        origin = self.headers.get("Origin")
        self.send_response(204)
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-UNSEEN-CSRF")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/":
            body = render_page(
                self.server.csrf_token,
                self.server.max_bytes,
                self.server.max_duration_seconds,
            )
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/health":
            self._json(
                200,
                {
                    "status": "READY",
                    "bindAddress": self.server.server_address[0],
                    "port": self.server.server_address[1],
                    "trainingStartsAutomatically": False,
                    "intakeRoot": str(self.server.intake_root),
                },
            )
            return
        self._json(404, {"error": "not found"})

    def do_PUT(self) -> None:  # noqa: N802
        if urlsplit(self.path).path != "/api/upload":
            self._json(404, {"error": "not found"})
            return
        try:
            result = self._receive_upload()
        except IntakeError as exc:
            self._json(exc.status, {"error": exc.message})
            return
        except Exception:
            self._json(500, {"error": "unexpected local intake error; inspect the local server log"})
            raise
        self._json(201, result)

    def _receive_upload(self) -> dict[str, Any]:
        if not self._allowed_origin():
            raise IntakeError(403, "cross-origin upload refused")
        supplied_token = self.headers.get("X-UNSEEN-CSRF", "")
        if not secrets.compare_digest(supplied_token, self.server.csrf_token):
            raise IntakeError(403, "invalid local intake token; reload the page")
        raw_length = self.headers.get("Content-Length")
        if raw_length is None:
            raise IntakeError(411, "Content-Length is required")
        try:
            content_length = int(raw_length)
        except ValueError as exc:
            raise IntakeError(400, "invalid Content-Length") from exc
        if content_length <= 0:
            raise IntakeError(400, "empty upload")
        if content_length > self.server.max_bytes:
            raise IntakeError(413, "video exceeds the configured local size limit")
        query = parse_qs(urlsplit(self.path).query)
        raw_filename = query.get("filename", [""])[0]
        safe_name, extension = normalize_filename(raw_filename)

        job_id = f"local-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"
        job_dir = self.server.intake_root / job_id
        job_dir.mkdir(parents=True, mode=0o700)
        part_path = job_dir / ".source.upload.part"
        final_path = job_dir / f"source{extension}"
        digest = hashlib.sha256()
        remaining = content_length
        try:
            with part_path.open("xb") as handle:
                while remaining:
                    chunk = self.rfile.read(min(CHUNK_BYTES, remaining))
                    if not chunk:
                        raise IntakeError(400, "upload ended before Content-Length bytes arrived")
                    handle.write(chunk)
                    digest.update(chunk)
                    remaining -= len(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            if not is_iso_bmff_video(part_path):
                raise IntakeError(415, "file signature is not an MP4/MOV ISO-BMFF container")
            probe = ffprobe_video(part_path)
            duration = float(probe["normalizedDurationSeconds"])
            if duration < self.server.min_duration_seconds:
                raise IntakeError(422, f"video is shorter than {self.server.min_duration_seconds:g} seconds")
            if duration > self.server.max_duration_seconds:
                raise IntakeError(422, f"video is longer than {self.server.max_duration_seconds / 60:g} minutes")
            os.replace(part_path, final_path)
            metadata = {
                "schemaVersion": "1.0",
                "jobId": job_id,
                "status": "UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW",
                "receivedAt": utc_now(),
                "source": {
                    "localDisplayName": safe_name,
                    "localPath": str(final_path),
                    "bytes": content_length,
                    "sha256": digest.hexdigest(),
                    "containerExtension": extension,
                    "ffprobe": probe,
                },
                "policy": {
                    "trainingStartsAutomatically": False,
                    "githubUploadAllowed": False,
                    "icloudUploadAllowed": False,
                    "productionUploadAllowed": False,
                },
            }
            write_json_atomic(job_dir / "intake.json", metadata)
            return {
                "jobId": job_id,
                "status": metadata["status"],
                "bytes": content_length,
                "sha256": digest.hexdigest(),
                "durationSeconds": duration,
                "trainingStarted": False,
            }
        except Exception:
            shutil.rmtree(job_dir, ignore_errors=True)
            raise


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8780)
    parser.add_argument("--root", type=Path, default=DEFAULT_INTAKE_ROOT)
    parser.add_argument("--state-path", type=Path, default=DEFAULT_STATE_PATH)
    parser.add_argument("--max-bytes", type=int, default=2 * 1024**3)
    parser.add_argument("--min-duration-seconds", type=float, default=3.0)
    parser.add_argument("--max-duration-seconds", type=float, default=600.0)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    host = validate_loopback_host(args.host)
    intake_root = validate_ext4_destination(args.root)
    state_path = validate_ext4_destination(args.state_path)
    if not 1024 <= args.port <= 65535:
        raise SystemExit("port must be between 1024 and 65535")
    if args.max_bytes <= 0 or args.min_duration_seconds <= 0:
        raise SystemExit("size and duration limits must be positive")
    if args.max_duration_seconds <= args.min_duration_seconds:
        raise SystemExit("maximum duration must exceed minimum duration")
    if shutil.which("ffprobe") is None:
        raise SystemExit("ffprobe is required; run the existing SceneWorker doctor/install first")
    os.umask(0o077)
    intake_root.mkdir(parents=True, exist_ok=True)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    server = IntakeHTTPServer(
        (host, args.port),
        intake_root=intake_root,
        csrf_token=token,
        max_bytes=args.max_bytes,
        min_duration_seconds=args.min_duration_seconds,
        max_duration_seconds=args.max_duration_seconds,
    )
    actual_host, actual_port = server.server_address[:2]
    state = {
        "schemaVersion": "1.0",
        "pid": os.getpid(),
        "bindAddress": actual_host,
        "port": actual_port,
        "url": f"http://127.0.0.1:{actual_port}/",
        "intakeRoot": str(intake_root),
        "statePath": str(state_path),
        "startedAt": utc_now(),
        "trainingStartsAutomatically": False,
    }
    write_json_atomic(state_path, state)
    print(json.dumps(state, ensure_ascii=False), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        try:
            state_path.unlink()
        except FileNotFoundError:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
