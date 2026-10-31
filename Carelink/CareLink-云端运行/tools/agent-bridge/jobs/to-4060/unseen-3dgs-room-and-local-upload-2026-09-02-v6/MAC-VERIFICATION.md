# v6 发布前验证（Mac）

时间：2026-09-02（Australia/Brisbane）

## 已通过

- `local_video_intake.py` 与测试文件：Python `py_compile` PASS。
- `python3 -W error::ResourceWarning -m unittest -v .../test_local_video_intake.py`：5 passed / 0 failed。
- 单测覆盖：loopback/无自动训练 health、CSRF、扩展名拒绝、`0.0.0.0` 拒绝、`/mnt/c` 拒绝、流式写入和本地 job 元数据。
- 真实 MP4 本机端到端：33,925,311 bytes；HTTP 201；ffprobe duration 24.933333s；上传与 metadata SHA256 一致；`trainingStarted=false`；状态为 `UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW`。
- `TASK.json`、`BRIDGE-STATUS.json` JSON parse PASS。
- TUM `fr1/room` 官方 URL HEAD：302 到 `webshare.cvg.cit.tum.de` 后 HTTP 200，`Content-Type: application/x-gzip`，`Content-Length: 782381450`，支持 byte ranges；内容 SHA 仍由 4060 完整下载后冻结。
- `python3 scripts/verify_bridge.py`：6 tasks，Bridge JSON 与禁止文件边界 PASS。
- `git diff --check` PASS。
- 预制场景/模型选型的 Dragnet QUICK audit pack：strict validation PASS（0 error / 0 warning）。

## 必须由 4060 真机完成

- PowerShell parser 与 Windows → WSL localhost forwarding：`PENDING_WINDOWS`。
- TUM `fr1/room` 下载 bytes/SHA、adapter gate、7k 时间/峰值 VRAM/metrics：`PENDING_4060`。
- 本轮 PLY、SOG、Viewer E2E 和 browser screenshots：`PENDING_4060`。
- Max 自己的视频：`NOT_UPLOADED`；上传页完成后由 Max 在 4060 本机选择，当前不自动训练。

Mac 验证不能替代 RTX 4060/CUDA 实测，以上 PENDING 字段不得预填。
