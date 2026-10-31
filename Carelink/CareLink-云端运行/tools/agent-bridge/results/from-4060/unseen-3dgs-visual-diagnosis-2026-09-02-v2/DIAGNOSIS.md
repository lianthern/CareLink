# UNSEEN 3DGS 视觉失败诊断 v2

## 结论

状态：`BLOCKED`

最早失败阶段：`INPUT_OR_POSE`

现有 7k checkpoint 并没有首先坏掉。它以很高的精度拟合了 Nerfstudio 去畸变后的训练域；raw PLY 与 checkpoint 参数、像素均完全一致；SOG 仅产生正常的有损压缩差异；当前 PlayCanvas/SOG 渲染器在注入真实 training-camera pose 后也能在三个锚点显示同一场景。

最早的异常已经存在于 COLMAP 相机内参：原始源帧为 1280×720 的正常透视图像，但单相机 `OPENCV` 模型解出了 `fx=832.1798`、`fy=175.8516`，`fx/fy=4.7329`。FullImageDatamanager 按该模型去畸变后得到强烈鱼眼形变；checkpoint、PLY、SOG 和 viewer 都只是继续忠实呈现这套错误训练几何。

此外，随交付的 `viewer/scene.json` 还有一个更晚出现的独立问题：它使用手工的 Y-up walk-space 起点与唯一 photo anchor，没有从训练相机或 dataparser transform 派生。原始起点 `[0, 1.62, 3.05]` 会落入 splat 的错误空间；但这不是最早失败，因为在相同 viewer 中注入真实训练相机后 SOG 可以正常显示。

## 基线冻结

冻结时间：`2026-09-02T03:52:39Z`

| 对象 | 大小（bytes） | SHA256 |
|---|---:|---|
| config.yml | 7,839 | `caf172bf132828fbb30d4f0d914a03a8c3e6c67121857a39729d2dfaac4834de` |
| step-000006999.ckpt | 135,964,114 | `5b1dc3a4d12f878ccad8f2f8679b7af9ea8a9077599b9ba2b5409a5924bbec95` |
| raw splat.ply | 44,159,233 | `25b9ccb910c9ab386e6cded49969906c17f6a69b2653ee1e55a3b6a2fe7951b1` |
| scene.sog | 4,665,339 | `901d501dd41d254ed047322198cb283bdf2f146a92aeab94a16e1efecad5c223` |
| transforms.json | 64,612 | `b9175c7216eef06ba9d1acbf394c0fcf81c59d81da43a9befa38f1841b31f319` |

修复实验后再次计算上述五个 SHA256，均未变化。原 checkpoint、PLY、SOG 没有被覆盖。

工具版本：Nerfstudio 1.1.5；PyTorch 2.1.2+cu121；gsplat 1.4.0+pt21cu121；COLMAP 3.7；splat-transform 3.3.3 (`d092ae9`)；Node 22.23.1；NVIDIA GeForce RTX 4060 Laptop GPU，驱动 596.49，8188 MiB。

## Checkpoint 指标

命令先由本机 Nerfstudio 1.1.5 的实际 `--help` 确认。`ns-eval` 支持 `--load-config`、`--output-path` 与 `--render-output-path`；`ns-render dataset` 支持 `--split train` 与 `rgb/gt-rgb` 输出。

| split | 图像数 | PSNR (dB) | SSIM | LPIPS |
|---|---:|---:|---:|---:|
| train（Nerfstudio 原生去畸变缓存） | 65 | 32.4298 | 0.970620 | 0.074713 |
| eval（`ns-eval`） | 7 | 31.8436 | 0.963422 | 0.079537 |

注意：`ns-render dataset --split train` 写出的 `gt-rgb` 是未去畸变原图，而 `rgb` 是按训练相机渲染的去畸变域。直接把两者当 checkpoint train 指标会得到错误的低值（PSNR 11.55）。本报告没有把这组错误配对当 checkpoint 指标；train 指标由 FullImageDatamanager 的 `cached_train` 与 `SplatfactoModel.get_image_metrics_and_images` 原生路径逐图计算。

## COLMAP 质量

原基线 `colmap model_analyzer`：

- Cameras: 1
- Images / Registered images: 72 / 72
- Points: 8,218
- Observations: 78,752
- Mean reprojection error: 0.985025 px
- Mean track length: 9.582867
- Mean observations per image: 1,093.777778

这些数字说明匹配覆盖和重投影残差并不差，但不能证明相机内参物理合理。相机模型本身是：

```text
OPENCV 1280 720
fx=832.1797717687 fy=175.8516372312
cx=715.7966895676 cy=353.4620206479
k1=0.2932387609 k2=-0.0064305327 p1=0.0164957937 p2=0.0365897306
```

`fx/fy=4.7329` 是首个可复现视觉错误来源。

## 三个 training-camera anchors

锚点固定为 `frame_00001`、`frame_00036`、`frame_00072`，均属于原 65 张 train split。所有 checkpoint / raw PLY / SOG 比较都使用相同的 Nerfstudio 去畸变后 K 与 c2w。

| anchor | checkpoint vs 原始 source（PSNR / SSIM / LPIPS） | checkpoint vs 去畸变 training source | raw PLY vs checkpoint | SOG vs raw PLY | 当前 web viewer |
|---|---|---|---|---|---|
| frame_00001 | 10.657 / 0.6502 / 0.6533 | 28.357 / 0.9620 / 0.0993 | 像素完全相同 | 38.665 / 0.9942 / 0.0211 | 注入真实相机后 `SOG ready`，视觉对应 |
| frame_00036 | 10.644 / 0.5658 / 0.6685 | 31.246 / 0.9702 / 0.0770 | 像素完全相同 | 34.374 / 0.9881 / 0.0337 | 注入真实相机后 `SOG ready`，视觉对应 |
| frame_00072 | 11.899 / 0.5594 / 0.6455 | 32.507 / 0.9647 / 0.0741 | 像素完全相同 | 37.676 / 0.9912 / 0.0252 | 注入真实相机后 `SOG ready`，视觉对应 |

source 原图仅在本机查看，没有回传。三个 source 原图都是正常透视画面；对应 checkpoint/PLY/SOG 是强烈鱼眼形变，但彼此一致。

### Raw PLY 可靠渲染

使用当前已安装的 gsplat 1.4.0，按 Nerfstudio 1.1.5 `SplatfactoModel.get_outputs` 的同一 view matrix、K、背景、SH3 和 classic rasterization 路径直接读取 PLY。178,055 个高斯的 means、quats、log-scales、opacity logits、DC 与全部高阶 SH 系数和 checkpoint 完全一致（所有字段 max/mean absolute error 均为 0）；三个锚点 raw PLY 与 checkpoint 的像素差也为 0。

### SOG

用 splat-transform 3.3.3 将现有 SOG 解包成仅供本机诊断的 PLY，再通过同一 gsplat 相机路径渲染。三个锚点与 raw PLY 的 PSNR 为 34.37–38.67 dB、SSIM 为 0.9881–0.9942、LPIPS 为 0.0211–0.0337，符合 SOG 有损压缩，不构成首坏点。

### 当前 Web Viewer

对现有 `app.js`、PlayCanvas 2.21.4、现有 SOG 建立本机诊断副本；仅通过 `?scene=` 提供三个由训练 c2w 计算的临时 manifest，不改 viewer 代码或 SOG。三个锚点均显示 `SOG ready`，约 236–240 FPS，视觉上与 SOG/PLY 对应。

原始 `scene.json` 则失败：起点 `[0, 1.62, 3.05]`、identity quaternion、FOV 62，以及唯一 anchor `[1.42, 1.62, 2.18]`/FOV 58，都不是训练相机；`setCameraPose` 还强制以全局 `eyeHeight` 覆盖 pose Y。这是额外的 `VIEWER_TRANSFORM` 缺陷，但晚于 `INPUT_OR_POSE`。

## 单变量最小修复实验

实验只改了一个算法变量：

```diff
--- --camera-type perspective
+++ --camera-type simple_pinhole
```

实验在独立的 `reports/diagnosis-v2/repair/` 根目录重跑 COLMAP，没有覆盖原数据和 artifact。结果：

- SIMPLE_PINHOLE: `f=655.6827, cx=640.0000, cy=360.0000`，方形像素恢复；
- Registered images: 17/72，且全部集中在 frame 56–72；
- Points: 13；Observations: 32；Mean track length: 2.461538；
- Mean reprojection error: 0 px（退化小模型，不能解读为高质量）。

因此修复实验在 SfM 门槛已经失败。没有启动 7k 训练，因为 17 帧/13 点的退化模型不可能验证完整场景修复；也没有尝试第二个变量。30k 从未启动。

失败实验 patch 已保存为 `fixes/0001-simple-pinhole-failed-experiment.patch`，并已从工作脚本撤回，防止后续误用。

## 已排除项与下一步缺口

已排除：

- checkpoint 权重损坏；
- checkpoint -> raw PLY 导出错误；
- raw PLY -> SOG 是首个严重错误；
- PlayCanvas/SOG renderer 在真实训练相机下无法渲染。

下一步需要一个新的、单独批准的 SfM 实验：在保持方形像素/合理焦距先验的同时恢复接近 72 帧的稳定注册。候选方向包括固定或提供焦距先验、不同但仍单一的 COLMAP camera model、或更适合视频序列的匹配/位姿方案；本轮合同只允许完成隔离后的一次单变量最小实验，因此未继续扫参数。

在新的 SfM 能同时满足合理内参、足够注册覆盖和非退化点云之前，不能启动新的 7k，更不能提交 `COMPLETED`。

## 数据边界

未向 GitHub 上传原视频、frames、checkpoint、PLY、SOG、`.env`、token、工作目录或任何诊断截图。仅回传数值、文字、哈希、脱敏命令摘要和失败实验 patch。
