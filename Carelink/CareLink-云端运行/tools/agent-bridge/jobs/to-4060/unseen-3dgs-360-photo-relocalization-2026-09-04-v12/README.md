# v12 P0：让三张留出照片自动回到 v11 的 360 空间

GitHub Issue：[Issue #13](https://github.com/maxi-max-dev/max-agent-bridge/issues/13)

v11 已由 Max 验收为首个“能看、能走”的移动 360 场景。v12 不重训、不跑 30k，也不把已知相机坐标直接塞进按钮；它只回答下一件事：**给系统一张未参与训练的照片，它能否从照片内容估计出拍摄位置和方向，并在 v11 Viewer 中回到那里。**

本轮仍是隔离研究 canary。查询图来自 v11 冻结的 90 张 held-out 虚拟照片，不是 Max 的私密照片，也不证明任意手机/X6 照片已经可用。

## 4060 Agent 唯一入口

在 Windows PowerShell 拉取后先登记收件：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-360-photo-relocalization-2026-09-04-v12" `
  -State "RECEIVED_VERIFIED" `
  -Message "v12 photo relocalization task received; v11 frozen; GPU and production off."
```

完整阅读本文件、`ACCEPTANCE.md`、`MAC-VERIFICATION.md`、`TASK.json` 和 `STATUS.json`，然后执行唯一入口：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-360-photo-relocalization-2026-09-04-v12\inputs\scripts\windows\Start-V12-Relocalization.ps1" `
  -ConfirmResearchCanary
```

脚本只在 WSL ext4 中运行 CPU/OpenCV 定位；它显式隐藏 CUDA，不会启动 Nerfstudio、修改 checkpoint/SOG、下载素材、监听端口或连接生产。

## 冻结输入

- 父任务：`unseen-3dgs-360roam-posefix-2026-09-04-v11`。
- 场景：`sceneRevisionId=360roam-base-posefix-r001`。
- 必须复用已验收 v11 的 `450 train + 90 held-out` 数据、`transforms.json`、本机 Viewer 与 SOG。
- v11 最终状态必须是 `PANORAMIC_POSEFIX_ACCEPTED_7K`；若本地 cache、Viewer 或 SOG 已丢失，提交 `BLOCKED`，不得重下 674MB、重训 7k 或改跑 30k。
- 作者 `scene.ply`、v10 checkpoint/PLY/SOG 继续禁止使用。

三张查询照片由脚本确定性冻结，避免看结果后换图：

1. 第 2 个 held-out panorama 的 `front`；
2. 中间 held-out panorama 的 `right`；
3. 倒数第 2 个 held-out panorama 的 `left`。

它们必须全部属于 `val_filenames`，且不在 `train_filenames`。查询图的真值 `c2w` 在定位时不得进入特征地图、检索、匹配或 PnP；只允许在估计完成后计算误差。

## Phase A：真正的 image-to-pose 定位

冻结脚本会：

1. 只用 450 张 training views 及其相机位姿，从相邻训练机位的 SIFT 匹配自行三角化参考 3D 特征地图；
2. 不读取 held-out 图来建图，不读取作者 PLY，也不把 v11 SOG 当几何真值；
3. 对三张查询图提取 SIFT，匹配到 reference 3D descriptors；
4. 用 `solvePnPRansac` + LM refine 独立估计 camera pose；
5. 估计完成后才读取对应 held-out `c2w` 做误差评分。

每张图必须同时满足：

- PnP inliers `>=20`；
- inlier ratio `>=10%`；
- inlier median reprojection `<=3.5px`；
- position error `<=15%` 的 training camera path 3D extent；
- rotation error `<=15°`。

正式通过要求 **3/3**。2/3 只能写 `PARTIAL`，不能写成功；1/3 或 0/3 为 `FAIL`。第一次官方结果出来后不得换查询图、放宽阈值或反复试参数挑最好成绩；失败就保留证据回传。

## Phase B：把估计结果接进现有 Viewer

仅在 Phase A 3/3 通过后继续，不得启动 GPU：

- 复用 v11 实际 dataparser transform/scale 和 Viewer manifest 生成逻辑，把三组 `estimatedC2wOpenGL` 转为 Viewer camera pose；
- 新建 v12 本地 scene manifest，不覆盖 v11 manifest；三个照片按钮必须引用**估计 pose**，不得引用 held-out 真值 pose；
- 每个按钮显示 384×384 本地低清 query thumbnail；点击后从任意 free-walk 位置回到估计机位；
- 对每张图生成一张 `query | localized Viewer render` 并排图，并在图上写 position/rotation/inliers；
- 浏览器 E2E 要验证 `SOG ready`、三按钮都可从走动位置返回不同估计机位、camera 数值来自定位报告、zoom/walk 仍正常、console/page error 为 0；
- Viewer 只监听 `127.0.0.1:8765` 或既有 v11 loopback 端口，不开放 LAN/公网。

若算法 3/3 通过但 Viewer 转换或展示失败，最终仍是 `BLOCKED`，不能把纯 JSON 指标包装成用户能力。

## 回传

只提交：

```text
results/from-4060/unseen-3dgs-360-photo-relocalization-2026-09-04-v12/
  V12-REPORT.md
  V12-RESULT.json
  REPORT-FILES.json
  logs/photo-relocalization.json
  logs/viewer-e2e.json
  query-1-localized-compare.jpg
  query-2-localized-compare.jpg
  query-3-localized-compare.jpg
  viewer-overview.png
```

并排图必须缩到每张 `<=2MiB`，只作为公开数据集 canary 的小型验收证据。禁止回传原始/单独 query、源 panorama、450/90 views、位姿源文件、特征地图、descriptor、checkpoint、PLY、SOG、work、`.env`、token。

最终状态只能是：

- `PHOTO_RELOCALIZATION_ACCEPTED_3_OF_3`
- `PHOTO_RELOCALIZATION_PARTIAL_2_OF_3`
- `PHOTO_RELOCALIZATION_FAILED`
- `BLOCKED`
- `FAILED`

不管结果如何，本任务均无 7k/30k 训练权限，不接生产 API、数据库、租约、付费 API，也不创建公网或 LAN 端口。
