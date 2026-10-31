# v9 轻量完整房间素材证据

## 冻结来源

- 场景：Tanks and Temples `Meetingroom`，不是另一段短片。
- 非 Google 下载：NerfBaselines 的公开 Hugging Face 数据镜像。
- 固定 revision：`6a638951a007c8b47eb8a0301d48b04d18e955cf`。
- URL：<https://huggingface.co/datasets/nerfbaselines/nerfbaselines-data/resolve/6a638951a007c8b47eb8a0301d48b04d18e955cf/tanksandtemples/meetingroom_2down.tar.gz>
- bytes：`169,378,633`。
- SHA256：`2e1f86fd7b25314fbc0361b42f16bf77ee222ac50294777995e8ab737aee8d33`。
- 上游下载实现：<https://github.com/nerfbaselines/nerfbaselines/blob/cde53bda36e65985ca15c79957725a9054fb55b4/nerfbaselines/datasets/tanksandtemples.py>。
- 原始数据集页：<https://www.tanksandtemples.org/download/>；许可页：<https://www.tanksandtemples.org/license/>。

Mac 已完成整包下载和 SHA256 校验。包内精确为 `371` 张 `980×543` JPEG，以及 `cameras.bin/images.bin/points3D.bin`。原 COLMAP 模型注册 `371/371`、单 `PINHOLE` camera、`124,162` sparse points；按文件名顺序的 camera-center PCA `lambda2/lambda1=0.456652`，明显不是 v7 的狭长推拉轨迹。

12 段人工 contact sheet 显示同一大型宴会/会议房间的桌椅、地面、四周墙面、门窗、立柱、灯具、屋梁与天花板。Mac 的这些值只证明输入包结构和上游位姿；4060 的 7k 时间、显存、画质、SOG 和 Viewer 仍全部 `PENDING_4060`。

## 为什么不是 4.27GB 视频

v8 4060 实测已经证明：官方 Google Drive 在当前网络下先四次连接超时，恢复代理后又返回 `2,009` bytes HTML，不是视频。v9 使用同一 Meetingroom 的已降采样 image set + COLMAP pose，下载量从 `4,271,432,079` bytes 降到 `169,378,633` bytes，约减少 `96.0%`，并绕开 Google。

它不重复证明“本机视频上传”；该链已由 v7 的真实 `12,273,501` bytes Pexels MP4 → loopback intake → WSL ext4 完整跑通。v9 只解决当前更关键的「完整大房间能否训练成可走场景」。等 Max 上传自己的视频时，再走已验证的本机 intake，不需要把公开大视频先搬一遍。

## 许可与数据边界

NerfBaselines 镜像没有独立 dataset card；仍按 Tanks and Temples 更严格边界处理：只在 Max 自有 4060 做本地非商业研究/个人实验。不得把压缩包、371 张图、COLMAP 模型、checkpoint、PLY 或 SOG 传入 GitHub、iCloud、生产服务器或任何公开存储。GitHub 只回传脱敏报告、小尺寸验收截图和安全 Viewer 录屏。
