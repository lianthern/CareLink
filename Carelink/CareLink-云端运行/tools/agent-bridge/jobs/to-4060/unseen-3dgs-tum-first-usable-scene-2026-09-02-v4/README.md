# v4 P0：第一份可用场景＋照片回位

目标不是先解决任意手机视频，而是尽快证明一份低精度场景能够：**看得懂、能小范围移动、能让一张照片回到真实拍摄视角。**

素材：TUM RGB-D `freiburg1/desk`。它提供 RGB、depth、时间戳 ground-truth pose 与标定，可绕过 v1/v2 已证失败的 Pexels COLMAP 内参。

人类状态页：[GitHub Issue #4](https://github.com/maxi-max-dev/max-agent-bridge/issues/4)

## 4060 Agent 唯一入口

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-tum-first-usable-scene-2026-09-02-v4" `
  -State "RECEIVED_VERIFIED" `
  -Message "v4 P0 known-pose TUM scene received; v3 remains deferred and no parallel GPU job will run."
```

随后在 WSL 项目 `/home/max/src/unseen-3dgs-sceneworker` 工作。现有 CUDA/Nerfstudio/gsplat/SOG 环境直接复用。

## 时间盒

- 下载、校验、解压：目标 `15–30` 分钟；
- TUM→Nerfstudio adapter、坐标与 depth seed 验证：目标 `30–60` 分钟；
- 唯一一次 preview 7k＋PLY/SOG：目标 `15–30` 分钟；
- Viewer、照片回位和报告：目标 `30–60` 分钟。

时间盒是进度预期，不是伪造保证。任一步超过上限时先提交 `RUNNING` 或 `BLOCKED`，说明真实卡点，不静默扩张工作。

## 1. 下载与冻结

官方 URL：

```text
https://cvg.cit.tum.de/rgbd/dataset/freiburg1/rgbd_dataset_freiburg1_desk.tgz
```

Mac 端在 `2026-09-02T05:32Z` 只读 HEAD 实测：最终响应 `200`、`application/x-gzip`、`344011403` bytes、Last-Modified `2011-09-30T15:14:33Z`。4060 下载后以本机结果为准，记录最终 URL、headers、bytes 和 SHA256。TGZ 只放 WSL ext4，不进 GitHub、iCloud 或 `/mnt/c` 训练目录。

## 2. 已知位姿 adapter

- 约 `5 Hz` 均匀取样，最多 `120` 帧，覆盖完整轨迹；输出固定 frame manifest。
- 按 timestamp 将 RGB、depth 和 ground-truth pose 配对；记录匹配数量、最大/中位时间差和丢弃项。不得用文件序号假装同步。
- 使用数据集标定与 ground-truth camera-to-world；为 Nerfstudio 坐标约定写显式转换和最小测试。
- 用配对 depth 生成有颜色的稀疏初始化点云，过滤无效/极远深度并设置有界点数；不要回退到 v1 的错误 COLMAP pose。
- 生成独立的数据根与 `transforms.json`，不覆盖 Pexels 基线。
- 在训练前对开头/中间/结尾三个 anchors 做 pose、FOV、朝向和 depth 投影检查。任何翻转、镜像或单位错误先修 adapter。

adapter 与测试必须以实际 `.patch` 回传；不能只留在 4060 本机。

## 3. 唯一一次 preview 7k

只允许一个通过 adapter gate 的配置进入 7k。记录真实 steps、wall time、VRAM、OOM、checkpoint/PLY/SOG size 和 hash。SOG 转换沿用已证明可工作的有界路径，不再做 35 分钟无界尝试。

## 4. 第一版“可使用”门槛

本轮允许低清晰度，但以下必须全部满足：

- 能辨认出 desk/room 的主要结构；无强烈鱼眼、径向拖影和大面积 warped sheets；
- 开头/中间/结尾三个 anchors，checkpoint 对对应 source 每张 PSNR `>=18 dB`、SSIM `>=0.70`、LPIPS `<=0.40`；
- raw PLY 和 SOG 没有引入新的结构性失真；
- Viewer 加载真实 SOG，允许有边界的小范围 WASD/摇杆移动；
- Viewer manifest 的 start pose 和三个 anchors 来自实际 sampled cameras，不手写坐标；
- 选中一个本地 RGB 帧作为 `photo anchor`：点击后恢复该帧 camera pose、quaternion 和 FOV，并显示“已回到这张照片的拍摄视角”；
- OOM 为 `0`；未测数字保持 `null/PENDING`。

这只是 fixture 级“可用”：证明场景和照片回位机制成立，不代表普通手机视频入口已解决。

## 5. 回传与完成

```text
results/from-4060/unseen-3dgs-tum-first-usable-scene-2026-09-02-v4/
  FIRST-USABLE-SCENE-REPORT.md
  FIRST-USABLE-SCENE.json
  dataset-provenance.json
  adapter-validation.json
  checkpoint-metrics.json
  photo-anchor.json
  viewer-validation.json
  fixes/*.patch
  logs/（仅必要脱敏日志）
```

允许回传一张只显示生成场景的低分辨率 Viewer 截图；不要把源 RGB/depth 拼进截图。禁止上传 TGZ、原始 RGB/depth、checkpoint、PLY、SOG、token、`.env` 或完整 work 目录。

只有上述门槛全部通过才提交 `COMPLETED`。如果场景生成但照片回位未通，或视觉仍不可辨认，都必须提交 `BLOCKED`。
