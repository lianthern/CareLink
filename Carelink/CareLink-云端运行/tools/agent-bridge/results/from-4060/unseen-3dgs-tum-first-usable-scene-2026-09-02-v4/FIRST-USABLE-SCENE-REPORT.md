# v4 第一份可用场景报告

状态：`COMPLETED`

本轮用 TUM RGB-D `freiburg1/desk` 的已知位姿和配对深度，完成了第一份 fixture 级可用 3DGS 场景。桌面、书本和周边结构可辨认；Viewer 加载真实 SOG，可在边界内小范围移动，并能把相机精确恢复到选定照片的 pose、quaternion 和 FOV。

## 数据与 adapter

- 官方 TGZ：344,011,403 bytes，SHA256 `e983d6830916e66dc4a46a71368046b149b283de87769690e7aa4e0b9483530c`。
- 全轨迹约 5 Hz 取样 100 帧，其中 train 90、eval 10；所有选中帧均完成 RGB/depth/ground-truth timestamp 配对。
- RGB-depth 最大/中位时间差为 0.017603/0.011717 秒；RGB-pose 最大/中位时间差为 0.004656/0.000399 秒。
- 使用 TUM 对预配准 RGB-D 推荐的 640×480、`fx=fy=525`、`cx=319.5`、`cy=239.5`、depth factor 5000 标定。
- depth seed 共 157,520 个有色点，最大深度 5 m。
- 开头/中间/结尾 anchors 的最大 depth 投影回环误差为 `4.02e-13 px`；adapter 单元测试 `3 passed`。

## 唯一一次 7k

- 只运行 1 次 preview 7k，最终 step 6999；wall time 148 秒，峰值显存 3017 MiB，OOM 0，exit code 0。
- 三个 anchor 的 checkpoint 指标分别为：
  - `frame_00000`：PSNR 24.586、SSIM 0.8768、LPIPS 0.1646；
  - `frame_00050`：PSNR 22.740、SSIM 0.8544、LPIPS 0.1973；
  - `frame_00099`：PSNR 23.930、SSIM 0.8226、LPIPS 0.1585。
- 三张全部通过 PSNR ≥18、SSIM ≥0.70、LPIPS ≤0.40 的门槛。

## PLY、SOG 与视觉

- raw PLY：197,660 Gaussians，49,021,273 bytes；与 checkpoint 在三个 anchors 的像素输出完全一致。
- SOG：3,470,880 bytes；与 raw PLY 三锚点对比的 PSNR 为 31.682/27.464/26.941，SSIM 为 0.9823/0.9806/0.9742，LPIPS 为 0.0283/0.0530/0.0314。
- 人工检查可辨认 desk/room 主要结构；未发现强鱼眼、径向拖影或大面积 warped sheets。

## Viewer 与照片回位

- Viewer 实测 `SOG ready`，录得 203 FPS；WASD 移动 0.109 场景单位后仍在 manifest 边界内。
- start pose 和三个 anchors 全部由真实 sampled cameras 经 dataparser/PlayCanvas 坐标变换生成，不含手写相机坐标。
- 默认 photo anchor 为 `frame_00050`。回位后最大位置误差 `2.04e-8`，四元数误差 `4.10e-9`，FOV 误差 0；显示文案严格为“已回到这张照片的拍摄视角”。
- Viewer manifest 通过 JSON Schema，生成器测试 `2 passed`，应用脚本通过 Node 语法检查。

## 边界与安全

这只证明 known-pose TUM fixture 的场景与照片回位机制成立，不代表普通手机视频入口已经解决。结果包仅含脱敏指标、代码补丁、必要日志和一张 960×600 Viewer 截图；未上传 TGZ、RGB/depth、checkpoint、PLY、SOG、token、`.env` 或完整工作目录。
