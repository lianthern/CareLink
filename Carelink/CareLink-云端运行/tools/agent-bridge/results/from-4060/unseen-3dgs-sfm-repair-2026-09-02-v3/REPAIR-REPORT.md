# v3 SfM 修复与 7k preview 报告

状态：`COMPLETED`

候选 1 `SIMPLE_RADIAL_AUTO` 修复了原 OPENCV 解的非方形像素问题，并通过 SfM、唯一一次 7k、PLY/SOG 和 Viewer 全部门槛。候选 2/3 按顺序约束未运行；没有 30k 训练，v1/v2 基线哈希未变化。

## SfM

- 复用 byte-identical baseline SIFT features 与 exhaustive matches，只更换单相机模型为 `SIMPLE_RADIAL`。
- 胜出模型注册 72/72 帧，7382 points、71485 observations、mean track 9.684、mean reprojection 1.037 px。
- 单焦距 `f=1001.970 px`，`fx/fy=1.0`；principal point `(645.066,350.034)`，相对画面中心仅偏 `(5.066,-9.966) px`。
- `k1=0.771874` 的校正幅度较大，因此没有只凭重投影残差接受：三张去畸变 anchor、7k 三锚点、raw PLY/SOG 和真实 Viewer 均继续验证；直线正常，未见强鱼眼或非均匀拉伸。

## 唯一一次 7k

- 只运行一次新 preview 7k，step 6999，wall 168 秒，峰值显存 3347 MiB，OOM 0。
- 指标参考是把 Nerfstudio/OpenCV 的同一去畸变投影直接施加到原始 JPEG 后得到的 target，而不是拿畸变 raw 像素与 pinhole render 错位比较。
- 三锚点：
  - frame_00001：PSNR 23.824、SSIM 0.9402、LPIPS 0.1367；
  - frame_00036：PSNR 29.454、SSIM 0.9595、LPIPS 0.0947；
  - frame_00072：PSNR 33.821、SSIM 0.9641、LPIPS 0.0591。
- 三张全部通过 PSNR ≥20、SSIM ≥0.80、LPIPS ≤0.30；人工检查 coherent，无强鱼眼、径向拖影和大片 warped sheets。

## PLY、SOG 与 Viewer

- raw PLY 147,769 Gaussians，三锚点与 checkpoint 像素完全一致。
- SOG 使用 CPU、2 次聚类迭代、SH1 的已验证有界路径，41.59 秒完成；SOG 对 raw PLY 的三锚点最低 PSNR 30.112、最低 SSIM 0.9779、最高 LPIPS 0.0343。
- Viewer 首次检查暴露并修复了 COLMAP `applied_transform` 被重复应用的问题。修复后三个 manifest anchors 与实际 training cameras 的 position/rotation/FOV 全部在 `1e-7` 内。
- 实机 Viewer 加载真实 SOG；0.1069 单位的 WASD 移动仍在边界内。`frame_00036` 照片回位的位置误差 `5.26e-9`、四元数误差 `7.76e-9`、FOV 误差 0，确认文案正确。

## 基线与安全

v1/v2 的 config、checkpoint、PLY、SOG、transforms SHA256 分别保持为 `caf172bf…34de`、`5b1dc3a4…ec95`、`25b9ccb9…51b1`、`901d501d…c223`、`b9175c72…319`。结果包只含指标、代码补丁、必要脱敏日志和一张 960×600 的生成场景 Viewer 截图；未上传 source frames、checkpoint、PLY、SOG、`.env`、token 或完整工作目录。
