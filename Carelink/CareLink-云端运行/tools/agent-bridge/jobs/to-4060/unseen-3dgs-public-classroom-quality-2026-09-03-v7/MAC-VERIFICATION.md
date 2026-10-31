# v7 Mac 交付验证

验证时间：2026-09-03

## PASS

- Bridge `TASK.json`/schema/禁止后缀/大文件边界：`PASS`（7 个 task）。
- `TASK.json` 与 `BRIDGE-STATUS.json` JSON 解析：`PASS`。
- v6 intake 单测：`5/5 PASS`。
- 冻结 Pexels 教室视频真实 loopback 上传烟测：HTTP `201`，`12,273,501` bytes，SHA256 `b4dca2e138b475d5168bde72e61fe54beab9820b90aca1b22a4fe3739ea04ce6`，时长 `17.884533s`，状态 `UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW`，`trainingStarted=false`。
- 上传烟测 bind 为 `127.0.0.1:8788`，没有生产连接。
- Mac COLMAP 4.1.1 CPU exhaustive 预检：教室 `105/105` 注册，学校走廊反例 `2/110`。
- Dragnet QUICK 审计包 strict validator：`PASS`，0 errors / 0 warnings。

## PENDING_WINDOWS / PENDING_4060

- `Submit-V7PublicClassroom.ps1` Windows PowerShell parser：`PENDING_WINDOWS`（Mac 没有 `powershell`/`pwsh`）。
- Windows 真实下载、loopback 上传和 WSL ext4 落盘：`PENDING_WINDOWS`。
- RTX 4060 的 SfM 复现、7k/15k/条件式 30k、VRAM、耗时、PLY/SOG 和 Viewer 画质：`PENDING_4060`。
- 三张照片完整位姿/FOV 回位：`PENDING_4060`。

Mac 烟测产生的公开视频副本与 intake 副本仅在本地非 Git 的 `work/unseen-v7-preflight/` 中，未进入 Bridge 仓库。
