# UNSEEN 球形全景调研、技术拍板与 v25 验收记录

日期：2026-08-01

> 本文件是本轮可物化、可校验的更新记录。原三份 Obsidian 交接文档当前为 iCloud FileProvider 占位文件（逻辑大小非零，但磁盘块为 0），为避免覆盖未下载正文，本轮不直接写入它们。待 iCloud 正文恢复后，应把本文结论合并回原交接文档。

## 一、目标没有改成横向全景

UNSEEN 的最终目标仍是 2:1 等距柱状投影的球形全景，而不是单排横向 panorama。横向扫拍只作为研究手机全景相机交互、连续取帧和拼接质量的参考，不应替代 720°/球形结果。

三端应保持同一产品逻辑：

1. 选择场景并阅读拍摄约束。
2. 中央保留实时取景窗；一次只显示下一个目标。
3. 第一张由用户确认，后续满足姿态、稳定度和清晰度门槛后自动拍摄。
4. 每张成功照片按当时姿态冻结成真实照片 patch，未覆盖区域保持黑色。
5. 拼接先生成常驻、可见、非黑的 2D 等距柱状结果。
6. 360° WebGL 只由用户主动打开；初始化失败、渲染失败或 context lost 时自动回到 2D。

## 二、公开方案调研结论

### 1. Bilibili 示例不是“视频一扫就无缝”

用户提供的视频《手机也能拍出好看 VR 球形全景图，拍摄 + 后期合成》采用约 32 张高分辨率静态照片，再交由 PTGui 后期配准、接缝和融合。其可复现价值主要是：固定机位、充分重叠、分层覆盖和离线全局优化，而不是某种连续视频魔法。

来源：https://www.bilibili.com/video/BV1iXUKYrEMG/

### 2. Pixel 9 从视频输入改为 HDR+ 照片栈

Google 对新版 Pixel panorama 的说明明确指出：旧模式以视频扫描场景，新模式改用照片/HDR+ 管线，利用多张照片的更多数据完成合成；拍摄建议也是站在原地转手机，而不是人绕场景移动。这与 UNSEEN 的球形目标相符：可以用实时视频做引导和候选帧选择，但高质量输入应是受控的离散照片或多帧照片栈。

来源：https://blog.google/products-and-platforms/devices/pixel/tips-how-to-use-pixel-new-panorama-mode/

### 3. Google Street View 的关键是全局正则化形变

Street View 的公开方法先估计稠密、平滑的对应关系，再把所有重叠区域一起交给全局非线性优化；它明确区别于彼此独立的局部 patch 形变。这个设计用于抑制局部拉扯和“果冻晃动”。

来源：https://research.google/blog/seamless-google-street-view-panoramas/

### 4. 大视差与运动需要“多配准候选 + 接缝选择”

Google Research 的 multiple registrations 工作指出，单个配准模型在深度变化或运动物体明显时容易失败；更稳妥的做法是为不同深度/运动区域保留多个配准候选，并在接缝优化中共同选择，显式惩罚重复与撕裂。

来源：https://research.google/pubs/robust-image-stitching-using-multiple-registrations/

### 5. OpenCV 的成熟基线是分层管线，不是单一羽化

OpenCV detailed stitcher 的典型顺序是特征匹配、相机估计和全局 bundle adjustment、wave correction、曝光补偿、GraphCut seam、MultiBand blending。GraphCut 决定重叠区由哪张照片负责，多频段融合只负责隐藏小尺度亮度和配准误差；它不能修复由相机平移造成的真实视差。

来源：https://docs.opencv.org/5.0/tutorials/others/stitcher.html

## 三、本轮技术拍板

### 正式路径

- Capture 与 Stitch 统一使用相机 `F/U/R` 正交基与球面投影，不再靠 Euler 正负号试凑。
- 以陀螺仪姿态为先验，用相邻、跨行和闭环视觉边形成全局 SO(3) pose graph；拒绝不一致边，而不是让坏边拉弯整张全景。
- 保持受控重叠，做曝光校正、唯一接缝归属和低频融合。
- 结果页默认保留 2D；WebGL 只是增强层。
- 成功拼接并物化 2D 结果后释放 ImageBitmap 与大 CPU 数组，避免和 Three/WebGL 同时常驻。

### 暂不进入正式路径

- 相邻两帧的 8×6 局部 residual mesh 只保留在隐藏合成测试中。它通过了 holdout、前后向一致性、Jacobian、边界连续等回归，但平滑移动前景仍能在二帧观测下伪装成相机局部形变；这一歧义无法靠继续调阈值根治。
- 若要上线局部形变，下一版应增加至少三帧静态背景一致性、前景/背景分层或 multiple-registration seam 选择，不应继续扩大普通 feather。
- 不逆向 Google Camera APK。公开论文和官方说明已经给出正确的系统结构；私有实现细节也不能替代真实设备标定与数据集。

## 四、v25 当前状态

### 独立 Web

- 正式地址：https://unseen-d3gtp0sxh53bbef61-1316841054.tcloudbaseapp.com/pano-capture/
- 已部署 `pano-core.js`、`pano-capture.js`、`pano-capture.html`，远端反向下载与本地发布快照逐字节一致。
- 普通、静态和动态正式入口均关闭实验 local warp。
- 隐藏测试覆盖：28 帧、进度到 100%、2D 非黑、覆盖率 100%、WebGL 正常、强制 WebGL 失败回退、`webglcontextlost` 回退、测试模式不上传。

### 独立微信小程序

- AppID：`wx551ef9eb67257f96`
- 可交付构建源：`/Users/max/Documents/ADVX/work/unseen-panorama-rebuild/releases/v25-20260801/miniapp`
- 原工作区若干 iCloud 文件为 dataless 占位，因此预览包使用从微信编译缓存和补丁事件精确恢复并完全物化的安全快照。
- 19 个 JavaScript 文件语法通过，21 个相对依赖全部可解析，5/5 小程序集成测试通过。
- 正式 caller 固定 `localWarp: false`。
- 官方微信开发者工具完成 10/10 隐藏回归：每轮 28/28、progress 100%、coverage 100%、2D 非黑、WebGL 首像素非黑；随后每轮强制 context lost，均卸载 WebGL 并保留 2D；测试模式 `wx.uploadFile` 调用为 0，runtime exception 与 console error 均为 0。
- 证据：`/Users/max/Documents/ADVX/work/unseen-panorama-rebuild/artifacts/mini-devtools-v25-10x-20260801.json`，SHA-256 `718333536eadcf76f037707f2262c1c676ac54d2cf4e5496a58c2b5e1091f893`。
- 预览二维码：`/Users/max/Documents/ADVX/work/unseen-panorama-rebuild/UNSEEN-miniapp-preview-v25-20260801.png`。这是开发/体验版二维码，不能替代微信审核发布，也不能替代真机相机、陀螺仪和内存测试。

### 可复现发布快照

- Web：`/Users/max/Documents/ADVX/work/unseen-panorama-rebuild/releases/v25-20260801/web-release`
- 小程序：`/Users/max/Documents/ADVX/work/unseen-panorama-rebuild/releases/v25-20260801/miniapp`
- 快照共 52 个文件，全部已物化，零个 0-block 占位文件；与实际部署/预览时使用的临时快照逐文件一致。

### 秒哒

- 线上仍为 v15 / `app_version-ddssyfiqeh34`。
- 本轮没有提交成功的新代码、没有待发布版本，也没有 publish；成对 chat 在执行前因秒点不足返回失败。
- v15 已有默认 2D + 可选 WebGL 的方向，但只读审计仍发现两个黑屏残余：零覆盖像素 `(20,20,20,255)` 会绕过当前黑图检测；可见 2D canvas 尚未确认绘制成功就可能关闭全部 ImageBitmap。额度恢复后应先做一个小型 v16 热修。

## 五、下一轮最高收益工作

1. 建立真实手机数据集：静态远景、近景强视差、单个移动人物、低照度各 10 条完整 28 帧序列，并保存相机内参、时间戳、姿态与质量门槛结果。
2. 用 PTGui/Hugin 产出同源离线上限，区分“采集几何问题”和“移动端算法问题”。
3. 实现三帧以上的静态背景轨迹判定和多配准候选，再由接缝能量选择，不让移动前景控制整张 warp。
4. 在真机上记录首帧、第二帧、每行切换、后台/前台、拼接峰值内存和 WebGL context lost；模拟器只负责状态机、内存趋势和 fallback，不能替代真实相机/EIS/陀螺仪。
