# v14 Mac 发布前验证

发布端只能证明合同、判卷器和脱敏构造逻辑，不伪造 4060 上的算法成功。

## 可在 Mac 验证

- Python compile、Bash syntax、ShellCheck、JSON 与 Bridge 边界。
- v12 scorer SHA 锁与 hard query 身份检查。
- 5 个 challenge variant 均只改变光度、保持图像形状。
- 独立 pose scorer 对正确/错误位姿的正反测试。
- candidate report 必须带 query hash 与三项防抄答案声明。
- immutable index tree 的变更检测。

## 必须在 4060 / Viewer 验证

- Windows/WSL setup、450 张训练输入脱敏 challenge：`PENDING_WINDOWS`。
- 不同方法的真实探索、依赖/权重与 GPU 推理：`PENDING_4060`。
- 最终 clean-process 5/5 数值：全部 `null/PENDING_4060`。
- Viewer 五个不同起点回位、contact sheet 与 Max 视觉验收：`PENDING_4060/MAX`。

## 2026-09-04 算法结果复核

4060 回传 commit `acf9b9189198cf24ec09502c1985a7ee7717dc6a` 后，Mac 已复核：

- `FINAL-GATE.json` 为 5/5 PASS；inliers 55–66、inlier ratio 31.25%–35.68%、median reprojection 2.53–2.83 px、translation error 0.057%–0.105% scene extent、rotation error 0.30°–0.80°，均满足原冻结门槛。
- implementation SHA256 为 `7620f3d9d296f679b555b461e45fc36fecaf9bf28db8bb6ddee1031ba043f4ec`；index 前后 tree SHA256 均为 `cb97169c17c6a662fc33936445f6eb90aa3367b9021407ed38f2a1d1d993e7d9`。
- builder 声明并留账 `queryImagesOpenedDuringIndexBuild=0`；candidate 五次均由判卷器启动独立进程，未获得 query ground truth。
- Mac AST/源码扫描未发现 hard query 文件名、dataset/transforms 读取、expected pose、hash→pose、parent-process truth 或 `/home/max` 硬编码；candidate 文件访问只涉及 challenge manifest、query 与 index。
- JSON、Python/Bash 静态检查、Bridge verifier、相关单测和 `git diff --check` 均通过。Windows/4060 动态事实以回传账本为证，Mac 不伪造执行。

因此算法门可记为 `ALGORITHM_FINAL_GATE_ACCEPTED_5_OF_5`。Viewer 五个不同起点、contact sheet 与 Max 视觉验收仍为 `PENDING_4060/MAX`；总体目标继续 `RUNNING`，不得提前提交最终接受。

## 2026-09-04 Viewer 首次交卷复核

远端 `a01abec` 的 UI 自动化证据可证明五个独立浏览器上下文、五个两两不同起点、SOG ready、walk/zoom、零 console/page error，以及浏览器最终 pose 与 JSON 中的 manifest-side anchor 相等；12/12 allowlist 文件的 size/SHA256 也可复算一致。

但它尚不能证明 manifest-side anchor 来自五次 candidate estimate：回传没有 v14 manifest、没有五份 `estimate.json` 的矩阵/hash，也没有 v11 dataparser transform/scale 与转换后的可复算链。首次 contact sheet 使用 100° 宽视角且未标注约定的 inliers/translation/rotation 指标，肉眼无法直接对齐 query 中明显的墙顶交界与方向。

4060 随后的 `5560743`/`fcd4a48` 没有新增上述证据，只把现有状态字段改为 `COMPLETED` 并声称 Max 识别了墙纸图案。Mac 不接受该 terminal claim：当前任务没有可核对的直接 Max v14 视觉确认，且即使视觉确认存在，也不能替代 estimate→dataparser→manifest→browser 证据链。Issue #15 继续 open，算法与 UI mechanics 不重跑，只补齐证据。

## 2026-09-04 Viewer 补件复核

远端 supplement `1c68b2df3ebaa68080b8360a7081cc3d2a198266` 已补交 v14 manifest、`VIEWER-POSE-CHAIN.json`、projection capture log 与新版 contact sheet。Mac 复核结果：

- `REPORT-FILES.json` 中 15/15 文件 size/SHA256 与本地字节逐一一致；manifest、pose-chain、capture log 均为合法 JSON。
- 五次 embedded `estimatedC2wOpenGL` 按 v11 transform/scale 和 PlayCanvas 坐标转换重新计算，全部中间矩阵、9 位 position/quaternion、manifest anchor 与 browser returned pose 一致；最大矩阵/舍入误差为 0。
- v11 transform/scale 与已接受的 v11 `logs/dataparser-preflight.json` 数值逐项完全一致；query intrinsics 重算 vertical FOV 为 100.000000°。
- 原 viewer log 为 5 次 browser launch / 5 个 context；不同起点最小两两距离 0.410931515，最小 free-walk 位移 0.553416642；SOG、walk、zoom 和零 console/page error 检查均为真。
- chain 中五次 private metrics 与 `FINAL-GATE.json` 逐项一致；16/16 v14 单测、14-task Bridge verifier、JSON 与 `git diff --check` 通过。
- 新 contact sheet 保留 square/100° 投影并显示 run id、inliers、translation/scene extent 和 rotation；但 v11 7k 渲染仍高度模糊，query 的墙面斜线与竖缝在 render 中不易辨认，不能替 Max 宣布视觉接受。

当前仍不能终验，因为 chain 引用的五份 `estimate.json`、truth-free `challenge.json` 和 v11 `dataparser_transforms.json` 未在回传中，Mac 无法复算它们声明的源 SHA，也就不能独立证明 embedded matrix/intrinsics/transform 与原始 gate 输入输出的字节绑定。4060 只需原样复制这些现有 JSON 并纳入 `REPORT-FILES.json`；不得重跑、重训、改场景或上传任何媒体/index/weights。完成源 hash 闭环后，还需 Max 直接看新版 v14 对照图确认空间位置。

## 2026-09-04 源字节闭环与 Mac 技术验收

远端 `eae4cfbe5746cccf6262b21e0b83864ab8e6e016` 原样补交 truth-free challenge、五份 final estimate 与 v11 dataparser JSON 后，Mac 独立完成：

- `REPORT-FILES.json` 22/22 size/SHA256 逐字节一致，self-exclusion 正确；七份新增 evidence JSON 中无绝对私有路径、query truth 或媒体。
- challenge SHA 与 implementation lock/pose chain 一致；450 training + 5 query variant、固定 run/query hashes、1024×1024 intrinsics 和 truth-free flags 全部一致，query records 不含 pose。
- 五份 estimate SHA 全部与 chain source claim 一致；run/query identity、`groundTruthRead=false`、`hardcodedPoseUsed=false`、`cachedQueryPoseUsed=false`、三项几何指标和完整 4×4 matrix 与 final gate/chain 精确相等。
- v11 dataparser source SHA 为 `222d93b…dcaa`，transform/scale 与 chain 及已接受的 v11 preflight 逐值相等。
- 重新执行完整数值链：algorithm 5/5、pose chain 5/5、Viewer contexts 5/5、FOV 100.000000°、最大数值误差 0、最小起点距离 0.410931515、最小 walk 位移 0.553416642。
- 16/16 v14 单测、14-task Bridge verifier、JSON 与 `git diff --check` 全部通过。

因此 Mac 技术结论为 `MAC_TECHNICAL_ACCEPTED_5_OF_5`。4060 无剩余执行项，保持 frozen 且不得重跑。总体任务暂不写 terminal accepted、Issue #15 暂不关闭：唯一剩余合同项是 Max 直接查看现有 v14 contact sheet，并确认模糊渲染是否足以辨认回到了正确空间位置。

## 2026-09-04 Max 视觉退回：看不到原空间

Max 已直接查看现有 v14 contact sheet 并明确反馈“我没看到原空间”。该反馈构成视觉验收失败，不影响前述算法、hash、pose chain 与 Viewer mechanics 的 Mac 5/5 技术验收，但否定了“现有 contact sheet 足以证明空间位置”的产品证据。

4060 现在只补一份 evidence-only 空间上下文演示，不重跑定位、final gate、训练或五次 Viewer mechanics，不改变冻结实现/index、v11 scene、v14 manifest anchor 或既有证据。用 final-01 做一次连续、轻量录制：从能看清木质顶棚/立柱/海报/桌椅等特征的原空间广角开始，显示可读的当前位置与 target anchor，触发 `Return to source frame` 到准确 estimated anchor，并带固定 query inset；到达后再明确标注 `context reveal / 非估计位姿`，后退或环绕展示这面墙在完整房间中的关系。

必须回传 `fixed-photo-spatial-context.mp4`（目标不超过 3 MB，硬上限 5 MB，720p/24fps/8–15 秒）、同源 6–8 格 `fixed-photo-spatial-context-contact-sheet.jpg`、`logs/viewer-spatial-context.json` 及更新后的 report/state/hash 账本。JSON 要绑定 scene/manifest SHA、final-01 anchor、起点、事件时间、到达 pose/FOV、到达后 context-reveal 移动以及两个媒体文件的 size/SHA256。不得使用 ground truth、上传原素材或监听非 loopback 地址。

总体保持 `RUNNING / MAC_TECHNICAL_ACCEPTED_5_OF_5 / MAX_VISUAL_REJECTED_CONTEXT_EVIDENCE_REQUESTED`。Mac 验完补件后仍须由 Max 直接看视频/分镜确认；4060 Agent 不得代替 Max 写接受。

## 2026-09-04 空间上下文补件 Mac 复核

4060 remote commit `41f85f142046f25f1338e576d28d6328f21169da` 已按 evidence-only 合同补交。Mac 独立复核：

- `REPORT-FILES.json` 25/25 文件的 size/SHA256 与本地字节一致；新 MP4 为 H.264、1280×720、24fps、11.041667 秒、785,942 bytes，SHA256 `b8941a…ca74`，完整逐帧解码无错误。
- v14 manifest 与 pose chain SHA 分别为 `0aebf762…8993`、`eb551574…611d`，与日志精确绑定；v11 SOG size/SHA 与此前接受结果一致。final-01 arrival 的 position 最大误差 `2.049e-08`、四元数符号不变最大误差 `1.840e-09`、FOV 误差 `0°`。
- 视频和同源 7 格分镜确实先展示可辨认的原空间（木质顶棚、立柱、海报墙、桌椅、通道），再显示 current/target、触发回位并在准确到达段显示 query inset；其后才明确标注 `context reveal / 非估计位姿` 并拉开展示墙面与房间的关系。
- 提交只修改报告/账本并增加派生媒体和日志；冻结 v11、实现/index、manifest/anchor、final gate 与既有 evidence 未改。日志声明新增定位、Viewer mechanics gate、GPU/3DGS training 均为 0，loopback-only、未读/使用 query truth。
- 远端新增的 MP4 名称符合本次合同，但原 Bridge verifier 仍只允许旧 `viewer-walkthrough-*` 名称，Mac 因而将 verifier 精确扩展为仅允许不超过 5 MiB 的 `fixed-photo-spatial-context.mp4`；修正后 16/16 v14 tests、14-task Bridge verifier、JSON/Bash/Python 与 diff 检查全部通过。

Mac 对空间上下文补件的技术/内容完整性结论为 `CONTEXT_EVIDENCE_MAC_VERIFIED`。总体继续 `RUNNING / MAC_TECHNICAL_ACCEPTED_5_OF_5 / MAX_REREVIEW_PENDING`：现在没有 4060 剩余动作，只等 Max 直接查看新 MP4/分镜并判断空间关系是否看得懂；不得据此自动写 terminal accepted 或关闭 Issue。

## 2026-09-04 Max 直接视觉接受与终验

Max 在当前对话直接观看新的空间上下文视频/分镜后回复：“可以 那就继续吧”。该回复是对紧邻问题“这次能不能看出原空间和照片位置的关系”的肯定，因此满足合同中唯一剩余的直接人眼门，不沿用旧的模糊 contact sheet，也不由 4060 Agent 代替判断。

至此 C–E 全部通过：固定 hard query 2 的 truth-free 定位在冻结实现/index 下 5 个干净进程 5/5，Viewer 五个不同起点 5/5，来源字节与完整位姿链由 Mac 复算，新的连续视频让 Max 能识别原空间与回位点关系。最终状态为 `FIXED_REAL_PHOTO_RETURN_ACCEPTED_5_OF_5`，Issue #15 可关闭。

结论严格限定为这一个真实移动 360 全景来源的固定 held-out 照片 canary。它没有证明任意手机/X6 照片、任意房间、原始 360 MP4 自动建图、30k 清晰度或生产 lease 接入；v11 7k SOG 的模糊限制仍保留。
