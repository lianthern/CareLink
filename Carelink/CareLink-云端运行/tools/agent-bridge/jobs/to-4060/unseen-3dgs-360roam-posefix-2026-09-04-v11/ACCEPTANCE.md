# v11 验收合同

## A. 旧结果隔离

- [ ] 明确记录 v10 为 `REJECTED / POSE_CONVENTION_BUG`；不续跑 v10 checkpoint，不跑 v10 30k。
- [ ] v11 使用新 jobId、dataset、artifact、checkpoint 和报告目录，不覆盖 v9/v10。
- [ ] 复核并复用 v10 的 60 张源全景与 pose cache；没有重新下载约 674MB。
- [ ] 作者 `scene.ply` 未下载、未读取、未复制、未用于训练。

## B. 0-GPU 坐标与图像门

- [ ] 源位姿按 OpenCV `c2w` 解释；输出明确转换为 Nerfstudio/OpenGL `c2w`。
- [ ] FFmpeg 合成方向图的九个中心 pixel rays 与输出 pose 的 OpenGL `-Z` 射线误差均 <2°。
- [ ] 真实图像极线门：四个主方向交叉寻找重叠；至少 12 个相邻全景 pair 可评估且至少一半通过。通过 pair 的正确位姿 inlier ≥12、比例 ≥10%、中位误差 ≤2.5px，且 inlier 数至少是 v10 错误约定的 2 倍。
- [ ] 动态 nadir/down 视图不进入数据集；精确为 60×9=540 views、450 train + 90 val。
- [ ] 同源九个虚拟相机中心相同；rotation proper；train/val 不相交。
- [ ] 由本任务图像和已知位姿自行三角化 ≥3,000 个稀疏种子点，`usesAuthorScenePly=false`。
- [ ] 任一项失败时 GPU 0 次并提交 `BLOCKED`，不得绕门。

## C. 一次 7k

- [ ] 只有 A/B 全过后才提交 `RUNNING`。
- [ ] 恰好一次新 v11 lineage，从头 step 0–6999；`random-init=False`、`load-3D-points=True`。
- [ ] v10 checkpoint/PLY/SOG/指标没有复用；无隐藏重跑。
- [ ] 记录真实命令、版本、wall time、peak VRAM、exit、OOM、checkpoint bytes/SHA。
- [ ] 90/90 frozen val 完成 PSNR/SSIM/LPIPS；未测字段保持 null。
- [ ] 导出 PLY→SOG→PLY，Gaussian 数一致，大文件仅留 WSL ext4。

## D. 用户空间门

- [ ] front/back/left/right/up/down 截图均能辨认空间；不是灰雾、大块浮点或单张图推拉。
- [ ] 两轴移动时有稳定的几何遮挡变化；zoom、walk、3× sprint、drag look 都有效。
- [ ] 起步平视、roll≤0.5°、眼高稳定；Viewer 只监听 `127.0.0.1`。
- [ ] 录屏 10–20 秒且 ≤15MiB，真实展示 zoom→walk→sprint→look up/down。
- [ ] PSNR≤16、SSIM≤0.65 或 LPIPS≥0.65 时不得接受；即使超过推荐线仍需 Max 人眼通过。
- [ ] 本任务禁止 30k；必须先回传 7k 给 Max 验收。

## E. 安全回传

- [ ] 只回传合同允许的报告、脱敏日志、小图和录屏。
- [ ] 不回传源图、位姿、540 views、seed、checkpoint、PLY、SOG、work、token、`.env`。
- [ ] 不连接生产/付费 API，不改 firewall，不监听 LAN/公网。

最终状态只能是 `PANORAMIC_POSEFIX_ACCEPTED_7K`、`TECHNICAL_PASS_USER_GATE_FAIL`、`BLOCKED` 或 `FAILED`。
