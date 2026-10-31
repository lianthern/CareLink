# UNSEEN 轻量视觉几何回归

这套实现用于把“进度到 100% 且不是全黑”升级为可量化的几何测试。它不声称
是完整的 OpenCV Stitcher、SfM 或 bundle adjustment。

## 核心接口

- `measureFrameQuality(frame)`：检查缺图、黑白场、低纹理和严重模糊。
- `refineFramePose(reference, current, options)`：以 IMU `basis` 为初值，
  在有限 yaw/pitch/roll/FOV 窗口内做多尺度直接光度搜索；以 ZNCC 抵抗
  线性曝光变化，并返回 `confidence`、`accepted` 和 `rejectReason`。
- `refineFramePoseFromReferences(references, current, options)`：只尝试几何上
  可能重叠的多个参考帧，避免把拍摄序号误当作空间邻接关系。
- `optimizeFrameSequence(frames, edges, options)`：只传播高置信视觉边；
  以 IMU 为阻尼先验，把同纬圈首尾闭合残差按路径置信度分摊。它是轻量
  闭环修正，不是全局 BA。
- `stitchFrames2D(frames, width, height, options)`：默认生成可见 2D 等距柱状
  结果，并在逐帧投影后释放 RGBA/ImageBitmap；旧的
  `createRaster/projectPatch` 调用保持兼容。

## 回归方法

`pano_synthetic.js` 先生成一张周期连续的 2:1 真值全景，再用和生产内核
相同的 `+Y 前、+Z 上` 相机基渲染 28 张 3:4 透视照片。回归会注入：

- 平均 2.615°、最大 3.743° 的姿态误差；
- 平均 1.752° 的水平 FOV 误差；
- 线性曝光变化、噪声和轻微模糊；
- 高纹理随机坏帧、纯色低纹理坏帧；
- 同纬圈累计 3° 的序列漂移和一条恶意 15° 低置信边。

运行：

```sh
node tools/test_visual_stitch_geometry.js
```

2026-07-31 的固定种子结果：

| 指标 | 仅 IMU 羽化 | 轻量视觉纠偏 |
| --- | ---: | ---: |
| 平均姿态误差 | 2.615° | 1.309° |
| 平均 FOV 误差 | 1.752° | 0.842° |
| 局部 SSIM | 0.613 | 0.775 |
| RGB MAE | 17.857 | 8.605 |
| 视觉边平均 ZNCC | — | 0.996 |

27/28 张扰动帧通过；第 10 张因相对参考帧所需修正达到 6°安全边界而返回
`CORRECTION_LIMIT`。这是明确重拍信号，不会把不确定姿态写入全景。

闭环压力测试把累计漂移从 3°降到 0.3°，环带 SSIM 从 0.794 提到 0.967；
15°低置信恶意边被忽略；连续路径中若出现低置信边，闭环修正不会跨过该段
继续传播。相同回归连续运行 10 次输出哈希完全一致。

额外以 240×320 的配准帧做单对压力测试：4.061° 初始姿态误差降到
0.852°，FOV 由 65°校正到 67.667°（真值 67.4°），ZNCC 0.990；Node
桌面基准耗时约 20.6ms、两张 RGBA 合计约 0.586MiB。该耗时不能直接等同
真机性能，但说明搜索成本主要由固定采样数而非原图总像素数决定。

## 明确局限

- 只适合小旋转误差和已有足够重叠的静态场景。
- 直接光度模型只补偿全局线性曝光；强 HDR、自动白平衡跳变仍可能失败。
- 没有镜头畸变标定、rolling shutter 校正、特征/RANSAC、局部 mesh warp、
  GraphCut seam、multiband blend 或真正的全局 bundle adjustment。
- 近景视差、动态人物、大面积白墙、严重运动模糊必须拒绝并提示重拍。
- 生产接入仍需拍摄页把帧像素、帧时间戳、内参和高置信邻接边传入这些接口；
  本文件所在改动没有修改 Web 或微信拍摄页面。
