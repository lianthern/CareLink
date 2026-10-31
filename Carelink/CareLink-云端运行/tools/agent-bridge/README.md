> 此目录是 2026-09-20 导入的来源快照。统一安装、当前用途、素材与部署边界请先读仓库根目录 README 和 `docs/team/HANDOFF.md`；下文保留原项目说明。

# Max Agent Bridge

这是 Max 的私有、可审计 Agent 交接通道。GitHub 是控制面和回执账本，不是训练数据盘。

## 当前任务

| Job | 目标 | 当前已知状态 | 人类入口 |
|---|---|---|---|
| `unseen-3dgs-sceneworker-2026-09-02-v1` | RTX 4060 Laptop Agent | `PIPELINE_COMPLETE / FAIL_VISUAL` | [Issue #1](https://github.com/maxi-max-dev/max-agent-bridge/issues/1) · [`结果`](results/from-4060/unseen-3dgs-sceneworker-2026-09-02-v1/NEXT-AGENT-HANDOFF.md) |
| `unseen-3dgs-visual-diagnosis-2026-09-02-v2` | RTX 4060 Laptop Agent | `BLOCKED / INPUT_OR_POSE LOCATED` | [Issue #2](https://github.com/maxi-max-dev/max-agent-bridge/issues/2) · [`诊断`](results/from-4060/unseen-3dgs-visual-diagnosis-2026-09-02-v2/DIAGNOSIS.md) |
| `unseen-3dgs-sfm-repair-2026-09-02-v3` | RTX 4060 Laptop Agent | `COMPLETED / INTEGRATED_BY_V5` | [Issue #3](https://github.com/maxi-max-dev/max-agent-bridge/issues/3) · [`通用视频修复`](jobs/to-4060/unseen-3dgs-sfm-repair-2026-09-02-v3/README.md) |
| `unseen-3dgs-tum-first-usable-scene-2026-09-02-v4` | RTX 4060 Laptop Agent | `COMPLETED / ACCEPTED_WITH_LIMITATIONS` | [Issue #4](https://github.com/maxi-max-dev/max-agent-bridge/issues/4) · [`首个可用场景`](jobs/to-4060/unseen-3dgs-tum-first-usable-scene-2026-09-02-v4/README.md) |
| `unseen-3dgs-local-viewer-integration-2026-09-02-v5` | RTX 4060 Laptop Agent | `COMPLETED / VIEWER_RUNNING` | [Issue #5](https://github.com/maxi-max-dev/max-agent-bridge/issues/5) · [`Viewer 整合`](jobs/to-4060/unseen-3dgs-local-viewer-integration-2026-09-02-v5/README.md) |
| `unseen-3dgs-room-and-local-upload-2026-09-02-v6` | RTX 4060 Laptop Agent | `COMPLETED / ACCEPTED_PREVIEW`，较大房间与本机上传入口已跑通 | [Issue #6](https://github.com/maxi-max-dev/max-agent-bridge/issues/6) · [`验收`](jobs/to-4060/unseen-3dgs-room-and-local-upload-2026-09-02-v6/ACCEPTANCE.md) · [`结果`](results/from-4060/unseen-3dgs-room-and-local-upload-2026-09-02-v6/V6-REPORT.md) |
| `unseen-3dgs-public-classroom-quality-2026-09-03-v7` | RTX 4060 Laptop Agent | `COMPLETED / USER_FULL_ROOM_FAIL / TRAJECTORY_SLICE_ONLY`，链路可加载但不是完整教室 | [Issue #8](https://github.com/maxi-max-dev/max-agent-bridge/issues/8) · [`报告`](results/from-4060/unseen-3dgs-public-classroom-quality-2026-09-03-v7/V7-REPORT.md) |
| `unseen-3dgs-full-room-meetingroom-2026-09-03-v8` | RTX 4060 Laptop Agent | `BLOCKED_AFTER_VIEWER_PASS`，Viewer 已修好；Google 返回 HTML，GPU 0 次 | [Issue #9](https://github.com/maxi-max-dev/max-agent-bridge/issues/9) · [`报告`](results/from-4060/unseen-3dgs-full-room-meetingroom-2026-09-03-v8/V8-REPORT.md) |
| `unseen-3dgs-full-room-hf-lite-2026-09-03-v9` | RTX 4060 Laptop Agent | `COMPLETED / FULL_ROOM_CANARY_ACCEPTED`，普通透视 Meetingroom 对照组已通过；不是 360 输入 | [Issue #10](https://github.com/maxi-max-dev/max-agent-bridge/issues/10) · [`结果`](results/from-4060/unseen-3dgs-full-room-hf-lite-2026-09-03-v9/V9-REPORT.md) |
| `unseen-3dgs-360roam-base-2026-09-03-v10` | RTX 4060 Laptop Agent | `COMPLETED / REJECTED_POSE_CONVENTION_BUG`，7k 技术执行完成但画面不可用，严禁续跑 30k | [Issue #11](https://github.com/maxi-max-dev/max-agent-bridge/issues/11) · [`报告`](results/from-4060/unseen-3dgs-360roam-base-2026-09-03-v10/V10-REPORT.md) |
| `unseen-3dgs-360roam-posefix-2026-09-04-v11` | RTX 4060 Laptop Agent | `COMPLETED / PANORAMIC_POSEFIX_ACCEPTED_7K`，Max 与 Mac 端视觉验收通过：六方向空间关系正确、可自由行走/缩放；仍为 7k 预览级，局部近景与地面较糊，未跑 30k | [Issue #12](https://github.com/maxi-max-dev/max-agent-bridge/issues/12) · [`报告`](results/from-4060/unseen-3dgs-360roam-posefix-2026-09-04-v11/V11-REPORT.md) · [`结果`](results/from-4060/unseen-3dgs-360roam-posefix-2026-09-04-v11/V11-RESULT.json) |
| `unseen-3dgs-360-photo-relocalization-2026-09-04-v12` | RTX 4060 Laptop Agent | `COMPLETED / PHOTO_RELOCALIZATION_PARTIAL_2_OF_3`，training-only map 27,391 点；query 1/3 精确通过，query 2 仅 13 matches、PnP 失败；按 3/3 合同未接 Viewer，GPU=0 | [Issue #13](https://github.com/maxi-max-dev/max-agent-bridge/issues/13) · [`报告`](results/from-4060/unseen-3dgs-360-photo-relocalization-2026-09-04-v12/V12-REPORT.md) · [`结果`](results/from-4060/unseen-3dgs-360-photo-relocalization-2026-09-04-v12/V12-RESULT.json) |
| `unseen-3dgs-360-photo-relocalization-multiview-2026-09-04-v13` | RTX 4060 Laptop Agent | `COMPLETED / PHOTO_RELOCALIZATION_MULTIVIEW_PARTIAL_2_OF_3`，query 2 从 13 增至 56 matches 但 PnP 仍无解；同 query/阈值、唯一运行，按 3/3 合同未接 Viewer，GPU=0 | [Issue #14](https://github.com/maxi-max-dev/max-agent-bridge/issues/14) · [`报告`](results/from-4060/unseen-3dgs-360-photo-relocalization-multiview-2026-09-04-v13/V13-REPORT.md) · [`结果`](results/from-4060/unseen-3dgs-360-photo-relocalization-multiview-2026-09-04-v13/V13-RESULT.json) |
| `unseen-3dgs-photo-return-goal-2026-09-04-v14` | RTX 4060 Laptop Agent | `COMPLETED / FIXED_REAL_PHOTO_RETURN_ACCEPTED_5_OF_5`，只证明冻结 v11 场景中的一张固定照片，不代表任意视频/照片产品 | [Issue #15](https://github.com/maxi-max-dev/max-agent-bridge/issues/15) · [`固定 canary`](jobs/to-4060/unseen-3dgs-photo-return-goal-2026-09-04-v14/GOAL.md) |
| `unseen-3dgs-local-product-2026-09-04-v15` | RTX 4060 Laptop Agent | `R3_RELEASE_PUBLISHED_PENDING_4060 / OVERALL_PRODUCT_GOAL_ACTIVE`，精确提交的 Linux/Windows CI 已全绿并发布不可变 private Release；下一步由 4060 跑本机上传、持久队列、未知位姿 360→7k→SOG/Viewer、新照片回位与恢复 canary，v15 通过后仍继续全新视频与三张实拍终验 | [Issue #16](https://github.com/maxi-max-dev/max-agent-bridge/issues/16) · [`R3 Release`](https://github.com/maxi-max-dev/max-agent-bridge/releases/tag/unseen-3dgs-local-product-2026-09-04-v15-r3) · [`唯一入口`](jobs/to-4060/unseen-3dgs-local-product-2026-09-04-v15/START-HERE.md) |

状态以任务对应的 GitHub Issue 和 `receipts/from-4060/<jobId>/` 中最新回执为准；本表只是入口，不伪装成实时数据库。

## 这套 Bridge 怎么工作

1. Mac Agent 发布不可变 `TASK.json`，把经过校验的 ZIP 放到 **Private GitHub Release**。
2. 4060 Agent 只需登录 GitHub，然后运行接收脚本。脚本下载 ZIP、核验 SHA256、解压到 Windows 用户目录，并提交 `RECEIVED_VERIFIED` 回执。
3. 4060 Agent 按包内 `START-HERE.md` 在 WSL ext4 中执行 canary；关键阶段继续提交回执。
4. 报告、benchmark 摘要和必要日志写入 `results/from-4060/<jobId>/`。原视频、frames、PLY/SOG、checkpoint 和任何 token 都不进 GitHub。

## 4060 的唯一首次入口

在 Windows PowerShell 中：

```powershell
gh auth login
gh repo clone maxi-max-dev/max-agent-bridge "$HOME\AgentBridge\control"
& "$HOME\AgentBridge\control\scripts\windows\Start-V15-LocalProduct.ps1" -JobId "unseen-3dgs-local-product-2026-09-04-v15" -Install -BootstrapDependencies -OpenBrowser
```

上面是全新电脑/首次 clone 的唯一入口；已有 checkout 或重试必须执行 v15 `START-HERE.md` 顶部的完整 fail-closed 入口块。启动器只接受本次接收器返回的精确 typed result，不会按目录时间猜测或复用旧 payload。

`gh auth login` 使用 GitHub 官方设备登录；不要把 PAT 写入命令、文件、聊天或仓库。如果系统没有 `gh`，先由 Max 明确同意后运行：

```powershell
winget install --id GitHub.cli
```

## 边界

- 仓库必须保持 private。
- 不通过 iCloud 判断任务是否送达；GitHub receipt 才是送达证据。
- 不开放 4060 公网端口；这条通道只需出站 HTTPS。
- Bridge 不连接 UNSEEN 生产 API/数据库，不创建真实生产任务。
- 详见 [`PROTOCOL.md`](PROTOCOL.md) 和 [`SECURITY.md`](SECURITY.md)。
