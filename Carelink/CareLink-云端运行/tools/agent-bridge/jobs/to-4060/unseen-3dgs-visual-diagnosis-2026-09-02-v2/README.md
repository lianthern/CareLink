# v2 返工单：定位并修复 3DGS 视觉失败

父任务：`unseen-3dgs-sceneworker-2026-09-02-v1`

最终状态：`BLOCKED / INPUT_OR_POSE LOCATED`。已定位非物理 COLMAP 内参和独立的 Viewer manifest 缺陷；修复工作转入 [`v3 SfM 修复任务`](../unseen-3dgs-sfm-repair-2026-09-02-v3/README.md)。

人类状态页：[GitHub Issue #2](https://github.com/maxi-max-dev/max-agent-bridge/issues/2)

## 4060 Agent 唯一入口

在现有 Windows PowerShell Bridge checkout 中执行：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-visual-diagnosis-2026-09-02-v2" `
  -State "RECEIVED_VERIFIED" `
  -Message "v2 visual diagnosis task received; existing local checkpoint, PLY and SOG will be inspected before any retraining."
```

然后从 WSL 项目 `/home/max/src/unseen-3dgs-sceneworker` 开始。不要重新下载 Release；现有本地产物就是本轮诊断对象。

## 必须按顺序做

1. **冻结基线**：记录当前 config、checkpoint、PLY、SOG 的路径、大小、SHA256 和工具版本。改包或改脚本前先完成。
2. **checkpoint 评估**：使用当前 Nerfstudio 版本的实际 `--help` 确认命令，生成 train/eval PSNR、SSIM、LPIPS。不能生成就保留 `PENDING` 并返回真实错误。
3. **COLMAP 质量**：运行 model analyzer，记录 registered images、points、mean reprojection error、mean track length；不能只写 `72/72`。
4. **三锚点对照**：选至少三个 training-camera anchors，在相同或可对应的相机位姿比较：
   - source frame（只在本机看）；
   - checkpoint render；
   - raw PLY 的已知可靠 viewer；
   - SOG；
   - 当前 web viewer。
5. **判定最早失败阶段**：只能从 `INPUT_OR_POSE`、`CHECKPOINT`、`EXPORT_PLY`、`CONVERT_SOG`、`VIEWER_TRANSFORM`、`INCONCLUSIVE` 中选一个，并给证据。
6. **一次只改一个变量**：只有完成上面的隔离诊断后，才允许做一个最小修复实验。任何脚本/环境修复必须导出实际 patch、版本和完整命令。
7. **仍只跑 7k**：如果需要重跑，只能跑新的 preview 7k。30k quality 保持禁止。

## 完成门槛

必须同时满足才可提交 `COMPLETED`：

- `DIAGNOSIS.json` 明确最早失败阶段，不是猜测列表；
- `DIAGNOSIS.md` 记录三锚点对照和指标；
- `COLMAP-ANALYSIS.txt`、checkpoint 指标 JSON 与必要脱敏日志已回传；
- 本机修复以 `.patch` 或仓库代码提交回传，能够复现；
- 修复后的新 preview 7k 在至少三个 training-camera anchors 视觉通过；
- 未测字段保持 `null/PENDING`；
- 没有上传原视频、frames、checkpoint、PLY、SOG、token 或 `.env`。

若暂时无法修好，提交 `BLOCKED`，说明已经排除什么、下一步缺什么；不要提交 `COMPLETED`。

## 回传位置

```text
results/from-4060/unseen-3dgs-visual-diagnosis-2026-09-02-v2/
  DIAGNOSIS.md
  DIAGNOSIS.json
  COLMAP-ANALYSIS.txt
  checkpoint-metrics.json
  fixes/*.patch
  logs/（仅必要脱敏日志）
```

可以回传不含私密素材的低分辨率诊断拼图；不确定时不上传图，只回传数字、文字与 hash。
