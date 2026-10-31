# v14 验收合同

## A. 目标与输入

- [x] 目标照片精确为 v13 hard query 2；来源是实拍 360 全景的 held-out 透视图，不替换图片。
- [x] challenge 含 450 张 training images/poses 和同一 query 的 5 个仅光度变化版本；没有 query ground truth 或源 dataset 路径。
- [x] v11 保持 `PANORAMIC_POSEFIX_ACCEPTED_7K` / `360roam-base-posefix-r001`，v13 baseline 保持 56 matches / 0 PnP inlier。

## B. 探索过程可信

- [x] `EXPERIMENTS.json` 包含 v12/v13 基线及每个实质不同的 v14 方法：hypothesis、实现/依赖 hash、指标、失败原因、下一决定。
- [x] 失败后基于证据换方法；没有删掉失败、只上报最好一次或把算法失败写 terminal `BLOCKED`。
- [x] 新依赖/权重来自免费官方或原作者 HTTPS 来源，记录版本、SHA256、许可证；无付费 API、真实 token 或私密素材。

## C. 防抄答案

- [x] candidate 只接受 truth-free challenge；代码与配置不打开原始 dataset/transforms、v12/v13 query truth 或 scorer 父进程参数。
- [x] 最终源码/index/config 中没有 hard query 原始文件名、camera ID、expected pose、query-hash→pose 查表或其他硬编码答案。
- [x] 每次输出当前 query SHA，并声明 `groundTruthRead=false`、`hardcodedPoseUsed=false`、`cachedQueryPoseUsed=false`；Mac 端代码审计与独立评分一致。

## D. 算法重复成功

- [x] final implementation SHA 与 `IMPLEMENTATION-LOCK.json` 一致；index tree 五次运行前后 SHA 一致。
- [x] 判卷器启动 5 个干净 candidate 进程；`final-01..05` 均返回有效 4×4 OpenGL c2w。
- [x] 五次均满足：geometric inliers `>=20`、inlier ratio `>=10%`、median reprojection `<=3.5px`、position error `<=15% scene extent`、rotation error `<=15°`。
- [x] `FINAL-GATE.json` 精确为 `cleanProcessRunsPassed=5`、`allPassed=true`、`queryGroundTruthPassedToCandidate=false`。

## E. Viewer 真回位

- [x] v14 独立 manifest 使用最终 estimated poses，不覆盖 v11，也不读取 held-out 真值。
- [x] 从 5 个不同 free-walk 起点均能点击照片回到对应估计位置；五次为不同启动/浏览器上下文，不是同一状态循环截图。
- [x] `SOG ready`、walk/zoom 正常、console/page error 为 0，只监听 loopback。
- [x] 一张 contact sheet 同时展示固定照片与五次 localized render；没有 ground-truth render 冒充。
- [x] 一段不超过 5 MB 的连续轻量视频先清楚展示可辨认的原空间，再显示当前位置/目标点并触发回位，最后从 estimated anchor 拉开显示它与房间的空间关系。
- [x] 一张来自同一连续录制的 6–8 格分镜图，至少包含原空间广角、地图当前点/目标点、回位动作、带 query inset 的准确到达画面、明确标注的到达后空间揭示。
- [x] `logs/viewer-spatial-context.json` 将 final-01 anchor、起点、事件时间、到达时准确 pose/FOV、到达后 context-reveal 移动与视频/分镜 SHA256 完整绑定；只用 loopback 且未读取 ground truth。
- [x] Max 人眼确认“这张照片确实回到正确空间位置”。

## F. 最终口径与安全

- [x] 只有 C–E 全部通过才写 `FIXED_REAL_PHOTO_RETURN_ACCEPTED_5_OF_5`；否则继续 `RUNNING`。
- [x] 最终结论明确限定为 fixed-photo canary，不宣称任意手机/X6 照片已可定位。
- [x] 3DGS/GPU training、7k/30k、v11 修改、生产/付费调用、私密素材、LAN/公网监听和禁止上传物均为 0；照片定位 GPU 推理次数如实记录。
- [x] `REPORT-FILES.json` 自排除，逐文件 size/SHA256 正确，回传严格符合 README allowlist。
