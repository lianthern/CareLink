# v10 Mac 验证记录（2026-09-03）

这份记录只证明来源与适配器，不代表 RTX 4060 训练结果。

## 来源

- 公开 share 登录：PASS，无账号、密码或 token。
- 远端 `base/images`：198 个文件，总 `2,231,668,064` bytes。
- `pose_c2w.json`：`66,048` bytes，SHA256 `8e46d6ffc867b8544e2066634a6ee3f7f2f0a1e04d5a7a486fc67c98a8d330a2`。
- 位姿 split：148 train + 50 test；文件名与远端 198 张一一对应。
- 冻结子集：50 train + 10 validation，包含每个 split 的首尾位置；60 张共 `674,276,821` bytes。
- 60 张逐文件完整下载、bytes、SHA256：PASS。
- 首/中/尾分辨率：全部 `6080×3040`、2:1；EXIF 相机为 Insta360 ONE X2。

## 适配器

- Python compile：PASS。
- 4 个矩阵/选择单元测试：PASS。
- 作者 share `--list-only`：PASS。
- FFmpeg `v360`：Mac 实际处理全部 60 张，不是只跑 dry-run。
- 生成 600 张 `1024×1024` JPEG：PASS，总约 123MiB。
- 500 train + 100 validation：PASS，集合不相交。
- 每个全景精确生成 10 个视角：PASS。
- 同一全景的 10 个 c2w translation 完全相同：PASS。
- 所有虚拟相机 rotation determinant 接近 1：PASS。
- front/right/back/left/up/down 人工检查：方向连续；up 有顶梁/灯，down 有地板/相机底部遮挡。
- 作者 `scene.ply` 被单独识别为 CloudCompare 659,753 点点云，仅用于确认其性质；未进入 v10 manifest、adapter 或训练输入。

## 尚未验证

- PowerShell：`PENDING_WINDOWS`。
- WSL FFmpeg/Nerfstudio dataparser：`PENDING_4060`。
- 7k/30k 时间与显存：`null/PENDING_4060`。
- 7k/30k PSNR、SSIM、LPIPS：`null/PENDING_4060`。
- PLY/SOG/Gaussian 数、Viewer 视觉与 FPS：`null/PENDING_4060`。

Mac 临时下载不是交付或云备份；GitHub 不包含任何源图、位姿、训练图、PLY 或 SOG。
