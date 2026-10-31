# v14：固定实图回位，持续做到验收成功

GitHub Issue：[Issue #15](https://github.com/maxi-max-dev/max-agent-bridge/issues/15)

## 当前状态：`FIXED_REAL_PHOTO_RETURN_ACCEPTED_5_OF_5`

4060 Agent 自主实现的 `alexnet-superpoint-lightglue-training-track-v1` 已在 commit `acf9b9189198cf24ec09502c1985a7ee7717dc6a` 通过 private final gate：冻结实现 SHA256 `7620f3d9d296f679b555b461e45fc36fecaf9bf28db8bb6ddee1031ba043f4ec`，training-only index tree SHA256 `cb97169c17c6a662fc33936445f6eb90aa3367b9021407ed38f2a1d1d993e7d9`，五个干净进程全部通过。Mac 已完成第一轮代码、hash、门槛和 truth-free 边界复核。

现在不要重跑前述方法、不要继续调参，也不要改冻结实现或 index。独立 v14 Viewer manifest、五个不同起点回位和完整 pose chain 已由 Mac 技术验收；当前唯一执行项是按下方“4060 当前唯一补件动作”补充可辨认的原空间上下文。总体目标在 Max 看过新证据并直接确认前仍是 `RUNNING`。

2026-09-04 15:30 Mac 复核说明：远端 commit `5560743`/receipt `fcd4a48` 自报 `COMPLETED`，但没有按 Issue 最新整改意见提交 v14 manifest、`VIEWER-POSE-CHAIN.json` 或匹配 query 投影/FOV 且带五次指标的 contact sheet；只是把原有 JSON 中的 `PENDING` 改成了“Max accepted”。该 claim 不构成 Mac 终验，当前仍为 `RUNNING / VIEWER_EVIDENCE_GAP`。不得从 v11 的旧视觉评价或未经当前任务直接确认的文字推断 Max 已接受 v14。

2026-09-04 16:41 Mac 复核说明：远端 supplement `1c68b2d` 已补齐 v14 manifest、`VIEWER-POSE-CHAIN.json`、1024×1024 / vertical FOV 100° capture log 与带指标 contact sheet。Mac 独立复算 15/15 `REPORT-FILES`、五条嵌入矩阵转换、五个 manifest anchors、五个 browser returns、query FOV、五个不同起点及 final-gate 指标均通过；16 个 v14 单测和 Bridge verifier 也通过。剩余唯一机器证据缺口是三个被引用却未上传、因此 SHA 无法独立复算的 JSON 来源：truth-free `challenge.json`、五份原始 final-gate `estimate.json`、v11 `dataparser_transforms.json`。只复制这些现有 JSON 并纳入 `REPORT-FILES.json`，禁止重跑定位/Viewer/训练。新版 contact sheet 投影和标签合格，但渲染仍很模糊，是否足够识别正确空间位置只由 Max 直接看图确认，4060 Agent 不得代替 Max 判断。

2026-09-04 17:17 Mac 最终技术复核：远端 `eae4cfb` 已原样补齐上述七份 JSON。Mac 重算 22/22 size/SHA256；验证 challenge 为 450 training + 5 photometric query variants、query truth/source path 均未包含；五份原始 estimate 的 SHA、run/query identity、三项 truth-free 声明、指标和矩阵均与 final gate/pose chain 精确绑定；v11 dataparser 原文件 SHA 与 transform/scale 也精确匹配。完整 estimate→dataparser→manifest→browser 链 5/5、不同浏览器起点 5/5、16/16 单测与 14-task Bridge verifier 全过。至此无需 4060 再做任何事；总体仍保持 `RUNNING`，唯一未过项是 Max 对现有模糊 v14 contact sheet 的直接人眼确认。

2026-09-04 Max 已直接退回现有视觉证据：“我没看到原空间”。技术 5/5 继续有效，但原 contact sheet 只看到模糊墙面，不能让人识别它与完整房间的关系。4060 只补一份 evidence-only 空间上下文演示，不重跑定位、final gate、训练或五次 Viewer mechanics：用 final-01 从可辨认的房间广角连续回到 estimated anchor，再明确标注并拉开显示周边空间。总体状态改为 `RUNNING / MAC_TECHNICAL_ACCEPTED_5_OF_5 / MAX_VISUAL_REJECTED_CONTEXT_EVIDENCE_REQUESTED`。

## 4060 当前唯一补件动作

先 pull 最新 `main`。复用冻结的 v11 Viewer、v14 manifest 和 final-01 anchor，交付：

- `fixed-photo-spatial-context.mp4`：目标 ≤3 MB、硬上限 5 MB，720p/24fps/8–15 秒，连续而非拼接伪证。先停留 2–3 秒展示可辨认的原空间（木质顶棚/立柱/海报/桌椅等），标注“原空间 / free walk”；再显示大而可读的当前位置/目标点俯视图；点击 `Return to source frame` 到准确 final-01 estimated anchor，显示 pose/FOV 和固定 query inset；最后标注“context reveal / 非估计位姿”，后退或环绕揭示墙面与房间的关系。
- `fixed-photo-spatial-context-contact-sheet.jpg`：从同一连续录制取 6–8 格，依次覆盖原空间、当前点/目标点、回位动作、准确到达、到达后空间揭示。
- `logs/viewer-spatial-context.json`：记录 scene/manifest SHA、final-01 anchor、起点、各事件时间、到达时准确 pose/FOV、到达后移动，以及视频/分镜 size/SHA256；声明 loopback-only、no ground truth、no rerun。
- 更新 `V14-REPORT.md`、`V14-RESULT.json`、`REPORT-FILES.json`、`STATE.json`、`EXPERIMENTS.json`，保持 `RUNNING` 和 Max visual rejected。只需一个 final-01 连续演示，不做五个重复视频。

禁止改变 v11、冻结实现/index、manifest anchor 或既有 evidence；禁止重跑定位/判卷/训练、上传原视频/全景/query/training views/SOG/PLY/weights/token，禁止非 loopback 监听。回传后不要自行写 Max accepted 或关闭 Issue。

2026-09-04 17:55 Mac 补件复核：远端 `41f85f1` 已交付 785,942-byte / 11.042 秒连续 MP4、同源 7 格分镜和完整日志。Mac 重算 25/25 文件 hash，完整解码视频，并核对 frozen manifest/pose chain/SOG、final-01 到达 pose/FOV、loopback/no truth/no rerun 边界；画面现在确实包含可辨认原空间、current/target、回位动作、准确到达和明确分隔的到达后空间揭示。Bridge verifier 对本次合同指定 MP4 文件名的旧规则已由 Mac 精确修正，16/16 tests 和 14-task verifier 通过。4060 当前无剩余动作；总体保持 `RUNNING / MAC_TECHNICAL_ACCEPTED_5_OF_5 / MAX_REREVIEW_PENDING`，只等 Max 直接看新视频/分镜决定是否接受。

2026-09-04 Max 已直接观看新视频/分镜并回复“可以 那就继续吧”，明确接受现在能看出原空间与照片回位位置的关系。算法 5/5、Viewer 5/5、Mac 来源/数值/媒体复核和 Max 人眼门全部满足，v14 正式记为 `FIXED_REAL_PHOTO_RETURN_ACCEPTED_5_OF_5`，Issue #15 关闭。该结论只证明固定 hard query 2 canary；任意照片、任意房间、原始 360 MP4 自动建图、30k 画质和生产接入仍未证明。

v12/v13 都在同一 hard query 上停在 PnP 无解。Max 现在把目标从“三张一次性全过”收窄为：**先让这一张真实 360 全景来源的照片稳定回到正确空间位置，允许换方法持续试，跑通多次后再验收。**

本任务的完整活动真相是 [`GOAL.md`](GOAL.md)。这不是普通 frozen canary；一次算法失败不能结束目标。

## 4060 Agent 唯一开工入口

先 pull 并登记收件：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-photo-return-goal-2026-09-04-v14" `
  -State "RECEIVED_VERIFIED" `
  -Message "v14 persistent fixed-photo return goal received; continue across methods until all acceptance gates pass."
```

完整阅读 `GOAL.md`、`ACCEPTANCE.md`、`TASK.json`、`STATUS.json` 后执行：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-photo-return-goal-2026-09-04-v14\inputs\scripts\windows\Start-V14-Goal.ps1" `
  -ConfirmPersistentGoal
```

入口先验证环境并生成 truth-free challenge，随后默认连续测量两条不同路线：先运行 `SIFT track v1`，只用 training images/poses 建索引，以已知训练位姿做 epipolar 过滤，再通过局部参考帧 PnP；然后运行 `verified retrieval v1`，以内容检索 + 2D robust geometry 选择最可信训练相机并用其 pose 做粗定位。两者都尝试五个 query 变体。它不会自动安装依赖、启动 GPU、训练 3DGS、下载模型或开放端口。只想准备 challenge 时可显式加 `-SetupOnly`；只想诊断第一种方法时可加 `-FirstMethodOnly`；已在旧 commit 完成第一种、pull 更新后只续第二种时可加 `-SkipFirstMethod`。正常 fresh Goal 三者都不要加。

两种方法的结果都会写进 WSL ext4 下的 `work/v14-photo-return-goal/EXPERIMENTS.json` 与 `STATE.json`。若内部几何未通过，继续按 `GOAL.md` 换真正不同的方法；若内部几何 5/5，也必须再跑 private scorer，不能直接称成功。特别是 verified retrieval 返回的是内容验证后的近邻训练相机 pose，是否足够接近只能由 private position/rotation scorer 判断。

以下命令仅保留为方法 3 的历史复现入口；当前算法已由 4060 Agent 的更强实现通过 5/5，**不要再次运行**：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-photo-return-goal-2026-09-04-v14\inputs\scripts\windows\Start-V14-Goal.ps1" `
  -ConfirmPersistentGoal `
  -LearnedMethodOnly
```

它只在 WSL ext4 的 v14 work 目录下载并校验固定的 LightGlue/ALIKED 源码与权重，使用 4060 做定位推理；不安装系统包、不训练 3DGS、不监听网络端口。内部 5/5 才能进入 private final gate，miss 则保留证据并继续 Goal。

## 最终判卷命令

开发阶段可用不同输出目录测量候选。候选实现和 training-only index 冻结后，用实际 SHA 执行：

```bash
python3 inputs/scripts/linux/run_v14_final_gate.py \
  --dataset /home/max/src/unseen-3dgs-sceneworker/data/360roam-base-v11/prepared/base-erp9-posefix \
  --challenge /home/max/src/unseen-3dgs-sceneworker/work/v14-photo-return-goal/challenge/challenge.json \
  --implementation /home/max/src/unseen-3dgs-sceneworker/work/v14-photo-return-goal/candidate/final_localizer.py \
  --implementation-sha256 <64位真实SHA256> \
  --index-dir /home/max/src/unseen-3dgs-sceneworker/work/v14-photo-return-goal/index/final \
  --output /home/max/src/unseen-3dgs-sceneworker/work/v14-photo-return-goal/final-gate
```

脚本自己从 private scorer 输入读取真值，但 candidate process 只能看到脱敏 challenge。五次必须全部通过，且 index 前后 hash 不变。

## GitHub 续跑与交卷

- 每个真正不同的方法结束后，更新 Issue，并安全推送 `STATE.json` 与 `EXPERIMENTS.json`；失败状态保持 `RUNNING`。
- 只有算法 5/5 + Viewer 5/5 后才提交 `COMPLETED` receipt。
- 最终只允许回传：`V14-REPORT.md`、`V14-RESULT.json`、`REPORT-FILES.json`、`STATE.json`、`EXPERIMENTS.json`、`FINAL-GATE.json`、`DEPENDENCIES.json`、`IMPLEMENTATION-LOCK.json`、最终实现源码、`logs/viewer-e2e.json`、`logs/viewer-projection-capture.json`、`logs/viewer-spatial-context.json`、v14 scene manifest、`VIEWER-POSE-CHAIN.json`、安全 contact sheet/Viewer overview，以及不超过 5 MB 的 `fixed-photo-spatial-context.mp4` 和同源 `fixed-photo-spatial-context-contact-sheet.jpg`。
- 为关闭 Mac 源 hash 审计，额外允许三个 JSON-only 证据种类：不含 query truth/源路径的原样 `challenge.json`、五份原样 final-gate `estimate.json`、原样 v11 `dataparser_transforms.json`。它们必须逐个进入 `REPORT-FILES.json`，不得用重新序列化的摘要替代原文件。
- 禁止回传原图/单独 query/training views、feature/index、权重、checkpoint、PLY、SOG、work、token、`.env`。

最终提交后不要关闭 Issue；等 Mac 端独立复核和 Max 视觉验收。
