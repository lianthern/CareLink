# UNSEEN 3DGS SceneWorker — 4060 canary v1

当前状态：**流水线已完成，但视觉质量失败（PIPELINE_COMPLETE / FAIL_VISUAL）。**

人类状态页：[GitHub Issue #1](https://github.com/maxi-max-dev/max-agent-bridge/issues/1)

30k quality 已锁定。后续工作转入 [`v2 视觉诊断返工单`](../unseen-3dgs-visual-diagnosis-2026-09-02-v2/README.md)。原始 receipt 历史不改写。

## 4060 Agent 执行

在 Windows PowerShell 中运行：

```powershell
gh auth login
gh repo clone maxi-max-dev/max-agent-bridge "$HOME\AgentBridge\control"
& "$HOME\AgentBridge\control\scripts\windows\Receive-BridgeJob.ps1"
```

接收脚本会：

1. 确认仓库确实是 private；
2. 从 private Release 下载固定资产；
3. 比对文件大小与 SHA256；
4. 解压到 `$HOME\AgentBridge\jobs\...`；
5. 向 GitHub 提交 `RECEIVED_VERIFIED` receipt；
6. 打印唯一下一份应读文档路径。

随后严格执行包内 `00-READ-FIRST.md` 与 `START-HERE.md`。本次只跑固定 Pexels 隔离 canary，生产 adapter 继续保持关闭。

## 回传

报告的 GitHub 权威路径：

`results/from-4060/unseen-3dgs-sceneworker-2026-09-02-v1/UNSEEN-3DGS-CANARY-REPORT.md`

原交接包要求的 iCloud `From-4060` 路径现在降级为 best effort；iCloud 是否显示同步不再作为完成证据。禁止回传原视频、frames、SOG/PLY、checkpoint、token 或完整 work 目录。
