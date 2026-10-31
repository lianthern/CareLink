#!/usr/bin/env python3
"""Safely renew only the public OSS upload policy for an existing UNSEEN space.

The normal publisher rebuilds the whole public manifest from a local space.  That is
unsafe when the cloud copy may contain newer photos.  This utility reads the current
cloud manifest, replaces only its short-lived upload policy, and verifies the result.

Dry-run is the default.  Use ``--apply`` for the narrowly scoped external write.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


DEFAULT_REPO = "/Users/max/code/spatial-memory"
MAX_TTL_HOURS = 24 * 7
MAX_UPLOAD_BYTES = 20 * 1024 * 1024


class RenewalError(RuntimeError):
    pass


@dataclass(frozen=True)
class RenewalPlan:
    sid: str
    key: str
    key_prefix: str
    max_size: int
    old_expires_at: float
    new_expires_at: float
    manifest: dict[str, Any]


def _safe_sid(raw: str) -> str:
    sid = str(raw or "").strip()
    if not sid or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for ch in sid):
        raise RenewalError(f"非法空间 ID: {raw!r}")
    return sid


def _collection_open(manifest: dict[str, Any]) -> bool:
    collection = manifest.get("collection")
    if isinstance(collection, dict):
        return collection.get("status", "open") == "open"
    return True


def _capacity_full(manifest: dict[str, Any]) -> bool:
    capacity = manifest.get("capacity")
    return bool(isinstance(capacity, dict) and capacity.get("full"))


def build_plan(
    manifest: dict[str, Any],
    sid: str,
    ttl_seconds: int,
    make_policy: Callable[[str, int, int], dict[str, Any]],
    now: float | None = None,
) -> RenewalPlan:
    sid = _safe_sid(sid)
    now = time.time() if now is None else float(now)
    if manifest.get("id") not in (None, sid):
        raise RenewalError(f"云端清单 ID={manifest.get('id')!r} 与目标 {sid!r} 不一致")
    if manifest.get("published") is False:
        raise RenewalError("空间尚未公开发布，拒绝签发公开上传许可")
    if not manifest.get("nodes"):
        raise RenewalError("空间没有公开节点，拒绝签发上传许可")
    if not _collection_open(manifest):
        raise RenewalError("空间收集状态不是 open，拒绝签发上传许可")
    if _capacity_full(manifest):
        raise RenewalError("空间容量已满，拒绝签发上传许可")

    current = manifest.get("upload")
    if not isinstance(current, dict):
        raise RenewalError("云端清单没有可续签的 upload 配置")
    key_prefix = str(current.get("keyPrefix") or "")
    expected = f"spaces/{sid}/inbox-v2/"
    if not key_prefix.startswith(expected) or ".." in key_prefix.split("/") or not key_prefix.endswith("/"):
        raise RenewalError(f"上传前缀不安全或不是当前 inbox-v2: {key_prefix!r}")

    try:
        max_size = int(current.get("maxSize") or 12 * 1024 * 1024)
    except (TypeError, ValueError) as exc:
        raise RenewalError("upload.maxSize 不是整数") from exc
    if max_size <= 0 or max_size > MAX_UPLOAD_BYTES:
        raise RenewalError(f"upload.maxSize 超出安全范围: {max_size}")

    policy = dict(make_policy(key_prefix, int(ttl_seconds), max_size))
    policy["enabled"] = True
    new_expiry = float(policy.get("expiresAt") or 0)
    if new_expiry <= now:
        raise RenewalError("新策略的 expiresAt 没有落在未来")

    updated = json.loads(json.dumps(manifest, ensure_ascii=False))
    updated["upload"] = policy
    updated["expiresAt"] = new_expiry
    updated["uploadPolicyRefreshedAt"] = now
    return RenewalPlan(
        sid=sid,
        key=f"spaces/{sid}/space.json",
        key_prefix=key_prefix,
        max_size=max_size,
        old_expires_at=float(current.get("expiresAt") or manifest.get("expiresAt") or 0),
        new_expires_at=new_expiry,
        manifest=updated,
    )


def _bytes(manifest: dict[str, Any]) -> bytes:
    return (json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _content_projection(manifest: dict[str, Any]) -> dict[str, Any]:
    """Return every field that policy renewal is forbidden to change."""
    projected = json.loads(json.dumps(manifest, ensure_ascii=False))
    for key in ("upload", "expiresAt", "uploadPolicyRefreshedAt"):
        projected.pop(key, None)
    return projected


def _load_oss(repo: str):
    repo = os.path.abspath(os.path.expanduser(repo))
    if not os.path.isfile(os.path.join(repo, "server", "oss.py")):
        raise RenewalError(f"找不到只读主仓的 server/oss.py: {repo}")
    if repo not in sys.path:
        sys.path.insert(0, repo)
    from server import oss  # pylint: disable=import-outside-toplevel

    return oss


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="只续签 UNSEEN 云端上传许可，不覆盖照片和全景")
    parser.add_argument("sid", nargs="+", help="要续签的空间 ID")
    parser.add_argument("--ttl-hours", type=int, default=48, help="有效小时数，最大 168")
    parser.add_argument("--repo", default=os.environ.get("SPATIAL_MEMORY_REPO", DEFAULT_REPO))
    parser.add_argument(
        "--backup-dir",
        default=str(Path(__file__).resolve().parents[1] / "artifacts" / "policy-backups"),
        help="--apply 前保存原始云端清单的本地目录",
    )
    parser.add_argument("--apply", action="store_true", help="实际写回 OSS；缺省只检查")
    args = parser.parse_args(argv)

    if args.ttl_hours < 1 or args.ttl_hours > MAX_TTL_HOURS:
        parser.error(f"--ttl-hours 必须在 1..{MAX_TTL_HOURS} 之间")

    oss = _load_oss(args.repo)
    conf = oss.load_conf()
    reports: list[dict[str, Any]] = []
    for raw_sid in args.sid:
        sid = _safe_sid(raw_sid)
        key = f"spaces/{sid}/space.json"
        original = oss.get_bytes(conf, key)
        original_hash = hashlib.sha256(original).hexdigest()
        try:
            manifest = json.loads(original.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RenewalError(f"{sid}: 云端 space.json 不是有效 UTF-8 JSON") from exc

        def make_policy(prefix: str, ttl_seconds: int, max_size: int) -> dict[str, Any]:
            return oss.post_policy(conf, prefix, expire_s=ttl_seconds, max_size=max_size)

        plan = build_plan(manifest, sid, args.ttl_hours * 3600, make_policy)
        report = {
            "sid": sid,
            "mode": "apply" if args.apply else "dry-run",
            "keyPrefix": plan.key_prefix,
            "maxSize": plan.max_size,
            "oldExpiresAt": plan.old_expires_at,
            "newExpiresAt": plan.new_expires_at,
            "manifestSha256Before": original_hash,
        }
        if args.apply:
            # Re-read immediately before PUT.  If the worker or another publisher changed
            # anything, abort instead of overwriting a newer cloud snapshot.
            latest = oss.get_bytes(conf, key)
            if hashlib.sha256(latest).hexdigest() != original_hash:
                raise RenewalError(f"{sid}: 检查后云端清单发生变化，已拒绝覆盖，请重跑")
            backup_dir = Path(args.backup_dir).expanduser().resolve()
            backup_dir.mkdir(parents=True, exist_ok=True)
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup_path = backup_dir / f"{sid}-{stamp}-{original_hash[:12]}.space.json"
            try:
                with backup_path.open("xb") as handle:
                    handle.write(original)
            except FileExistsError as exc:
                raise RenewalError(f"{sid}: 备份文件已存在，拒绝覆盖: {backup_path}") from exc
            payload = _bytes(plan.manifest)
            oss.put_bytes(
                conf,
                key,
                payload,
                content_type="application/json",
                oss_headers={"x-oss-object-acl": "public-read"},
            )
            verified = oss.get_bytes(conf, key)
            verified_manifest = json.loads(verified.decode("utf-8"))
            verified_expiry = float((verified_manifest.get("upload") or {}).get("expiresAt") or 0)
            if abs(verified_expiry - plan.new_expires_at) > 2:
                raise RenewalError(f"{sid}: 写后校验失败，云端到期时间不一致")
            if _content_projection(verified_manifest) != _content_projection(manifest):
                raise RenewalError(f"{sid}: 写后校验失败，发现上传许可之外的内容变化")
            report["manifestSha256After"] = hashlib.sha256(verified).hexdigest()
            report["backupPath"] = str(backup_path)
            report["verified"] = True
        reports.append(report)

    print(json.dumps({"ok": True, "reports": reports}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RenewalError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
