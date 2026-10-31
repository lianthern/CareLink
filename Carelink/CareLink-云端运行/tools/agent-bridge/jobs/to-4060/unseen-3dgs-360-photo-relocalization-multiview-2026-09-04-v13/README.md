# v13 P0：同三张照片的低纹理多视角定位修复

GitHub Issue：[Issue #14](https://github.com/maxi-max-dev/max-agent-bridge/issues/14)

v12 的单次冻结运行已经证明 3D 地图和照片回位链路基本成立，但固定 query 2 只有 13 个 ratio matches，PnP 失败，最终只能算 `PHOTO_RELOCALIZATION_PARTIAL_2_OF_3`。v13 **不换照片、不降门槛、不重训 3DGS**；只增强 training-only 参考描述，正面修复低纹理匹配不足。

这是隔离研究 canary。输入仍是公开 v11 数据里三张冻结 held-out 虚拟照片，不是 Max 的私密照片，不接生产 API，也不证明任意手机/X6 照片已经可用。

## 4060 Agent 唯一入口

在 Windows PowerShell 拉取后先登记收件：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-360-photo-relocalization-multiview-2026-09-04-v13" `
  -State "RECEIVED_VERIFIED" `
  -Message "v13 received; same v12 queries and gates; CPU-only multiview descriptor canary."
```

完整阅读本文件、`ACCEPTANCE.md`、`MAC-VERIFICATION.md`、`TASK.json` 和 `STATUS.json`，然后只运行一次：

```powershell
& "$HOME\AgentBridge\control\jobs\to-4060\unseen-3dgs-360-photo-relocalization-multiview-2026-09-04-v13\inputs\scripts\windows\Start-V13-Multiview-Relocalization.ps1" `
  -ConfirmResearchCanary
```

脚本只在 WSL ext4 中运行 CPU/OpenCV；显式隐藏 CUDA，不安装环境、不下载素材、不启动 Nerfstudio、不修改 checkpoint/SOG、不监听端口、不连接生产。

## 冻结基线与不可改变项

- 父场景：v11 `PANORAMIC_POSEFIX_ACCEPTED_7K`，`sceneRevisionId=360roam-base-posefix-r001`。
- 基线结果：v12 `PHOTO_RELOCALIZATION_PARTIAL_2_OF_3`，query 1/3 通过、query 2 PnP 失败。
- 数据：原样复用 v11 的 450 train / 90 held-out、`transforms.json`、SOG 和 Viewer；缺失就提交 `BLOCKED`，不得重下 674MB、重训 7k 或跑 30k。
- query 仍是：第 2 个 held-out panorama 的 `front`、中间 panorama 的 `right`、倒数第 2 个 panorama 的 `left`。
- 每图门槛仍是：inliers `>=20`、inlier ratio `>=10%`、median reprojection `<=3.5px`、position error `<=15% scene extent`、rotation error `<=15°`。
- 正式通过仍要求 **3/3**。不能替换 query 2、改变 split、降低门槛，或看结果后调参重跑。

## v13 唯一算法变化

v13 继续调用冻结的 v12 training-only 三角化代码，参考地图几何不变。新定位器只做四项增强：

1. 在 400 张 horizontal training views 上重新检测最多 5,000 个 SIFT 特征；
2. 把训练图特征投影关联到已有 3D landmark，每点最多保留 6 个不同训练视角描述；
3. reference/query 描述均转换为 RootSIFT；
4. ratio test 的第二近邻必须属于另一个 3D landmark，避免同一点的多个描述互相污染比值。

held-out query 不参与建图、描述库构建或参数选择；其真值位姿只在 PnP 结束后评分。`ratio=0.82`、association radius `3.5px`、每点 6 个观察均已冻结；官方结果后不得调整。

## Phase A：一次性 3/3 定位

入口先验证 v11/v12 冻结结果、依赖、WSL ext4 路径、剩余磁盘和本地单测，再生成：

```text
/home/max/src/unseen-3dgs-sceneworker/work/v13-photo-relocalization-multiview/
  photo-relocalization-multiview.json
  local-evidence/query-1.jpg
  local-evidence/query-2.jpg
  local-evidence/query-3.jpg
```

若脚本非零退出，保留该唯一官方结果，提交 `BLOCKED`；不要删报告、换图或重跑。若 3/3，则进入 Phase B，但仍不启动 GPU。

## Phase B：把三组估计 pose 接入 v11 Viewer

仅在 Phase A 3/3 后执行：

- 复用 v11 已验证的 dataparser transform/scale 与 Viewer manifest 逻辑；
- 新建独立 v13 scene manifest，不覆盖 v11；三个按钮必须读取 v13 报告内的 `estimatedC2wOpenGL`，禁止复制 held-out 真值；
- 每个按钮带 384×384 query 缩略图，从任意 free-walk 位置可回到三个不同估计机位；
- 生成三张 `query | localized Viewer render` 并排图，标注 position/rotation/inliers；
- 浏览器 E2E 证明 `SOG ready`、三按钮数值来自 v13 报告、walk/zoom 正常、console/page error 为 0；
- Viewer 只允许既有 loopback 或 `127.0.0.1:8765`，不开放 LAN/公网。

Phase A 通过但 Phase B 未完成或失败，最终仍是 `BLOCKED`，不能宣称“照片已能回到空间”。

## 回传合同

只提交：

```text
results/from-4060/unseen-3dgs-360-photo-relocalization-multiview-2026-09-04-v13/
  V13-REPORT.md
  V13-RESULT.json
  REPORT-FILES.json
  logs/photo-relocalization-multiview.json
  logs/viewer-e2e.json
  query-1-localized-compare.jpg
  query-2-localized-compare.jpg
  query-3-localized-compare.jpg
  viewer-overview.png
```

并排图每张 `<=2MiB`。禁止提交单独/原始 query、源 panorama、450/90 views、pose 源文件、feature map、descriptor bank、checkpoint、PLY、SOG、work、`.env`、token。

最终状态只能是：

- `PHOTO_RELOCALIZATION_MULTIVIEW_ACCEPTED_3_OF_3`：Phase A 3/3 且 Phase B 全部通过；
- `PHOTO_RELOCALIZATION_MULTIVIEW_PARTIAL_2_OF_3`：仅 2/3；
- `PHOTO_RELOCALIZATION_MULTIVIEW_FAILED`：1/3 或 0/3；
- `BLOCKED` 或 `FAILED`。

无论结果如何：GPU optimization runs、7k/30k、生产调用、付费 API、素材下载、SOG/checkpoint 写入均必须为 0。
