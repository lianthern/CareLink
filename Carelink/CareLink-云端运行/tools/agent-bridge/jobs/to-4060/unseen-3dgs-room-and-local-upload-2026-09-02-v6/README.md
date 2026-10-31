# v6 P0：较大 room 场景 + 4060 本机视频入口

> **2026-09-02 同步收尾：** Max 已报告 4060 本机 v6 完成，但 GitHub 尚无任何 v6 receipt/result。不得重跑训练或重新安装；立即执行 [`SYNC-ONLY-RETURN.md`](SYNC-ONLY-RETURN.md)，只把现有报告、摘要日志、截图和回执推回 GitHub。

人类状态页：[GitHub Issue #6](https://github.com/maxi-max-dev/max-agent-bridge/issues/6)

## 本轮完成定义

在 v5 已通过并仍保留的环境上完成两件互不冒充的事：

1. 用 TUM RGB-D `freiburg1/room` 跑一次且仅一次 7k preview，得到较大室内场景的真实 `scene.sog`，接入现有 Viewer 并在 Windows 本机浏览器打开。
2. 安装本任务已经实现的本机视频上传页，绑定 `127.0.0.1`，让 Max 以后直接在 4060 的 Windows 浏览器选择 MP4/MOV；视频流式写入 WSL ext4，只做校验，不自动训练。

模型已冻结在 [`MODEL-PROFILE.md`](MODEL-PROFILE.md)。不要再比较或切换模型。`splatfacto` 标准版是当前真实跑通的基线；本轮只改善场景覆盖和用户输入。

完成本任务仍不代表生产接入：GitHub 是控制面，香港生产 API/数据库/租约/token 全部不接触。

## 4060 Agent 唯一入口

在现有 Windows PowerShell Bridge checkout 中执行：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-room-and-local-upload-2026-09-02-v6" `
  -State "RECEIVED_VERIFIED" `
  -Message "v6 room fixture and loopback-only local video intake received; one 7k preview maximum, no production and no private upload to GitHub."
```

随后完整阅读本文件和 `MODEL-PROFILE.md`。工作目录仍是：

```text
/home/max/src/unseen-3dgs-sceneworker
```

不得重新下载 v1 Release，不得删除/覆盖 v1-v5 artifact；新输出全部使用 `v6` 路径和 sceneRevisionId。

## Phase A：安装已实现的本机上传入口

不要重写 `local_video_intake.py`。先把本任务中的冻结输入复制到 WSL 项目：

```powershell
$JobRoot = "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-room-and-local-upload-2026-09-02-v6\inputs"
$WslProject = "\\wsl.localhost\Ubuntu-22.04\home\max\src\unseen-3dgs-sceneworker"
New-Item -ItemType Directory -Force "$WslProject\scripts\windows", "$WslProject\tests" | Out-Null
Copy-Item "$JobRoot\scripts\local_video_intake.py" "$WslProject\scripts\local_video_intake.py" -Force
Copy-Item "$JobRoot\tests\test_local_video_intake.py" "$WslProject\tests\test_local_video_intake.py" -Force
Copy-Item "$JobRoot\scripts\windows\Start-Local-VideoIntake.ps1" "$WslProject\scripts\windows\Start-Local-VideoIntake.ps1" -Force
Copy-Item "$JobRoot\scripts\windows\Stop-Local-VideoIntake.ps1" "$WslProject\scripts\windows\Stop-Local-VideoIntake.ps1" -Force
```

输入 hash 必须匹配 `TASK.json.inputs`。然后验证：

- Python `py_compile`；
- `python3 -m unittest -v tests/test_local_video_intake.py`，预期 5/5；
- 两份 PowerShell 用 `[System.Management.Automation.Language.Parser]::ParseFile(...)` 解析，错误数为 0；
- 禁止关键字检查证明没有 `New-NetFirewallRule`、`netsh`、`portproxy` 或 `0.0.0.0` 的可执行绑定；测试断言字符串不算违规实现；
- `ffprobe` 存在。

启动并打开浏览器：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$WslProject\scripts\windows\Start-Local-VideoIntake.ps1" -OpenBrowser
```

必须验证：

- WSL 和 Windows 的 `http://127.0.0.1:<actual-port>/api/health` 都返回 200；
- `bindAddress` 精确为 `127.0.0.1`；
- `trainingStartsAutomatically` 为 `false`；
- 页面在 Windows 默认浏览器打开；
- 实际端口只可为 `8780`–`8789`；
- 不改 Windows Firewall、不做 `portproxy`、不监听局域网或公网。

任务结束时上传页保持运行。Max 只需回到这台 4060，在页面里选视频；无需手抄 WSL 命令。本轮不得替 Max 选择或上传私密视频。

## Phase B：较大预制 room scene

### 1. 冻结现状

- 确认没有其他 `ns-train`、COLMAP、PLY/SOG 转换或 GPU job 正在运行；一次只跑一个 GPU job。
- 记录 `nvidia-smi` 和 WSL ext4 剩余空间；不得在 `/mnt/c` 或 iCloud 路径下载、解压、训练。
- v5 Pexels Viewer 可继续占用 `8765`；不要覆盖它的 SOG、manifest 或 server state。

### 2. 官方素材

只从 TUM 官方 HTTPS 下载：

```text
https://cvg.cit.tum.de/rgbd/dataset/freiburg1/rgbd_dataset_freiburg1_room.tgz
```

要求：

- 下载到 `data/tum-room-v6/download/*.part`，HTTP 成功后再原子改名；支持重试/续传。
- 记录最终 URL、响应头中可得的长度、实际 bytes、SHA256；未预先公布的 SHA 不得伪造为 pinned。
- 解压前拒绝绝对路径、`..`、symlink/hardlink 逃逸；解压到 WSL ext4 的 `data/tum-room-v6/raw/`。
- 必须存在 `rgb.txt`、`depth.txt`、`groundtruth.txt`，并在报告中保留 TUM RGB-D attribution 与 CC BY 4.0 官方链接。
- 原 TGZ、RGB、depth 不进入 GitHub。

官方页面把 `fr1/room` 标为 48.90 秒、15.989 米轨迹、约 0.83GB。下载结果与此显著不符时停止，不训练。

### 3. 复用并小幅泛化 v4 known-pose adapter

复用已整合的 `scripts/tum_v4_adapter.py`，只做向后兼容的参数化：

- 新增真实 CLI：`--sample-hz`（float，默认 5.0）、`--max-frames`（int，默认 120）、`--seed`（int，默认 20260902）；
- 所有采样、帧上限、点云抽样和 manifest 字段读取参数值，不能只在 `--help` 中摆设；
- v4 原命令不带新参数时输出必须保持兼容；
- v6 使用 `--sample-hz 2.5 --max-frames 120 --seed 20260902`，目标是覆盖完整 48.9 秒，而不是以 5Hz 只截前半段；
- fr1 标定继续使用已验证的 `fx=fy=525, cx=319.5, cy=239.5` 和预配准 RGB-D，不得套用 fr3 标定；
- 输出只写到 `data/tum-room-v6/processed/room-2.5hz`，拒绝覆盖已有目录。

adapter gate 至少包括：120 个唯一 RGB、全程时间覆盖、RGB/depth/pose 时间差、旋转正交/行列式、三锚点投影 roundtrip、正深度、200k 有界彩色 seed、训练/评估拆分。任一失败，不启动 GPU。

同时把 `evaluate_tum_v4.py` 和 `generate_tum_v4_viewer.py` 泛化为可传 anchors、sceneRevisionId、name 和 asset URL；保留 v4 默认值。v6 anchors 取首/中/末真实帧，不得把硬编码 `frame_00050`/`frame_00099` 冒充中末帧。

### 4. 只跑一次 7k

创建独立 `scripts/run_tum_room_v6_train.sh`，参数与 `MODEL-PROFILE.md` 完全一致，数据目录为 v6，实验名为 `tum-freiburg1-room-v6`。要求：

- output 已存在就拒绝第二次训练；
- `nvidia-smi` 500ms 采样并记录峰值 VRAM；
- OOM 时只允许记录失败并停止，禁止自动降配置后再开第二次；
- 本任务 `maxNewPreview7000Runs=1`，`maxQuality30000Runs=0`；
- 训练后从真实 checkpoint 在首/中/末三锚点评估，保存 metrics 和渲染摘要；阈值沿用 v4（PSNR ≥18、SSIM ≥0.70、LPIPS ≤0.40），不达标仍如实回传，不可补跑。

### 5. PLY → SOG → Viewer

- 复用现有 export/SOG 工具，从本轮真实 checkpoint 生成 v6 raw PLY 和 `scene.sog`；记录 bytes/SHA256，文件留在 4060 WSL ext4。
- 生成 `tum-room-v6.scene.json`，sceneRevisionId 为 `tum-freiburg1-room-v6-r001`，导航边界来自本轮真实训练相机；不能手写虚构坐标。
- 将 SOG 以本地 copy/reflink 放入 Viewer assets，不提交 GitHub。
- 优先复用仍运行的 v5 HTTP server，在 Windows 打开：

```text
http://127.0.0.1:8765/?scene=./tum-room-v6.scene.json
```

若 v5 server 已停，只能绑定 `127.0.0.1` 并使用 `8765`–`8775`；禁止扩大监听。
- 浏览器 E2E 必须验证 `SOG ready`、首/中/末 photo anchor、自由移动、边界约束、完整 Y 恢复和无控制台错误。浏览器 FPS 只记录为样本，不宣传为稳定 benchmark。

## 回传

```text
results/from-4060/unseen-3dgs-room-and-local-upload-2026-09-02-v6/
  V6-REPORT.md
  V6-RESULT.json
  REPORT-FILES.json
  fixes/*.patch
  logs/（静态检查、单测、下载冻结、adapter gate、训练、评估、SOG、Viewer E2E、intake health）
  viewer-screenshot.png
  intake-screenshot.png
```

`V6-RESULT.json` 至少记录：

- 上传入口：输入文件 hash、5 个测试、PowerShell parse、actual URL/port/PID、WSL/Windows HTTP、浏览器打开、bind、auto-train=false；
- fixture：官方最终 URL、TGZ bytes/SHA、frame/time coverage、adapter gate、一次 7k wall time/退出码/峰值 VRAM、checkpoint metrics、PLY/SOG bytes/SHA、Viewer URL/E2E；
- 计数：7k 次数、30k 次数、用户私密视频上传次数、生产连接次数、禁止文件计数；
- 所有未测值为 `null`/`PENDING`，禁止填 0 冒充实测。

只回传补丁、报告、摘要日志和两张不含隐私的截图。严禁回传 TGZ、RGB、depth、视频、frames、SOG、PLY、checkpoint、完整 work、`.env` 或 token。

完成回执必须给出：`V6-REPORT.md`、实际 room Viewer URL、实际本机上传 URL，以及两项 server 是否仍在运行。

## 硬边界

- 不接生产 API/数据库/租约，不创建生产任务，不写 vault，不部署，不用付费 API。
- 不自动训练 Max 上传的视频；上传成功只到 `UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW`。
- 不开放公网/局域网端口，不改防火墙/路由器/端口映射。
- 不删除或覆盖 v1-v5 artifact。
- 不伪造 CUDA、4060 时间、VRAM、PLY/SOG、锚点、FPS 或视觉质量。
