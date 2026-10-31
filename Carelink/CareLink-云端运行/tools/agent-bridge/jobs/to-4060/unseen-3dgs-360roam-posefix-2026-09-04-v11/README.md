# v11 P0：修正 360 位姿后重做一次可用性 7k

GitHub Issue：[Issue #12](https://github.com/maxi-max-dev/max-agent-bridge/issues/12)

v10 已正式拒收，不是“训练不够久”：360Roam 的 `pose_c2w.json` 是 OpenCV/COLMAP `c2w`，v10 却按 OpenGL 直接使用并叠加反号 yaw，导致多数虚拟视图错 90°/180°。v11 只做这条失败链的有界修复；严禁继续 v10 checkpoint，严禁跑 v10 30k。

## 4060 Agent 唯一入口

先在 Windows PowerShell 拉取 GitHub：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-360roam-posefix-2026-09-04-v11" `
  -State "RECEIVED_VERIFIED" `
  -Message "v11 pose-fix task received; v10 checkpoint forbidden; production off."
```

完整阅读本文件、`ACCEPTANCE.md`、`MAC-VERIFICATION.md`、`SOURCE-EVIDENCE.md`、`TASK.json` 和 `STATUS.json`。不要让 Max 搬文件、抄长命令或重新下载素材。

## Phase A：0 次 GPU 的硬门

先只运行：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-360roam-posefix-2026-09-04-v11\inputs\scripts\windows\Start-V11-360Roam.ps1" `
  -ConfirmResearchCanary
```

它必须完成以下工作：

1. 逐项 SHA256 复核 v10 已下载的 60 张全景和 `pose_c2w.json`，不得自动重下约 674MB。
2. 复用 v10 已生成的透视 JPEG；新数据集只保留八个水平重叠视角和 `up`，移除会拍到动态车底的 `down`，得到 450 train + 90 val。
3. 使用唯一正确公式：`c2w_gl_face = c2w_cv_source @ Ry(+yaw) @ Rx(+pitch) @ diag(1,-1,-1,1)`。
4. 运行 FFmpeg 合成方向图的 pixel-ray 契约测试，确保抽出的图像中心射线与新 pose 同向。
5. 对真实相邻全景的四个主方向交叉寻找重叠视野，再运行 SIFT + 已知位姿极线检查。至少 12 个相邻全景 pair 可评估、至少一半通过；每个通过 pair 的正确位姿 inlier 必须 ≥12、比例 ≥10%，并至少是 v10 错误约定的 2 倍，中位 inlier 残差 ≤2.5px。
6. 只用我们的透视图与作者相机位姿自行三角化 `sparse_pc.ply`，至少 3,000 点；不得下载或读取作者 `scene.ply`。

任何门失败都提交 `BLOCKED`，GPU 保持 0 次，并回传 `pose-image-gate.json`。不得凭肉眼说“方向看起来对”后绕过。

## Phase B：门通过后恰好一次新 7k

Phase A 全过、确认没有其他 GPU job 后，提交 `RUNNING` receipt，再运行：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-360roam-posefix-2026-09-04-v11\inputs\scripts\windows\Start-V11-360Roam.ps1" `
  -ConfirmResearchCanary -RunPreview -ConfirmGpuPreview
```

这必须是新的 v11 lineage、从头训练到 step 6999，但使用我们自行三角化的 sparse seed：`random-init=False`、`load-3D-points=True`。v10 的 checkpoint、PLY、SOG 和指标都不得复制或恢复。

本任务**没有 30k 权限**。7k 后先做 frozen 90-view 评估、PLY→SOG→PLY、六方向截图和 10–20 秒 Viewer 漫游。只有 Max 实际看过并接受，才可能另开后续任务。

## 用户视觉门

- front/back/left/right/up 均能稳定辨认同一室内空间，不允许大块灰雾主导。
- 走动时桌椅、墙、柱、梁的遮挡关系稳定变化，不是全景贴图推拉。
- Viewer 支持 zoom、正常走、3× sprint、平视与抬头；起步 roll≤0.5°，走动不改变眼高。
- 与 v10 同类截图对比；不能只报“脚本 PASS”。
- held-out 指标必须真实记录。推荐拒收线：PSNR≤16、SSIM≤0.65 或 LPIPS≥0.65 时直接 `TECHNICAL_PASS_USER_GATE_FAIL`，不得包装成可用。

## 回传

只提交到：

```text
results/from-4060/unseen-3dgs-360roam-posefix-2026-09-04-v11/
  V11-REPORT.md
  V11-RESULT.json
  REPORT-FILES.json
  logs/pose-image-gate.json
  logs/dataparser-preflight.json
  logs/evaluation.json
  logs/stage-result.json
  source-contact-sheet.jpg
  corrected-view-contact-sheet.jpg
  viewer-overview.png
  direction-front.jpg
  direction-back.jpg
  direction-left.jpg
  direction-right.jpg
  direction-up.jpg
  direction-down.jpg
  viewer-walkthrough-v11.mp4
```

允许报告、脱敏 JSON/日志、小图和 ≤15MiB 录屏。禁止提交源全景、作者位姿、540 张视图、sparse seed、checkpoint、PLY、SOG、work、`.env` 或 token。只可监听 `127.0.0.1`，不接生产、不改 firewall、不开放 LAN/公网端口、不调用付费 API。

最终状态只能是 `PANORAMIC_POSEFIX_ACCEPTED_7K`、`TECHNICAL_PASS_USER_GATE_FAIL`、`BLOCKED` 或 `FAILED`。
