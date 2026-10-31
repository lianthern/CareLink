# v3：修复 SfM 内参并生成合格 7k preview

父任务：`unseen-3dgs-visual-diagnosis-2026-09-02-v2`

已知首坏点：原 COLMAP `OPENCV` 相机把 1280×720 方形像素图像解成 `fx/fy=4.7329`，训练输入被强烈鱼眼化。另有独立的 Viewer manifest/坐标问题。

人类状态页：[GitHub Issue #3](https://github.com/maxi-max-dev/max-agent-bridge/issues/3)

优先级更新：已 `RECEIVED_VERIFIED`，但在 `RUNNING` 前降为后续任务。为了最快得到第一份可用场景，先执行 [`v4 TUM 已知位姿场景`](../unseen-3dgs-tum-first-usable-scene-2026-09-02-v4/README.md)。v4 完成或阻塞后再恢复本任务；不要与 v4 并行占用 GPU。

## 4060 Agent 唯一入口

在现有 Windows PowerShell Bridge checkout 中执行：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-sfm-repair-2026-09-02-v3" `
  -State "RECEIVED_VERIFIED" `
  -Message "v3 bounded SfM repair task received; v1/v2 baselines will remain immutable."
```

随后在 WSL 项目 `/home/max/src/unseen-3dgs-sceneworker` 工作。无需重新下载 Release。

## 资源与变更上限

- 最多 `3` 个相互隔离的 **SfM-only** 实验；每个实验只改变声明的相机模型或内参约束。
- 最多 `1` 次新的 preview 7k；只有 SfM gate 通过后才能启动。
- `0` 次 quality 30k；仍然禁止。
- v1/v2 的 config、checkpoint、PLY、SOG、transforms 和报告必须保持原 hash，不得覆盖。
- 在实际 COLMAP 3.7、`ns-process-data images --help` 中核对参数；不要猜测不存在的 CLI。

## 三个候选实验

实验输出使用独立目录 `reports/repair-v3/sfm/<candidate>/`，不得写回基线：

1. `SIMPLE_RADIAL_AUTO`：共享单相机、方形像素，保留原 exhaustive matching；只把相机模型改为低自由度 radial 模型。
2. `SIMPLE_RADIAL_PRIOR`：仅在候选 1 未通过时运行；保持同一模型和 matching，加入有来源记录的合理焦距初值/先验。优先从原基线合理的 `fx≈832`、画面几何或工具输出取值，不可凭空挑最好看的数。
3. `SQUARE_PIXEL_LOW_DOF_PRIOR`：仅在前两个未通过时运行；换用另一个仍强制方形像素的低自由度模型，并沿用有证据的焦距先验。不得回到允许 `fx/fy` 任意分裂的 OPENCV 解。

如果 `ns-process-data` 不暴露所需模型/先验，可使用本机 COLMAP 3.7 的真实 `--help` 组装隔离处理步骤，再生成 Nerfstudio 兼容数据。所有命令必须记录，最终代码必须以 patch 回传。

## 每个候选必须先过 SfM gate

全部满足才算通过：

- 相机模型天然使用方形像素，或 `abs(fx/fy - 1) <= 0.02`；
- registered images `>=65/72`；
- points `>=2000`；observations `>=10000`；
- mean track length `>=3`；mean reprojection error `<=1.5 px`；
- principal point、焦距和畸变参数有物理解释，不靠极端参数换取低重投影误差；
- `frame_00001`、`frame_00036`、`frame_00072` 去畸变图不再有强烈鱼眼、非均匀拉伸或弯曲直线；
- 保存 `model_analyzer`、camera TXT、三锚点本机检查和失败理由。

如果多个候选通过，只选注册覆盖、点云、残差和视觉共同最好的一个。不得为每个候选都训练。

## 唯一一次 7k 的 gate

选中的 SfM 通过后才运行新 preview 7k。至少三个 anchors 必须同时满足：

- checkpoint 对对应原始 source：每张 PSNR `>=20 dB`、SSIM `>=0.80`、LPIPS `<=0.30`；
- 人工视觉检查为 coherent，无强鱼眼、径向拖影和大片 warped sheets；
- raw PLY 与 checkpoint 的对应关系通过；
- SOG 没有引入新的结构性失真；
- OOM 为 `0`，真实耗时、VRAM、artifact hash/size 均记录。

达不到门槛立即停在 `BLOCKED`，不得追加训练步数掩盖输入问题。

## Viewer 必修项

- scene manifest 的 start pose 和至少三个 photo anchors 必须从实际 training cameras 与 dataparser transform 程序化生成；
- 不得继续使用手写 `[0, 1.62, 3.05]`、`[1.42, 1.62, 2.18]` 或 identity quaternion；
- 不得用全局 `eyeHeight` 静默覆盖训练相机 Y；自由行走模式和 photo-anchor 模式需要显式区分；
- patch、坐标变换说明和三个真实 anchor 的 viewer 验证必须回传。

## 完成与回传

只有 SfM gate、唯一 7k gate 和 Viewer gate 全部通过，才可提交 `COMPLETED`。否则提交 `BLOCKED`，说明各候选的失败证据和下一步缺口。

```text
results/from-4060/unseen-3dgs-sfm-repair-2026-09-02-v3/
  REPAIR-REPORT.md
  REPAIR-RESULT.json
  SFM-CANDIDATES.json
  checkpoint-metrics.json
  viewer-transform.md
  fixes/*.patch
  logs/（必要脱敏日志）
```

禁止上传原视频、frames、checkpoint、PLY、SOG、`.env`、token 或完整 work 目录。可以上传指标、hash、patch、脱敏日志和不含私密素材的低分辨率诊断拼图。
