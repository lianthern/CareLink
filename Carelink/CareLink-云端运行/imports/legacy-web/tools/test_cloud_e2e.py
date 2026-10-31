#!/usr/bin/env python3
"""Run one real CloudBase → OSS → manifest lifecycle and remove its test data."""

from __future__ import annotations

import base64
from email.utils import formatdate
import hashlib
import hmac
import json
from pathlib import Path
from urllib.parse import quote
import secrets
import time

import requests


ROOT = Path(__file__).resolve().parents[1]
API = "https://unseen-d3gtp0sxh53bbef61-1316841054.ap-shanghai.app.tcloudbase.com/unseen-api"
WEB_ORIGIN = "https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com"
OSS_CONFIG = Path("/Users/max/.config/psm/aliyun.json")


def api(action: str, headers: dict[str, str] | None = None, **body):
    response = requests.post(
        API,
        json={"action": action, **body},
        headers=headers or {},
        timeout=30,
    )
    payload = response.json()
    assert response.status_code == 200 and payload.get("ok"), (
        action,
        response.status_code,
        payload.get("error"),
    )
    return payload["data"]


def upload(ticket: dict, path: Path, mime: str):
    with path.open("rb") as handle:
        response = requests.post(
            ticket["host"],
            data=ticket["fields"],
            files={"file": (path.name, handle, mime)},
            timeout=120,
        )
    assert response.status_code == 200, (
        "OSS POST",
        response.status_code,
        response.text[:500],
    )


class OssCleanup:
    def __init__(self):
        raw = json.loads(OSS_CONFIG.read_text(encoding="utf-8"))
        region = str(raw["region"]).removeprefix("oss-")
        self.bucket = raw["bucket"]
        self.endpoint = f"oss-{region}.aliyuncs.com"
        self.access_key_id = raw["accessKeyId"]
        self.access_key_secret = raw["accessKeySecret"].encode("utf-8")

    def delete(self, key: str):
        date = formatdate(timeval=None, localtime=False, usegmt=True)
        canonical_resource = f"/{self.bucket}/{key}"
        string_to_sign = f"DELETE\n\n\n{date}\n{canonical_resource}"
        signature = base64.b64encode(
            hmac.new(self.access_key_secret, string_to_sign.encode("utf-8"), hashlib.sha1).digest()
        ).decode("ascii")
        url = f"https://{self.bucket}.{self.endpoint}/{quote(key, safe='/')}"
        response = requests.delete(
            url,
            headers={
                "Date": date,
                "Authorization": f"OSS {self.access_key_id}:{signature}",
            },
            timeout=30,
        )
        assert response.status_code in (200, 204, 404), (key, response.status_code)


sid = ""
photo_id = ""
slot = None
removed = 0
cleanup = OssCleanup()
try:
    health = requests.get(API, params={"action": "health"}, timeout=20).json()
    assert health.get("ok") and health["data"]["service"] == "unseen-cloudbase-backend"

    preflight = requests.options(
        API,
        headers={
            "Origin": WEB_ORIGIN,
            "Access-Control-Request-Method": "POST",
        },
        timeout=20,
    )
    assert preflight.status_code == 204
    assert preflight.headers.get("Access-Control-Allow-Origin") == WEB_ORIGIN

    client_create_id = f"py-e2e-{secrets.token_hex(12)}"
    created = api(
        "createSpace",
        clientCreateId=client_create_id,
        title="UNSEEN E2E 临时空间",
        date="2026-08-02",
        place="Automated test",
        subtitle="Deleted after verification",
        media={"cover": False, "panorama": True},
    )
    sid = created["spaceId"]
    assert created["status"] == "draft" and created["uploads"].get("panorama")
    upload(created["uploads"]["panorama"], ROOT / "web/demo-assets/pano.jpg", "image/jpeg")

    finalized = api(
        "finalizeSpace",
        headers={"X-Unseen-Host-Key": created["hostKey"]},
        spaceId=sid,
    )
    manifest = finalized["manifest"]
    assert finalized["status"] == "published"
    assert manifest["upload"]["mode"] == "ticket-v1"
    assert manifest["upload"]["endpoint"] == API
    assert manifest["nodes"][0]["panorama"]

    client_upload_id = f"py-photo-{secrets.token_hex(12)}"
    ticket = api(
        "photoTicket",
        spaceId=sid,
        clientUploadId=client_upload_id,
        contributor="E2E tester",
        caption="ordinary photo",
    )
    photo_id = ticket["photoId"]
    slot = int(photo_id[-8:], 16) % 90
    assert not ticket["committed"]
    upload(ticket["upload"], ROOT / "web/demo-assets/ph_p1.jpg", "image/jpeg")
    committed = api("commitPhoto", commitToken=ticket["commitToken"])
    assert committed["photo"]["id"] == photo_id
    retried = api("commitPhoto", commitToken=ticket["commitToken"])
    assert retried["idempotent"] is True

    response = requests.get(created["manifestUrl"], params={"e2e": int(time.time())}, timeout=20)
    assert response.status_code == 200
    manifest = response.json()
    assert manifest["id"] == sid
    assert len(manifest["photos"]) == 1
    assert manifest["capacity"]["received"] == 1
    assert manifest["capacity"]["remaining"] == 89
    assert manifest["upload"]["endpoint"] == API
    assert created["hostKey"] not in json.dumps(manifest)
    for asset in (manifest["nodes"][0]["panorama"], manifest["photos"][0]["src"]):
        asset_response = requests.get(asset, timeout=30)
        assert asset_response.status_code == 200 and len(asset_response.content) > 0
    print(json.dumps({"ok": True, "checks": 14, "sid": sid, "manifestPhotos": 1}))
finally:
    if sid:
        keys = [
            f"spaces/{sid}/space.json",
            f"spaces/{sid}/nodes/n1/pano.jpg",
            f"unseen-backend/v1/spaces/{sid}/state.json",
            f"unseen-backend/v1/staging/{sid}/panorama.bin",
        ]
        if photo_id:
            keys.extend(
                [
                    f"spaces/{sid}/photos/{photo_id}.jpg",
                    f"unseen-backend/v1/tickets/{sid}/{photo_id}.json",
                    f"unseen-backend/v1/uploads/{sid}/{photo_id}.bin",
                    f"unseen-backend/v1/commits/{sid}/{photo_id}.json",
                    f"unseen-backend/v1/slots/{sid}/{slot:02d}.json",
                ]
            )
        for object_key in keys:
            cleanup.delete(object_key)
            removed += 1
        print(json.dumps({"cleanup": True, "sid": sid, "deleteRequests": removed}))
