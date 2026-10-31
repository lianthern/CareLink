# v14 持续目标：让固定实图稳定回到 v11 空间

## 当前执行状态（2026-09-04）

算法门已经通过，整体目标尚未完成。4060 Agent 的 `alexnet-superpoint-lightglue-training-track-v1` 只用 450 张 training views 建成 2,042 个 training pairs、381,601 条 accepted observations 的 immutable index；builder 打开 query 数为 0。冻结实现 SHA256 为 `7620f3d9d296f679b555b461e45fc36fecaf9bf28db8bb6ddee1031ba043f4ec`，index tree SHA256 为 `cb97169c17c6a662fc33936445f6eb90aa3367b9021407ed38f2a1d1d993e7d9`。private final gate 的五个干净进程全部通过，且 index 前后 hash 不变。Mac 第一轮静态和账本复核也已通过。

现在冻结上述实现与 index，不再重跑或调参。唯一剩余执行门是 Viewer 5/5：新建 v14 manifest，用五次实际 `estimatedC2wOpenGL` 经 v11 dataparser 的真实 transform/scale 转换后，从五个不同 free-walk 起点分别回到估计位置，验证 SOG、walk、zoom、错误数，并回传 contact sheet。Viewer 和 Max 视觉验收前，状态继续保持 `RUNNING`。

## 完成后的世界

固定 hard query 2——来自真实移动 360 全景的 held-out 透视照片——能够只凭图像内容和 training-only 参考资料自动估计 pose。最终实现锁定后，同一照片的 5 个无几何变化版本分别从 5 个干净进程定位成功，并在 v11 SOG 的独立 Viewer manifest 中从 5 个不同起点回到估计位置；随后交给 Mac 端独立验收。

本目标是 Max 2026-09-04 将成功标准主动收窄后的 **fixed-photo vertical slice**。它不要求这一轮证明任意手机/X6 照片都能定位，但也绝不允许通过硬编码该照片真值来制造成功。

优先级：真实回位正确 > 不读取/硬编码答案 > 不破坏 v11 > 方法做得全 > 做得快。

## 活动真相

- GitHub Issue：[Issue #15](https://github.com/maxi-max-dev/max-agent-bridge/issues/15)；Issue 保持 open，直到 Mac 端终验通过。
- 可看空间基线：v11 `PANORAMIC_POSEFIX_ACCEPTED_7K` / `360roam-base-posefix-r001`。
- hard query 基线：v13 `val_1_0027__right`，4,880 keypoints、56 ratio matches、0 PnP inlier，`PHOTO_RELOCALIZATION_MULTIVIEW_PARTIAL_2_OF_3`。
- 判卷器：`inputs/scripts/linux/run_v14_final_gate.py`；它单独读取真值评分，但不会把源 dataset 路径或 query pose 传给 candidate process。
- 真值隔离输入：`prepare_fixed_query_challenge.py` 生成 450 张 training images/poses 与同一 query 的 5 个仅光度变化版本；`challenge.json` 不含 query pose 和源 dataset 路径。

## 范围与授权

你可以基于证据更换定位方法、局部特征、检索、几何验证、PnP 策略与开源依赖，直到完成。推荐先验证以下假设，但这不是强制实现清单：

1. 用 global retrieval 或低成本相似度先选 top-K 局部参考帧；
2. 在 query 与候选参考帧间做 mutual local matching；
3. 用 Essential/Fundamental/Homography RANSAC、covisibility cluster 与 spatial-grid quotas 去掉不一致对应；
4. 只把几何通过的 2D 对应提升到 training-only 3D tracks，再做 PnP；
5. 传统 SIFT 仍不够时，可在隔离 v14 环境尝试 HLoc、pycolmap、SuperPoint/LightGlue、LoFTR 或其他免费本地方法。

允许：

- 在 `/home/max/src/unseen-3dgs-sceneworker/work/v14-photo-return-goal/` 内创建隔离代码、venv、index、模型缓存与实验输出；
- 使用 CPU 或 RTX 4060 做照片特征/检索/几何定位；
- 从项目官方或原作者 HTTPS 来源下载免费开源包/权重，但必须记录 URL、版本、SHA256 和许可证；
- 多轮开发实验，每次基于上一轮证据改变方法，并写入 `EXPERIMENTS.json`。

不允许：

- 读取 query 的 `transform_matrix`、原始 `transforms.json`、v12/v13 中该 query 的真值或预先计算 pose；candidate 只能读取 truth-free challenge；
- 在代码、index、配置或 Viewer 中写死 query 的 pose、原始文件名、相机 ID、预期位置/旋转；
- 替换照片、改变 5 个冻结变体、降低五项既有门槛，或把 query 的 hash→pose 查表称为定位；
- 重训/续训/改写 v11 3DGS、checkpoint、PLY 或 SOG；运行 7k/30k；
- 连接生产 API/数据库、使用付费 API/真实 token/私密素材、开放 LAN/公网端口；
- 向 GitHub 上传源图、单独 query、training views、模型权重、feature/index、checkpoint、PLY、SOG 或 work 目录。

## 续跑方式

这不是“一种方法失败就结束”的 frozen run：

1. 先运行 README 的唯一 setup，生成 truth-free challenge。
2. 从 v12/v13 两条基线开始记录 `EXPERIMENTS.json`；每个新方法写 hypothesis、代码/依赖 hash、关键指标、失败原因和下一决定。
3. 同一实现的安全调试可重跑；同一失败动作最多直接重试 3 次，之后必须基于新证据改变方法。
4. 每完成一个有信息量的方法，向 Issue 写一条简短进展并推送不含素材的 `EXPERIMENTS.json`/`STATE.json`。不要把每条命令都变成回执。
5. 算法失败不允许提交 terminal `BLOCKED`；继续下一种有依据的方法。只有全部合理本地路径都受外部权限/缺失输入阻断时，才写清每条死路和唯一解锁条件。
6. 某个候选在开发测量中达到 5/5 后，冻结其实现和完整 index tree SHA256；另建全新输出目录运行最终 gate。最终失败就回到探索，不能删掉该失败记录。
7. 算法最终 5/5 后再做 Viewer；Viewer 也全过才提交 `COMPLETED`，等待 Mac 终验，不自行关闭 Issue。

## 随包首个方法

唯一 PowerShell 入口会在 setup 后直接测量两个互相独立的 truth-free 假设。第一条是 `training-pose-epipolar-sift-track-v1`：v13 的错误来自把任意邻近 keypoint 绑定到投影 landmark；新方法只保留在两个已知训练相机之间通过 mutual RootSIFT、已知位姿 epipolar 误差、正深度和重投影误差的**原始 keypoint track**，query 再对检索到的局部参考帧做 PnP。

- builder：`inputs/scripts/linux/build_v14_sift_track_index.py`，严格不打开 query；
- candidate：`inputs/scripts/linux/localize_v14_sift_track.py`，符合下方 final CLI；
- runner：`inputs/scripts/linux/Run-V14-Sift-Track-V1.sh`，五个干净开发进程并自动追加安全实验账本；
- 依赖：沿用现有 NumPy + OpenCV SIFT，不联网、不装包、GPU inference=0。

第二条是 `content-verified-nearest-training-camera-v1`：如果 3D association 仍不可信，就让 query 与检索候选做 mutual RootSIFT，并用 Homography/Fundamental RANSAC 验证内容确实相同，再返回最强候选训练相机的已知 pose。它是合法的 coarse localization，不声称精确恢复 query pose；是否落在 15% scene extent / 15° 内必须由 private scorer 判定。

- candidate：`inputs/scripts/linux/localize_v14_verified_retrieval.py`；
- runner：`inputs/scripts/linux/Run-V14-Verified-Retrieval-V1.sh`；
- 与第一条复用同一个 training-only immutable index，不读 query 真值、不写 index。

若两者 miss，不得反复原样重跑；先根据每个 run 的 reference matches、selected camera、PnP 与 private score 证据决定是增强 covisibility，还是改用 learned local features。

## 方法 3：ALIKED + LightGlue（已发布，前两法 miss 后运行）

方法 1 在真实 4060 上最多只有 5 个 PnP inliers，方法 2 五次均无通过局部验证的训练相机，因此第三条改为 learned local matching，而不是继续调 SIFT ratio。它使用固定提交的 ALIKED+LightGlue 在 query 与经过平衡检索的训练视图间匹配，再把训练侧 learned keypoint 就近关联到**既有 immutable training-only SIFT 3D tracks**，最后仍以真实 3D→2D PnP 和重投影误差判定。

- builder：`inputs/scripts/linux/build_v14_aliked_lightglue_index.py`，仅为 450 张 training views 建 ALIKED feature cache，复制并锁定旧 3D tracks，`queryImagesOpened=0`；
- candidate：`inputs/scripts/linux/localize_v14_aliked_lightglue.py`，对每个 query 独立提特征，以全局 + 每方向平衡检索防止低纹理图被单一方向排除，并测试预先固定的 3/5/8px learned→track 关联半径；
- runner：`inputs/scripts/linux/Run-V14-Aliked-LightGlue-V1.sh`，只在隔离 work 目录拉取官方仓库与两份权重，逐项校验 commit、license SHA 与 weight SHA，不 pip install、不写系统环境、不开放端口；
- 来源：`cvg/LightGlue@eb42fee2d71449efb0aa5c10549752b5d75384d8`；LightGlue Apache-2.0、ALIKED 依上游 README 为 BSD-3-Clause；权重 SHA 已冻结在 runner/index；
- 该方法允许 RTX 4060 推理但 GPU training 仍为 0。只有内部 5/5 后才能跑 private final scorer；内部 miss 仍继续 Goal。

前两法已经留账本的机器，续跑方法 3：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-photo-return-goal-2026-09-04-v14\inputs\scripts\windows\Start-V14-Goal.ps1" `
  -ConfirmPersistentGoal `
  -LearnedMethodOnly
```

## Candidate CLI 合同

最终实现必须是一个可审计 Python 入口，接受：

```text
--challenge-manifest <truth-free challenge.json>
--query <one frozen query variant>
--index-dir <already built immutable training-only index>
--report <new estimate.json>
--run-id <final-01..final-05>
```

每个 `estimate.json` 至少输出：

```json
{
  "schemaVersion": "1.0",
  "runId": "final-01",
  "querySha256": "<current input hash>",
  "groundTruthRead": false,
  "hardcodedPoseUsed": false,
  "cachedQueryPoseUsed": false,
  "geometricInliers": 20,
  "geometricInlierRatio": 0.1,
  "medianReprojectionPx": 3.5,
  "estimatedC2wOpenGL": [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1]]
}
```

示例里的数字只是字段形状；实际值必须由该次 query 计算。candidate 不得调用判卷器或读取其父进程参数来取得真值。

## 仅在以下全部成立时完成

1. **算法 5/5：** 最终锁定实现由判卷器启动 5 个新进程，五个冻结光度变体逐一满足 inliers `>=20`、inlier ratio `>=10%`、median reprojection `<=3.5px`、position error `<=15% scene extent`、rotation error `<=15°`。
2. **可重复且无缓存答案：** implementation SHA 固定；index tree 在五次运行前后 SHA 不变；每次 query SHA 与冻结输入一致；无 cached query pose、truth read 或 hardcoded pose。
3. **Viewer 5/5：** 新建 v14 manifest，不覆盖 v11；从 5 个不同 free-walk 起点点击固定照片后都使用对应运行的 estimated pose 回位；`SOG ready`、walk/zoom 正常、console/page error 为 0，只监听 loopback。
4. **外层视觉证据：** 一张 `hard-query-localized-contact-sheet.jpg` 展示照片与五次 localized render，Max 能判断确实回到同一正确空间位置；不能用 ground-truth render 冒充。
5. **可审计交付：** 最终代码、implementation/index lock、依赖来源、完整实验账本、FINAL-GATE、Viewer E2E、结果摘要和文件 SHA allowlist 全部回传；Mac 端能独立复算 5/5。
6. **不越界：** v11 资产未修改；3DGS/GPU training runs、7k/30k、生产/付费调用、私密素材、LAN/公网监听和禁止上传物均为 0。用于照片定位的 GPU 推理必须单独如实计数。

最终状态只有 `FIXED_REAL_PHOTO_RETURN_ACCEPTED_5_OF_5` 才代表完成；任何部分结果都保持 `RUNNING`，不能写“基本成功”。这个状态只证明固定实图 canary，不得扩大为任意照片定位能力。
