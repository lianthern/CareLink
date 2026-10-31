# v6 只做回传收尾——禁止重跑

Max 已报告 v6 在 4060 本机完成；Mac 验收端截至 2026-09-02 仍未在 GitHub 看到 v6 receipt 或 result。这里修复的是交接同步，不是训练结果。

## 硬边界

- 不得再次运行 7k/30k、COLMAP、adapter、PLY/SOG 转换或下载 0.83GB fixture。
- 不得停止或覆盖当前 Viewer、上传页及 v1-v5 artifact。
- 不得向 GitHub 提交 TGZ、RGB/depth、视频、frames、SOG、PLY、checkpoint、完整 work、`.env` 或 token。
- 只提交现有事实；缺失值写 `null`/`PENDING`，不得补造。

## PowerShell 收尾步骤

先在现有 Bridge checkout 同步本说明：

```powershell
$Bridge = "$HOME\AgentBridge\control"
git -C $Bridge pull --rebase --autostash origin main
```

从 4060 本机已经完成的 v6 work/log 中整理以下目录；复制文件，不移动或删除本机原件：

```text
results/from-4060/unseen-3dgs-room-and-local-upload-2026-09-02-v6/
  V6-REPORT.md
  V6-RESULT.json
  REPORT-FILES.json
  fixes/*.patch
  logs/
  viewer-screenshot.png
  intake-screenshot.png
```

`V6-RESULT.json` 和 `V6-REPORT.md` 必须明确：

- 实际 room Viewer URL、实际本机上传 URL、两项 server 是否仍在运行；
- 7k/30k/私密视频上传/生产连接的真实次数；
- TUM 下载 bytes/SHA、120 帧与时间覆盖、训练退出码/耗时/峰值显存、checkpoint metrics、PLY/SOG bytes/SHA；
- 上传入口的 5/5 测试、PowerShell parse、WSL/Windows HTTP、bind=`127.0.0.1`、auto-train=false；
- 未实测字段为 `null`/`PENDING`。

为结果生成 `REPORT-FILES.json` 后，先运行：

```powershell
python "$Bridge\scripts\verify_bridge.py"
git -C $Bridge status --short
```

确认暂存范围只有上述 v6 result 后，提交并推送结果：

```powershell
git -C $Bridge add -- "results/from-4060/unseen-3dgs-room-and-local-upload-2026-09-02-v6"
git -C $Bridge -c user.name="4060 Agent" -c user.email="4060-agent@users.noreply.github.com" commit -m "result(v6): return room and local intake evidence"
git -C $Bridge pull --rebase origin main
git -C $Bridge push origin HEAD:main
```

最后提交权威 `COMPLETED` 或 `FAILED` 回执。只有全部合同通过才可用 `COMPLETED`；否则用 `FAILED` 并写清真实缺口：

```powershell
& "$Bridge\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir $Bridge `
  -JobId "unseen-3dgs-room-and-local-upload-2026-09-02-v6" `
  -State "COMPLETED" `
  -Message "v6 existing local results synchronized without retraining; report includes actual Viewer/intake URLs and server state." `
  -Evidence @("results/from-4060/unseen-3dgs-room-and-local-upload-2026-09-02-v6/V6-REPORT.md")
```

push 完成后在 Issue #6 留下最终 result commit 和 receipt commit SHA。Mac 验收端会重新计算报告清单、校验状态机/敏感文件边界和真实性，不会只凭 `COMPLETED` 放行。
