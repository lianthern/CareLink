# v9 P0：169MB 非 Google 完整 Meetingroom → 一次 7k 可走场景

人类状态页：[GitHub Issue #10](https://github.com/maxi-max-dev/max-agent-bridge/issues/10)

v8 的 Viewer 修复已经在 RTX 4060 真机全部通过；任务只因 Google Drive 返回 HTML 而停止，GPU 训练次数仍为 `0`。v9 不推倒重来，也不再下载 4.27GB 视频：保留 v8 Phase A 的 Viewer 改进，改用同一 Tanks and Temples Meetingroom 的 `169,378,633` bytes Hugging Face image set + 已有 COLMAP pose，直接完成完整房间 canary。

## 4060 Agent 唯一入口

Windows PowerShell：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-full-room-hf-lite-2026-09-03-v9" `
  -State "RECEIVED_VERIFIED" `
  -Message "v9 non-Google 169MB full-room continuation received; v8 Viewer fixes retained, production off."
```

然后完整阅读本文件、[`SOURCE-EVIDENCE.md`](SOURCE-EVIDENCE.md)、[`ACCEPTANCE.md`](ACCEPTANCE.md) 和 `TASK.json`，连续执行。Max 不需要手抄其余命令。

## 0. 继承 v8，不能回退

- v8 保持不可变 `BLOCKED` 历史，不改写、不删除。
- 复用 4060 当前已应用的 `unseen-v8-viewer-phase-a.patch`，先复跑 v8 的 24 个 Python test、legacy/new Chromium E2E；若本地 patch 丢失，从 v8 result 中恢复并重验。
- Viewer 继续具备滚轮/触控板/`+ −` 缩放、`30°–90°` FOV、照片机位/平视自由行走分离、scene-scale normal speed、`3×` sprint、零 roll、pitch clamp 和 camera convex-hull 边界。
- 工作根仍必须是 `/home/max/src/unseen-3dgs-sceneworker`。素材、训练、SOG 全写 WSL ext4，不在 Git checkout、iCloud 或 `/mnt/c` 训练。

## 1. 一键下载并准备（不启动 GPU）

确认没有 GPU job 后，在 Windows PowerShell 执行：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-full-room-hf-lite-2026-09-03-v9\inputs\scripts\windows\Start-V9MeetingroomLite.ps1" -ConfirmResearchCanary
```

这个冻结脚本：

- 只向 Hugging Face 发出站 HTTPS，不经过 Google；
- 在 WSL ext4 断点续传 `169,378,633` bytes 包并核 SHA256；
- 安全校验 tar members，拒绝绝对路径、`..`、symlink、hardlink 和额外文件；
- 验 `371` 张 `980×543` JPEG、`371/371` COLMAP 注册、单 `PINHOLE` camera 和 `124,162` points；
- 按 NerfBaselines 的真实实现生成与 `images_2` 匹配的 `sparse_2/0` 半分辨率 camera model；
- 不安装软件、不改防火墙、不开放端口、不上传、不触发训练。

输出固定在：

```text
/home/max/src/unseen-3dgs-sceneworker/data/tandt-meetingroom-v9/
  download/meetingroom_2down.tar.gz
  prepared/meetingroom/
    images_2/
    sparse/
    sparse_2/0/
    .prepared.json
```

下载失败保留 `.part` 供下次 resume；bytes/SHA/member 任一不符就 `BLOCKED`，不得换未知镜像或弱化校验。

## 2. 输入门：先证明完整覆盖

不要重跑 COLMAP。复用 v8 已实现的 coverage/report 代码读取冻结的 known-pose 模型，并把硬编码 `SIMPLE_RADIAL` 改成「本任务只接受单 `PINHOLE`」：

- 371/371 image 与 registered camera 必须一一对应；
- camera 尺寸必须和 JPEG 一致为 `980×543`；
- 12 个按文件名等分的 bin 都必须有相机；
- 重算 camera center、PCA、二维 convex hull、轨迹长度、平均 up、world-up 对齐、median eye height 和 P5/P95；
- `lambda2/lambda1 >= 0.15`，convex-hull area > 0，`trajectoryLength/hullDiameter >= 2.0`；
- 生成 12 格 contact sheet 和 camera footprint；逐格人工记录地面、墙面、立柱/门窗、灯/屋梁/天花板。至少 `8/12` 有地面且 `8/12` 有上墙或天花板。

Mac 的 0.456652 PCA 与接触表只作前置证据；4060 必须重算，不得抄成真机结果。输入门未过，不启动 GPU。

## 3. 只跑一次 7k

输入门全过后才提交 `RUNNING` receipt，并复用 v6 已验证的 regularized Splatfacto profile、COLMAP sparse points、camera optimizer off、单 GPU guard：

- data root：`data/tandt-meetingroom-v9/prepared/meetingroom`；
- images path：`images_2`；COLMAP path：`sparse_2/0`；
- scene/model/revision：`tandt-meetingroom-v9` / `tandt-meetingroom-v9` / `tandt-meetingroom-hf-r001`；
- 只允许一次 from-scratch 7k，终点 step `6999`；禁止 resume、15k、30k、自动降分辨率和第二次尝试；
- held-out 至少跨 12 bins，不用相邻帧高分冒充完整房间；
- 记录真实 wall time、峰值 VRAM、checkpoint SHA、OOM、mean/min PSNR、SSIM、LPIPS。

成功后只导出一次 PLY → SH2 SOG；SH2 真失败才可附证据回退 SH1。大文件全留 WSL ext4。

## 4. Viewer 与 Max 验收

生成 `viewer/tandt-meetingroom-v9.scene.json`，只监听 `127.0.0.1:8765–8775`。start pose 是平均 up 对齐后的 median-height 平视 walk pose，不是某张照片的倾斜姿态。边界来自二维 camera convex hull。

Viewer 必须提供：

- zoom、normal walk、sprint、look up；
- 至少 3 个分散的照片机位，精确恢复 XYZ/quaternion/FOV；
- 同一中心点 front/back/left/right/up/down 六方向；
- `direction-up.jpg` 能看见真实灯/屋梁/天花板，而非空洞；
- 10–20 秒、≤15MB 安全录屏，真实展示 zoom in/out → normal walk → sprint → look up。

完成后保持 Viewer 与现有 loopback intake 运行，Max 直接试。只有所有用户门通过才能写 `FULL_ROOM_CANARY_ACCEPTED`；否则写 `TECHNICAL_PASS_USER_GATE_FAIL` 或 `FAILED/BLOCKED`。

## 回传

```text
results/from-4060/unseen-3dgs-full-room-hf-lite-2026-09-03-v9/
  V9-REPORT.md
  V9-RESULT.json
  REPORT-FILES.json
  fixes/*.patch
  logs/（脱敏 source/coverage/train/SOG/Viewer 摘要）
  full-room-contact-sheet.jpg
  camera-footprint.png
  viewer-overview.png
  direction-front.jpg
  direction-back.jpg
  direction-left.jpg
  direction-right.jpg
  direction-up.jpg
  direction-down.jpg
  viewer-walkthrough-v9.mp4
```

只允许回传报告、脱敏日志、小尺寸截图和 ≤15MB Viewer 录屏。禁止回传 tar、371 张图、COLMAP bin、checkpoint、PLY、SOG、work、`.env`、token 或任何私密素材。生产 API/数据库/租约、付费 API、端口映射仍全部禁止。
