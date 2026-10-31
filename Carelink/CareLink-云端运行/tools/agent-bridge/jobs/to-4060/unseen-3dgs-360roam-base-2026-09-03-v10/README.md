# v10 P0：真实移动 360 全景 → 可走室内 3DGS

人类状态页：[GitHub Issue #11](https://github.com/maxi-max-dev/max-agent-bridge/issues/11)

这次纠正输入方向：v9 是普通透视照片，v10 首次使用真实 360° 室内移动采集。目标是在 RTX 4060 上把 HKUST 360Roam 的 `base` 开放式创新/办公空间做成可缩放、可平视行走、能看完整天花板和地面的 `scene.sog`。本轮不做照片回位。

必须如实区分：作者发布的是沿移动路径采样的 `6080×3040` 全景 JPEG 序列和逐帧位姿，不是一个原始 MP4 文件。它在几何上等价于已经抽帧并解出位姿的移动 360 视频，适合先隔离验证「360 输入能否得到可走空间」；它不等于已经打通 Max 未来的 X6 原始 MP4 入口。

## 4060 Agent 唯一入口

Windows PowerShell：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-360roam-base-2026-09-03-v10" `
  -State "RECEIVED_VERIFIED" `
  -Message "v10 real moving 360 panorama canary received; production off; no source redistribution."
```

然后完整阅读本文件、[`SOURCE-EVIDENCE.md`](SOURCE-EVIDENCE.md)、[`ACCEPTANCE.md`](ACCEPTANCE.md)、[`MAC-VERIFICATION.md`](MAC-VERIFICATION.md)、`TASK.json` 和 `STATUS.json`，连续执行。Max 不需要再抄命令或搬素材。

## 0. 保留已有成果，不能误报

- v9 是已完成的普通透视 Meetingroom 对照组，保持不可变，不覆盖它的 checkpoint、PLY、SOG、Viewer 或报告。
- v10 复用 v9 已通过的 Nerfstudio 1.1.5 / Splatfacto、SOG 工具和 Viewer 修复，不从零搭流水线。
- v10 新增的是 360 输入适配：每个 2:1 全景生成 8 个水平重叠视角和 `up/down` 两个视角，所有虚拟视角共享原全景的相机中心。
- 不下载、不读取作者的 `scene.ply`；本轮 Splatfacto 明确 `random-init=True`、`load-3D-points=False`。
- 所有未在 4060 实测的训练时间、VRAM、PSNR、SSIM、LPIPS、Gaussian 数、SOG 大小和浏览器 FPS 必须保持 `null/PENDING_4060`。

## 1. 素材与下载

来源是作者公开的 [360Roam 项目页](https://huajianup.github.io/research/360Roam/) 和 [Synology 数据分享](https://hkust-vgd.nas.ust.hk:5001/sharing/LSeTZWca6) 中的 `base` 场景。

完整场景有 198 张、约 2.23GB。v10 冻结端点覆盖的 50 张训练全景和 10 张留出全景，总计 `674,276,821` bytes；每张的 path、bytes 和 SHA256 都在 `inputs/source-manifest.json`。脚本逐文件出站 HTTPS 下载，`.part` 支持断点续传，已完成且 hash 正确的文件自动跳过。

数据页没有发布明确的数据许可证。因此只能从作者站点直接下载到 Max 自有 4060，做本地非商业研究/个人实验；不得把源图、位姿或派生训练资产重新上传 GitHub、iCloud、云盘或生产环境。

## 2. 准备输入（无 GPU）

工作根必须继续是 WSL ext4：

```text
/home/max/src/unseen-3dgs-sceneworker
```

禁止在 Git checkout、iCloud、`C:`、`D:` 或 `/mnt/c` 上训练。先确认至少 6GiB WSL ext4 空间，并且当前没有 GPU job。在 Windows PowerShell 执行：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-360roam-base-2026-09-03-v10\inputs\scripts\windows\Start-V10-360Roam.ps1" `
  -ConfirmResearchCanary
```

这一步会：

1. 登录无需账号/密码的作者公开 share；
2. 校验远端 198 文件清单和冻结的 60 文件 bytes；
3. 断点下载并逐文件核 SHA256；
4. 校验 `pose_c2w.json` 的 148 train + 50 test、4×4 位姿和旋转；
5. 用 FFmpeg `v360` 生成 600 张 `1024×1024`、100° FOV 的重叠透视图；
6. 写出 Nerfstudio `transforms.json`，固定 500 train + 100 val；
7. 证明同一全景的 10 个虚拟视角位置完全一致。

输出：

```text
/home/max/src/unseen-3dgs-sceneworker/data/360roam-base-v10/
  download/pose_c2w.json
  download/panos/*.jpg
  download/download-manifest.lock.json
  prepared/base-erp10/
    images/*.jpg
    transforms.json
    .prepared.json
```

准备脚本不安装软件、不启动 GPU、不开放端口、不上传、不接生产。

## 3. GPU 前人工门

4060 Agent 必须先生成覆盖 12 个路径段的源全景 contact sheet、同一采样位的十视角 contact sheet，以及 camera footprint。人工确认：

- 至少 10/12 路径段同时看见可辨认的室内结构和地面；
- 至少 10/12 路径段看见上墙、灯、梁或天花板；
- `up` 与 `down` 不是黑洞、空白或错误翻转；
- footprint 不是单点，也不是纯原地旋转；
- Nerfstudio dataparser 实际读到 500 train + 100 val，全部 pinhole 相机，位置范围非零。

任一失败就 `BLOCKED`，不启动训练。

## 4. 先跑一次 7k preview

GPU 前门全过后提交 `RUNNING` receipt，再执行：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-360roam-base-2026-09-03-v10\inputs\scripts\windows\Start-V10-360Roam.ps1" `
  -ConfirmResearchCanary -RunPreview -ConfirmGpuPreview
```

准备步骤是幂等的；GPU 脚本有单任务 guard 和 attempt marker，只允许一次 from-scratch 7k。它使用：

- `splatfacto`、scale regularization、camera optimizer off；
- 作者位姿 + 我们生成的重叠 pinhole 视图；
- `random-init=True`、`load-3D-points=False`；
- 500 train、100 held-out；
- step `6999` 为 preview 终点。

不能因结果差就暗中换作者 PLY、重跑一次或抄 v9 指标。

## 5. 7k 后先验收，再决定 30k

7k 成功后沿用 v9 export/SOG/Viewer 实现，生成独立的 `360roam-base-v10.scene.json`，只绑定 `127.0.0.1:8765–8775`。先完成 7k 的六方向、两轴行走和用户视觉门：

- zoom in/out；
- normal walk 与 3× sprint；
- level start、零 roll、移动不改变眼高；
- 同一中心 front/back/left/right/up/down 都有室内内容；
- 能沿相机 footprint 的两个方向走动，不是平面贴图推拉；
- 10–20 秒、≤15MB 录屏展示 zoom → walk → sprint → look up/down。

只有 7k 训练成功、无 OOM、SOG roundtrip 通过、六方向和两轴行走都通过时，才允许从同一 checkpoint 继续到 30k。30k 只能是一次 continuation，不得重新 from scratch；若 7k 用户门失败，停止并报告，不拿更长训练掩盖输入/位姿错误。

## 6. 回传

```text
results/from-4060/unseen-3dgs-360roam-base-2026-09-03-v10/
  V10-REPORT.md
  V10-RESULT.json
  REPORT-FILES.json
  fixes/*.patch
  logs/（脱敏 source/adapter/dataparser/train/export/viewer 摘要）
  source-contact-sheet.jpg
  ten-view-contact-sheet.jpg
  camera-footprint.png
  viewer-overview.png
  direction-front.jpg
  direction-back.jpg
  direction-left.jpg
  direction-right.jpg
  direction-up.jpg
  direction-down.jpg
  viewer-walkthrough-v10.mp4
```

只回传报告、代码 patch、脱敏日志、小图和 ≤15MB 录屏。禁止回传 360 源图、位姿 JSON、600 张训练图、checkpoint、PLY、SOG、work、`.env`、token 或桌面隐私内容。照片回位明确不在 v10 范围。

最终只能写 `PANORAMIC_CANARY_ACCEPTED_7K`、`PANORAMIC_CANARY_ACCEPTED_30K`、`TECHNICAL_PASS_USER_GATE_FAIL`、`FAILED` 或 `BLOCKED`。
