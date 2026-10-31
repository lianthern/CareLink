# v11 4060 pose-fix 实测报告

最终状态：`PANORAMIC_POSEFIX_ACCEPTED_7K`

v11 已修正 v10 的 pose convention 问题，完成 0-GPU 坐标/图像硬门、一次且仅一次全新 7k Splatfacto 训练、90/90 冻结留出视角评估、PLY→SOG→PLY 往返、Viewer 技术测试、六方向视觉审阅和 10.3 秒漫游录屏。技术门与用户空间门均通过；依合同停止于 7k，未运行 30k。

## 旧结果隔离与输入门

- v10 保持 `REJECTED / POSE_CONVENTION_BUG`；未续跑 v10 checkpoint，也未运行 v10/v11 30k。
- 复用 v10 已缓存的 60 张冻结全景和作者 pose cache，60/60 bytes/SHA256 复核通过，没有重新下载约 674 MB。
- 作者 `scene.ply` 未下载、读取、复制或用于训练；3D seed 完全由本任务的透视图和相机位姿自行三角化。
- 使用 `opencv c2w @ Ry(yaw) @ Rx(pitch) @ diag(1,-1,-1,1)` 转为 OpenGL c2w；pixel-ray 合成方向测试通过。
- 真实相邻全景 SIFT + 极线门共 49 个可评估 pair，46 个通过；通过 pair 的中位极线残差为 `0.250765 px`，低于 `2.5 px` 上限。
- 自行三角化并体素化得到 `6,465` 个 seed points，高于 `3,000` 硬门；`usesAuthorScenePly=false`。
- 数据集为 60 张源全景 × 9 个视角，共 540 张 `1024×1024`、100° FOV pinhole JPEG；保留 8 个水平重叠视角和 up，排除 down，冻结为 450 train + 90 val。
- Nerfstudio dataparser 实读 450 train + 90 val，split 不重叠，均为 perspective，位置范围非零，`load3DPoints=true`。

## 一次全新 7k

- 只执行一次真实优化：step `0–6999`，共 7000 步，exit code 0，无 OOM。
- 用时 `314 s`，峰值显存 `4,868 MiB`；GPU 为 NVIDIA GeForce RTX 4060 Laptop GPU。
- Splatfacto 配置为 scale regularization 开启、camera optimizer off、`random-init=false`、`load-3D-points=true`。
- Nerfstudio `1.1.5`、PyTorch `2.1.2+cu121`、CUDA `12.1`。
- checkpoint 为 `675,006,034` bytes，SHA256 `0f9454b2075f1f1a6f499b9abd305e75a04400262d142098ded596c68f6049e9`；config SHA256 `441ba6a94bd3b6a47d58d8c4615c002855fb38870d3d06967d404ced9b90b1fc`。二者仅留在 WSL ext4，未上传。

## 冻结评估与导出

- 90/90 冻结留出视角完成 PSNR、SSIM、LPIPS 测量。
- 均值：PSNR `21.060860`、SSIM `0.714674`、LPIPS `0.453167`，三项均通过合同拒收线。
- 最差值：PSNR `16.715521`、SSIM `0.585086`、LPIPS `0.600741`；合同以整体均值作直接拒收判断，逐视角结果如实保留在日志中。
- 原始 PLY：`939,406` Gaussians，`232,974,281` bytes，SHA256 `edfea6b04a4d76b2a78d7c8ee8ae843dd5b8818a37a2227b74ee29f3b0ab4a7d`。
- 最终 SOG：SH1、`939,406` Gaussians，`14,148,061` bytes，SHA256 `00c9e28b4285b7b05c870f91220ae01e348c141c36ed0dce5d6bc9b603f71680`。
- 往返 PLY：`939,406` Gaussians，`86,425,930` bytes，SHA256 `0cf96bf16537f38486f8d92350b4761a38b1d26cdbc62916455b3184bf2d15ce`；Gaussian 数保持一致。
- 使用 v10 已验证的有界 GPU SH1 / 1 次 k-means 路径，转换耗时 `47.494 s`。v11 合同没有 SH2 要求。

## Viewer 与用户空间门

Viewer 只绑定 `127.0.0.1:8765`。manifest 校验和技术 E2E 均为 PASS：SOG ready、平视起步、roll 0、固定眼高、zoom、前进/横移、正常速度、3× sprint、边界约束、两轴路径返回、六方向 drag look、FOV/速度/mode UI 和零 console/page error 全部通过。实测 normal distance `0.236642`，sprint distance `0.709927`，比例 `2.999998`；路径返回误差 `0.003765`。录屏为 H.264 `1280×720`、`10.3 s`、`784,689` bytes，真实展示 zoom → walk → sprint → look up/down → walk。

六方向和漫游关键帧已逐张审阅。front/back/left/right 能稳定辨认同一室内空间，up 能辨认梁、灯和天花板，down 能辨认地面；柱、墙、桌椅等前后遮挡关系随两轴移动稳定变化，不是单张全景贴图推拉。与 v10 同类证据相比，大块灰雾和 pose 崩塌已消失。近遮挡和极端俯视区域仍有 7k 级柔化，但不主导画面，也不影响空间可辨识性。因此用户空间门判定 PASS。

照片回位明确不在 v11 范围，未作为门槛测试。

## 存储与安全

源全景、作者位姿、540 张训练/验证视图、sparse seed、checkpoint、PLY、SOG 和 work 均只留在 WSL ext4；GitHub 回传目录只含合同允许的报告、脱敏 JSON、小图和小于 15 MiB 的录屏。

未连接生产或付费 API，未安装额外包，未改 firewall，未监听 LAN/公网，未上传 token 或 `.env`。本任务没有 30k 权限，实际 30k 运行次数为 0。
