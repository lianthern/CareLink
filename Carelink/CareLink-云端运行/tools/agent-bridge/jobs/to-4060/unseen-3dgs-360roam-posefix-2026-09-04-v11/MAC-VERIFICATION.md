# v11 Mac 发布前验证（2026-09-04）

本文件只证明冻结代码合同；不伪造 4060、CUDA 或 v11 画质结果。

## 已完成

- v10 结果复验：源 contact sheet 清楚；Viewer 只有 back 局部可辨，其余被灰雾/漂浮纹理主导；最终 `TECHNICAL_PASS_USER_GATE_FAIL` 合理。
- 已从 360Roam 官方转换代码交叉确认 `pose_c2w.json` 是 OpenCV/COLMAP c2w，而不是 Blender/OpenGL c2w。
- 旧变换的代表方向误差：front/back/up/down 180°，四个对角 90°；左右仅偶然抵消。
- 对实际相邻 panorama-derived views 做过独立 SIFT 极线复核：正确 OpenCV 约定约 0.3–0.6px；v10 约 16–31px。
- v11 数学公式改为 `c2w_cv @ Ry(+yaw) @ Rx(+pitch) @ diag(1,-1,-1,1)`。
- Python compile、JSON parse、Bash syntax 与单元测试通过；单元测试包含 FFmpeg 真实 `v360` synthetic direction-map pixel-ray 检查，不再只测 determinant/共享中心。
- 从作者 share 另取 6 个连续冻结 panorama 做真实冒烟：5/5 相邻全景 pair 都通过新极线判别，中位 inlier 残差 `0.404px`；每个 pair 的正确约定 inliers 均至少为 v10 错误约定的 `4.92×`，证明门能区分这次真实 bug。该小样本只生成 409 个去重点，按设计因未达到完整任务的 12 pair/3,000 点门而整体 fail-closed，没有启动 GPU。
- v10 Agent 发现的 PowerShell `wslpath` 转义、venv 激活顺序和 `/usr/lib/wsl/lib` PATH 问题已合入 v11 frozen launcher。
- v11 只复用 v10 本地 cache；默认不重新下载源素材，并移除动态 `down` face。

## 必须由 4060 实测

- Windows PowerShell parser/WSL interop：`PENDING_WINDOWS`。
- 复用 v10 cache、生成 540 views：`PENDING_4060`。
- 真实图像极线 gate 与自行三角化 seed 点数：`PENDING_4060`。
- 7k 时间、VRAM、PSNR、SSIM、LPIPS、PLY/SOG、Viewer FPS 与人眼画质：全部 `null/PENDING_4060`。

因此发布状态只可写 `PUBLISHED / PENDING_4060`，不能提前写成功。
