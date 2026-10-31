#!/usr/bin/env python3
"""Read-only audit of the current mini-program server-domain allowlists.

The AppSecret is read locally and is never printed.  This script calls only
official WeChat read APIs; it cannot change the mini-program configuration.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
import urllib.parse
import urllib.request


DEFAULT_CONFIG = pathlib.Path("/Users/max/.config/psm/wechat.json")
DEFAULT_OSS = "https://psm-advx-2026.oss-cn-hangzhou.aliyuncs.com"


def normalized(values):
    return {str(value).strip().rstrip("/") for value in (values or []) if str(value).strip()}


def assess_domains(payload, required):
    configured = {
        "request": normalized(payload.get("requestdomain")),
        "upload": normalized(payload.get("uploaddomain")),
        "download": normalized(payload.get("downloaddomain")),
    }
    missing = {
        kind: sorted(normalized(required.get(kind)) - configured[kind])
        for kind in configured
    }
    return {
        "ok": all(not values for values in missing.values()),
        "configured": {kind: sorted(values) for kind, values in configured.items()},
        "missing": missing,
    }


def request_json(url, *, body=None, timeout=20):
    data = None if body is None else json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def fetch_domain_info(config_path):
    with config_path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    appid = str(config.get("appid") or "").strip()
    secret = str(config.get("secret") or "").strip()
    if not appid or not secret:
        raise RuntimeError("微信配置缺少 appid 或 secret")

    token_query = urllib.parse.urlencode(
        {"grant_type": "client_credential", "appid": appid, "secret": secret}
    )
    token_payload = request_json("https://api.weixin.qq.com/cgi-bin/token?" + token_query)
    token = token_payload.get("access_token")
    if not token:
        raise RuntimeError("微信 access_token 获取失败：" + str(token_payload.get("errmsg") or token_payload))

    url = (
        "https://api.weixin.qq.com/wxa/getwxadevinfo?access_token="
        + urllib.parse.quote(str(token), safe="")
    )
    payload = request_json(url, body={})
    if int(payload.get("errcode") or 0) != 0:
        raise RuntimeError("微信域名读取失败：" + str(payload.get("errmsg") or payload))
    return appid, payload


def parser():
    result = argparse.ArgumentParser(description="只读检查微信小程序服务器合法域名")
    result.add_argument("--config", type=pathlib.Path, default=DEFAULT_CONFIG)
    result.add_argument("--require-request", action="append", default=[])
    result.add_argument("--require-upload", action="append", default=[])
    result.add_argument("--require-download", action="append", default=[])
    result.add_argument("--json", action="store_true", dest="as_json")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    required = {
        "request": args.require_request or [DEFAULT_OSS],
        "upload": args.require_upload or [DEFAULT_OSS],
        "download": args.require_download or [DEFAULT_OSS],
    }
    try:
        appid, payload = fetch_domain_info(args.config)
        result = assess_domains(payload, required)
    except Exception as error:
        print(f"❌ {error}", file=sys.stderr)
        return 3

    output = {"appid": appid, **result}
    if args.as_json:
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        print(f"AppID: {appid}")
        for kind in ("request", "upload", "download"):
            print(f"{kind}: {', '.join(result['configured'][kind]) or '(空)'}")
            if result["missing"][kind]:
                print(f"  缺少: {', '.join(result['missing'][kind])}")
        print("✅ 合法域名齐全" if result["ok"] else "❌ 合法域名尚未配置完整")
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
