# v10 素材证据与选择理由

## 选中的素材

- 项目：HKUST 360Roam，论文 [360Roam: Real-Time Indoor Roaming Using Geometry-Aware 360° Radiance Fields](https://arxiv.org/abs/2208.02705)。
- 作者项目页：<https://huajianup.github.io/research/360Roam/>。
- 作者数据分享：<https://hkust-vgd.nas.ust.hk:5001/sharing/LSeTZWca6>。
- 场景：`360Roam_dataset/base`，开放式室内创新/办公空间。
- 源格式：198 张沿移动路径采样的 equirectangular JPEG + `pose_c2w.json`；不是单点全景，也不是原始 MP4。
- 相机：抽检 JPEG EXIF 为 `insta360 one x2`；图片精确为 `6080×3040`、2:1。
- 位姿：`train=148`、`test=50`，每张都有 4×4 camera-to-world matrix。
- 完整图集：`2,231,668,064` bytes；v10 端点覆盖子集：60 张、`674,276,821` bytes。
- 冻结校验：每个选中文件的 remote path、bytes 和 SHA256 在 `inputs/source-manifest.json`；位姿文件 `66,048` bytes，SHA256 `8e46d6ffc867b8544e2066634a6ee3f7f2f0a1e04d5a7a486fc67c98a8d330a2`。

Mac 已直接从作者 share 下载全部 60 张并逐张核 hash；没有使用浏览器缓存或第三方镜像。首、中、尾抽检显示相机从接待/隔断区域移动到长桌和开放工位，地板、四周墙面/隔断、家具、顶梁和灯具都有覆盖。

## 为什么选它

1. **真的有位移**：目标是可走空间，不是围绕一个点旋转。作者位姿的平移随序列变化，画面也跨越多个室内区域。
2. **是真 360 输入**：每张都是完整 2:1 全景，包含上、下和背面；v10 不再把普通透视素材称作全景。
3. **下载适合慢网**：60 个约 10–12MB 文件独立下载，支持 HTTP Range 和 `.part` 续传；不用拉 2.23GB 完整场景，也不用一次性大 ZIP。
4. **先隔离最关键风险**：作者位姿让本轮集中验证 ERP→透视适配、360 覆盖和 3DGS 画质，不把“全景位姿估计失败”混进第一次 360 canary。
5. **不借用答案**：Mac 来源审计只读检查过作者 `scene.ply` 的头部，确认它是 659,753 点的 CloudCompare 点云；该文件未进入 manifest。4060 v10 任务不得下载、读取或用它做初始化/输出，训练固定 random init。

## 与“360 视频”的准确关系

用户最终想要的是 X6/同类相机拍摄的原始 360 MP4 直接上传。360Roam 的公开下载已经是移动采集后的全景帧和位姿，所以它能验证训练侧，却不验证原始 MP4 抽帧与位姿估计侧。

这不是文字游戏：v10 成功只代表「一段真实移动 360 采集，在已有位姿时可以变成可走场景」。下一阶段才把同一适配器前面换成 Max 的原始 MP4 → 抽帧 → 360 位姿/SfM。报告不得写成“X6 视频入口已打通”。

## 许可与再分发限制

项目页公开了 Dataset 按钮，但页面没有给数据集的明确许可证。保守边界是：只在 Max 自有 4060 上、本地非商业研究/个人实验使用，从作者 share 直接下载；不向 GitHub、iCloud、其他云盘、生产服务器或第三方再分发原图、位姿及派生训练数据。代码仓只存下载器、逐文件 hash 和报告。

## 被否决的候选

- **RICOH THETA X 官方 5.7K 样片**：直链只有约 140MB，格式是 5760×2880 H.264，但实测为户外公园且主要是单点手持，不满足室内移动空间。
- **OmniPhotos**：University of Bath 明确提供 Insta360 One X 拼接 MP4，CC BY 4.0；但公开包是约 3GB/18GB 的整包 ZIP，18GB endpoint 在当前网络 HEAD/Range 验证反复超时，不符合“4060 好直接获取”。
- **Holo360D**：有连续全景轨迹和位姿，但完整数据约 2.66TB，不适合第一次慢网 canary。
- **HIndoor-8K**：体量小，但单场景只有少量离散全景，难以支撑可走 room-scale 3DGS。

因此 v10 选择 360Roam `base`；许可证边界保守、格式诚实，下载与几何适配最适合现在这一步。
