# v11 素材证据、坐标约定与复用理由

## 选中的素材

- 项目：HKUST 360Roam，论文 [360Roam: Real-Time Indoor Roaming Using Geometry-Aware 360° Radiance Fields](https://arxiv.org/abs/2208.02705)。
- 作者项目页：<https://huajianup.github.io/research/360Roam/>。
- 作者数据分享：<https://hkust-vgd.nas.ust.hk:5001/sharing/LSeTZWca6>。
- 场景：`360Roam_dataset/base`，开放式室内创新/办公空间。
- 源格式：198 张沿移动路径采样的 equirectangular JPEG + `pose_c2w.json`；不是单点全景，也不是原始 MP4。
- 相机：抽检 JPEG EXIF 为 `insta360 one x2`；图片精确为 `6080×3040`、2:1。
- 位姿：`train=148`、`test=50`，每张都有 4×4 camera-to-world matrix。
- 完整图集：`2,231,668,064` bytes；v10/v11 复用的端点覆盖子集：60 张、`674,276,821` bytes。
- 冻结校验：每个选中文件的 remote path、bytes 和 SHA256 在 `inputs/source-manifest.json`；位姿文件 `66,048` bytes，SHA256 `8e46d6ffc867b8544e2066634a6ee3f7f2f0a1e04d5a7a486fc67c98a8d330a2`。

Mac 已在 v10 发布前直接从作者 share 下载全部 60 张并逐张核 hash；4060 也已完成相同校验。v11 必须复用这个 WSL ext4 cache，不默认重新下载。首、中、尾抽检显示相机从接待/隔断区域移动到长桌和开放工位，地板、四周墙面/隔断、家具、顶梁和灯具都有覆盖。

## v10 失败后确认的坐标约定

- 360Roam `pose_c2w.json` 是 OpenCV/COLMAP camera-to-world：相机局部轴为 +X 向右、+Y 向下、+Z 向前。
- Insta360 Research Team 的 GGPS 转换代码将这些矩阵按 OpenCV/COLMAP 约定使用；转 Blender/OpenGL 时另做 Y/Z 轴翻转。OmniGS 的 360Roam 转换同样直接把它用于 OpenCV/OpenMVG 球面相机。
- v10 错误地把源矩阵当成 OpenGL c2w，又对 FFmpeg yaw 使用了反号。Mac 复验的方向误差为前/后/上/下 180°、四个对角 90°，真实相邻图像的极线残差从正确约定约 0.3–0.6px 恶化到约 16–31px。
- v11 唯一允许的转换是 `c2w_gl_face = c2w_cv_source @ Ry(+yaw) @ Rx(+pitch) @ diag(1,-1,-1,1)`，并由合成 pixel-ray 与真实图像极线两道门验证。

## 为什么选它

1. **真的有位移**：目标是可走空间，不是围绕一个点旋转。作者位姿的平移随序列变化，画面也跨越多个室内区域。
2. **是真 360 输入**：每张都是完整 2:1 全景，包含上、下和背面；v11 不把普通透视素材称作全景。训练时排除动态相机车底的 down face，不等于源全景缺失地面。
3. **不再消耗慢网**：v11 复核并复用 v10 已下载的 60 个文件和已生成的透视 JPEG，不用拉 2.23GB 完整场景，也不再拉 674MB 子集。
4. **先隔离最关键风险**：作者位姿让本轮集中验证 ERP→透视适配、360 覆盖和 3DGS 画质，不把“全景位姿估计失败”混进第一次 360 canary。
5. **不借用答案**：作者 `scene.ply` 未进入 manifest，v11 不得下载或读取。v11 的 sparse seed 只能由冻结透视图和已知相机位姿自行 SIFT 匹配/三角化，并在报告中记录点数和极线误差。

## 与“360 视频”的准确关系

用户最终想要的是 X6/同类相机拍摄的原始 360 MP4 直接上传。360Roam 的公开下载已经是移动采集后的全景帧和位姿，所以它能验证训练侧，却不验证原始 MP4 抽帧与位姿估计侧。

这不是文字游戏：v11 即使成功，也只代表「一段真实移动 360 采集，在已有位姿时可以变成可走场景」。下一阶段才把同一适配器前面换成 Max 的原始 MP4 → 抽帧 → 360 位姿/SfM。报告不得写成“X6 视频入口已打通”。

## 许可与再分发限制

项目页公开了 Dataset 按钮，但页面没有给数据集的明确许可证。保守边界是：只在 Max 自有 4060 上、本地非商业研究/个人实验使用，从作者 share 直接下载；不向 GitHub、iCloud、其他云盘、生产服务器或第三方再分发原图、位姿及派生训练数据。代码仓只存下载器、逐文件 hash 和报告。

## 被否决的候选

- **RICOH THETA X 官方 5.7K 样片**：直链只有约 140MB，格式是 5760×2880 H.264，但实测为户外公园且主要是单点手持，不满足室内移动空间。
- **OmniPhotos**：University of Bath 明确提供 Insta360 One X 拼接 MP4，CC BY 4.0；但公开包是约 3GB/18GB 的整包 ZIP，18GB endpoint 在当前网络 HEAD/Range 验证反复超时，不符合“4060 好直接获取”。
- **Holo360D**：有连续全景轨迹和位姿，但完整数据约 2.66TB，不适合第一次慢网 canary。
- **HIndoor-8K**：体量小，但单场景只有少量离散全景，难以支撑可走 room-scale 3DGS。

因此 v11 不换素材，只纠正已经定位的相机约定并复用本地 cache；许可证边界和再分发限制保持不变。
