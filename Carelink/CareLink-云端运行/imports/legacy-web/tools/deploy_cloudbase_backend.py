#!/usr/bin/env python3
"""Deploy the UNSEEN CloudBase function without persisting credentials.

The committed CloudBase config contains environment placeholders only. This
wrapper reads the existing local OSS credential file, derives independent
service secrets in memory, and passes them to the CloudBase CLI process.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CREDENTIALS = Path("/Users/max/.config/psm/aliyun.json")
DEFAULT_ENV_ID = "unseen-d3gtp0sxh53bbef61"
DEFAULT_WEB_ORIGIN = "https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com"
PLACEHOLDER_API = "https://unseen-api.invalid"


def _derive(master: str, purpose: str) -> str:
    return hmac.new(master.encode("utf-8"), purpose.encode("utf-8"), hashlib.sha256).hexdigest()


def _credentials(path: Path) -> dict[str, str]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    required = ("bucket", "region", "accessKeyId", "accessKeySecret")
    missing = [name for name in required if not str(raw.get(name, "")).strip()]
    if missing:
        raise SystemExit("OSS credential file is missing: " + ", ".join(missing))
    return {name: str(raw[name]).strip() for name in required}


def build_env(args: argparse.Namespace) -> dict[str, str]:
    credential = _credentials(args.credentials)
    region = credential["region"].removeprefix("oss-")
    endpoint = "oss-" + region + ".aliyuncs.com"
    bucket = credential["bucket"]
    master = credential["accessKeySecret"]
    env = os.environ.copy()
    env.update(
        {
            "UNSEEN_TCB_ENV_ID": args.env_id,
            "UNSEEN_OSS_BUCKET": bucket,
            "UNSEEN_OSS_ENDPOINT": endpoint,
            "UNSEEN_OSS_PUBLIC_BASE": f"https://{bucket}.{endpoint}",
            "UNSEEN_OSS_ACCESS_KEY_ID": credential["accessKeyId"],
            "UNSEEN_OSS_ACCESS_KEY_SECRET": master,
            "UNSEEN_TOKEN_SECRET": _derive(master, "unseen-backend/token/v1"),
            "UNSEEN_SPACE_ID_SECRET": _derive(master, "unseen-backend/space-id/v1"),
            "UNSEEN_HOST_KEY_SECRET": _derive(master, "unseen-backend/host-key/v1"),
            "UNSEEN_RATE_LIMIT_SECRET": _derive(master, "unseen-backend/rate-limit/v1"),
            "UNSEEN_MAINTENANCE_TOKEN": _derive(master, "unseen-backend/maintenance/v1"),
            "UNSEEN_PUBLIC_API_URL": args.api_url,
            "UNSEEN_CORS_ORIGINS": ",".join(args.cors_origin),
        }
    )
    return env


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials", type=Path, default=DEFAULT_CREDENTIALS)
    parser.add_argument("--env-id", default=DEFAULT_ENV_ID)
    parser.add_argument("--api-url", default=PLACEHOLDER_API)
    parser.add_argument("--cors-origin", action="append", default=[])
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    if not args.cors_origin:
        args.cors_origin = [DEFAULT_WEB_ORIGIN]
    if not args.api_url.startswith("https://"):
        raise SystemExit("--api-url must be HTTPS")
    command = [
        "tcb", "--config-file", str(ROOT / "cloudbaserc.json"),
        "fn", "deploy", "unseenBackend", "--json",
    ]
    if args.force:
        command.append("--force")
    completed = subprocess.run(command, cwd=ROOT, env=build_env(args), check=False)
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
