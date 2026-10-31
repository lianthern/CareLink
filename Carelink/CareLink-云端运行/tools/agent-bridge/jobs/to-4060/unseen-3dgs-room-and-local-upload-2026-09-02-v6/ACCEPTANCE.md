# v6 Mac 验收

验收时间：2026-09-03

结论：**ACCEPTED_PREVIEW**

v6 已证明 RTX 4060 Laptop 可以在一次 7k 训练内生成更大室内空间的真实 SOG，并在仅回环地址的 Viewer 中行走；本机视频上传入口也已运行。该结论是工程 preview 通过，不代表画质达到最终产品或真实生产 Worker 已接通。

## 通过项

- 权威结果提交：`2dfcc31`；最终 `COMPLETED` 回执：`a02da37`。
- TUM `freiburg1/room`：120 个唯一帧，覆盖有效 RGB/depth/pose 重叠区间的 99.9816%，adapter gate 通过。
- `splatfacto` 标准 known-pose profile：仅 1 次 7k，270 秒，退出码 0，无 OOM，峰值显存 4,843 MiB；30k 为 0 次。
- 三锚点均通过 PSNR ≥18、SSIM ≥0.70、LPIPS ≤0.40；平均为 PSNR 21.808、SSIM 0.7685、LPIPS 0.2466。
- 真实产物：871,919 Gaussians；PLY 216,237,505 bytes，SOG 12,907,517 bytes。二者未上传 GitHub，只保留本机 SHA256 证据。
- Room Viewer：`http://127.0.0.1:8765/?scene=./tum-room-v6.scene.json`，`SOG ready`，有界移动和三照片锚点完整位姿恢复通过。
- 本机上传：`http://127.0.0.1:8780/`，Windows/WSL HTTP 200，只绑定 `127.0.0.1`，MP4/MOV，`trainingStartsAutomatically=false`。
- 计数边界：私密视频上传 0、生产连接 0、GitHub 禁止文件 0。
- 回传截图与结构化日志一致；Viewer 画面可辨识房间、桌面和柜体，上传页可见且未选择文件。

## Mac 侧复验

- Bridge JSON/敏感后缀检查通过。
- 25 个回传文件全部存在且没有清单外文件。
- v5 基线补丁后，v6 patch 可干净应用；本机重跑 intake 5/5、safe-extract 3/3、Viewer generator 2/2，Bash/Node/Python 语法通过。
- adapter 单测依赖 `plyfile`，Mac 当前环境未安装；该项以 4060 的 6/6 日志和 adapter gate 结构化证据验收，不冒充 Mac 已复跑。
- PowerShell parser 与 Windows 双端 HTTP 只能由 4060 实测；回传分别为 0 errors 与 200/200。

## 验收时修复

初始 `REPORT-FILES.json` 有四个文本文件按 Windows 工作树换行计算 SHA，push 后 Git 将其规范为 LF，导致 Mac 重算不匹配。验收端已将清单改为 GitHub 权威 blob 的字节数和 SHA；内容未改。PR #7 已合并为 `fbc523d`，以后固定输入强制 LF，并由 Bridge 逐文件检查 bytes/SHA，避免同类问题再次发生。

## 保留限制

- 这是 7k/SH1 的较大房间 preview：空间可走且可辨认，但截图仍有明显模糊、漂浮和物体融合，不是漂亮教室或生产画质。
- 两个 URL 只能在这台 4060 Windows 上打开；进程或电脑重启后可能需要重新启动服务。
- 上传视频只做 WSL ext4 落盘与校验，不会自动训练。为 Max 自己的视频生成场景需要另行明确启动一次 preview。
- GitHub 仍只是交接控制面；香港生产任务租约、长任务 heartbeat、素材下载和 SOG 上传没有启用。
