#!/usr/bin/env python3

from check_wechat_domains import assess_domains


def main():
    oss = "https://psm-advx-2026.oss-cn-hangzhou.aliyuncs.com"
    api = "https://example.service.tcloudbase.com"
    required = {"request": [oss, api], "upload": [oss], "download": [oss]}

    empty = assess_domains({}, required)
    assert not empty["ok"]
    assert empty["missing"]["request"] == sorted([api, oss])

    complete = assess_domains(
        {
            "requestdomain": [oss + "/", api],
            "uploaddomain": [oss],
            "downloaddomain": [oss],
        },
        required,
    )
    assert complete["ok"]
    assert complete["missing"] == {"request": [], "upload": [], "download": []}
    print("✅ 微信合法域名只读检查器纯函数测试通过")


if __name__ == "__main__":
    main()
