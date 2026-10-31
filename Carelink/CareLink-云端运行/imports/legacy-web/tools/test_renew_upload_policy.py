#!/usr/bin/env python3
"""Pure tests for renew_upload_policy.py; no network and no credentials."""

from __future__ import annotations

import copy
import importlib.util
import pathlib
import sys


MODULE_PATH = pathlib.Path(__file__).with_name("renew_upload_policy.py")
SPEC = importlib.util.spec_from_file_location("renew_upload_policy", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def fixture():
    return {
        "id": "demo1",
        "published": True,
        "nodes": [{"id": "n1"}],
        "collection": {"status": "open"},
        "capacity": {"full": False},
        "photos": [{"id": "keep-me"}],
        "upload": {
            "enabled": True,
            "keyPrefix": "spaces/demo1/inbox-v2/g3/",
            "expiresAt": 10,
            "maxSize": 12 * 1024 * 1024,
        },
    }


def fake_policy(prefix, ttl, max_size):
    assert prefix == "spaces/demo1/inbox-v2/g3/"
    assert ttl == 3600
    return {
        "host": "https://example.invalid",
        "policy": "redacted",
        "signature": "redacted",
        "keyPrefix": prefix,
        "expiresAt": 4600,
        "maxSize": max_size,
    }


def expect_error(mutator, contains):
    data = fixture()
    mutator(data)
    try:
        MODULE.build_plan(data, "demo1", 3600, fake_policy, now=1000)
    except MODULE.RenewalError as exc:
        assert contains in str(exc), str(exc)
    else:
        raise AssertionError(f"expected RenewalError containing {contains!r}")


def main():
    original = fixture()
    before = copy.deepcopy(original)
    plan = MODULE.build_plan(original, "demo1", 3600, fake_policy, now=1000)
    assert original == before, "planner must not mutate the source manifest"
    assert plan.manifest["photos"] == before["photos"], "content must be preserved"
    assert plan.manifest["upload"]["enabled"] is True
    assert plan.new_expires_at == 4600
    assert plan.manifest["uploadPolicyRefreshedAt"] == 1000
    assert MODULE._content_projection(plan.manifest) == MODULE._content_projection(before)

    expect_error(lambda d: d.update({"collection": {"status": "closed"}}), "不是 open")
    expect_error(lambda d: d.update({"nodes": []}), "没有公开节点")
    expect_error(lambda d: d.update({"capacity": {"full": True}}), "容量已满")
    expect_error(lambda d: d["upload"].update({"keyPrefix": "spaces/other/inbox-v2/g1/"}), "不安全")
    expect_error(lambda d: d["upload"].update({"maxSize": 50 * 1024 * 1024}), "超出安全范围")
    print("✅ 上传许可续签纯函数测试通过：内容不变、边界 fail closed")


if __name__ == "__main__":
    main()
