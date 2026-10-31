# v10 4060 实测报告

最终状态：`TECHNICAL_PASS_USER_GATE_FAIL`

v10 已把作者发布的真实移动 360 全景 JPEG 序列与逐帧位姿完整接入，完成冻结 60 张全景的校验、600 个透视视图适配、一次从零开始的 7k Splatfacto 训练、100 张留出视角评估、PLY→SOG→PLY 往返、Viewer 技术测试和 10.3 秒录屏。数据准备、训练、导出和 Viewer 控制链路均通过；但 7k 模型的用户视觉门失败，因此按合同停止，未执行 30k continuation。

## 输入和 GPU 前门

- 来源：HKUST 360Roam 作者公开 Synology share 中的 `base` 场景，仅作 Max 自有机器上的本地非商业研究实验。
- 输入形态是移动 360 JPEG 序列 + 作者位姿，不是原始 MP4，也不表示未来 X6 原始 MP4 入口已经打通。
- 60/60 张冻结全景逐文件 bytes/SHA256 匹配，总计 `674,276,821` bytes，全部为 `6080×3040` 2:1 JPEG。
- `pose_c2w.json` 为 `66,048` bytes，SHA256 `8e46d6ffc867b8544e2066634a6ee3f7f2f0a1e04d5a7a486fc67c98a8d330a2`；148 train + 50 test 位姿均为有限 4×4 proper rotation。
- 未下载、读取或使用作者 `scene.ply`。
- 适配器为每张全景生成 8 个重叠水平视角以及 up/down，共 600 张 `1024×1024`、100° FOV pinhole JPEG；冻结为 500 train + 100 val。
- 同一源全景的十个虚拟视角共享完全相同的相机中心。60 个源相机中心非零移动，主平面跨度为 `11.842887 × 6.729021`，凸包面积 `63.377473`。
- 12/12 路径段可见室内结构和地面，12/12 可见上墙、灯、梁或天花板；代表点 up/down 朝向正确。
- Nerfstudio dataparser 实读 500 train + 100 val，全部为 `1024×1024` PERSPECTIVE，相机位置范围非零且没有 3D seed points。
- 冻结准备脚本单元测试 4/4 通过。

## 一次 7k preview

- 只执行了一次真实优化：从零开始，step `0–6999`，共 7000 步，exit code 0，无 OOM。
- 用时 `371 s`，峰值显存 `5,685 MiB`；GPU 为 NVIDIA GeForce RTX 4060 Laptop GPU。
- Nerfstudio `1.1.5`、PyTorch `2.1.2+cu121`、CUDA `12.1`。
- 配置为 Splatfacto、scale regularization 开启、camera optimizer off、`random-init=True`、`load-3D-points=False`。
- checkpoint 为 `438,893,458` bytes，SHA256 `c346fa094059922eb7e172fd1f27cc814e683587877cde5ac103323b852c2e25`；config SHA256 `b51d3c081df9e595eb7470b688b1f54c645fff2bab792bd7835f2be1add75a95`。两者仅留在 WSL ext4，未上传。
- Windows frozen launcher 的 `wslpath` 参数转义有误，Linux frozen preview 在激活 `.venv` 前检查 `ns-train`。这些入口失败都发生在 attempt marker 和 GPU 优化之前，未启动 `ns-train`，不构成额外训练尝试；修复见 `fixes/unseen-v10-entrypoint-fixes.patch`。

## 留出评估和导出

- 100/100 冻结留出视角完成 PSNR、SSIM、LPIPS 测量。
- 均值：PSNR `13.397960`、SSIM `0.547614`、LPIPS `0.818447`。
- 最差值：PSNR `10.426205`、SSIM `0.440890`、LPIPS `0.935125`。
- 原始 PLY：`605,914` Gaussians，`150,268,265` bytes，SHA256 `251b08bf972712e11d537202cd07c73d95eb54498bfc60e5b2043c8966f13dc1`。
- 最终 SOG：SH1、`605,914` Gaussians，`9,573,675` bytes，SHA256 `f580c4684dd02bb6de9c0443a8df6b6f524b604a312cea23a61ff3709ebac8d6`。
- 往返 PLY：`605,914` Gaussians，`55,744,666` bytes，SHA256 `bae42d522a69b6f7ceef605aa6651717946eb0f6205a7fd4c969826fc6ffd526`；Gaussian 数保持一致。
- 压缩如实降级为 GPU SH1、1 次 k-means，耗时 `38.215 s`。此前 SH2/GPU 10 次因已验证的超过 600 秒慢路径提前终止，SH1/CPU 10 次在 600 秒超时，SH1/GPU 10 次确认迭代数是瓶颈后终止。降级影响仅在压缩表示，不改变用户视觉门失败的结论。

## Viewer 门

Viewer 仅绑定 `127.0.0.1:8766`。技术 E2E 为 PASS：SOG ready、平视起步、roll 0、固定眼高、zoom、前进/横移、正常速度、约 3× sprint、边界约束、两轴路径返回、六方向 drag look、FOV/速度/mode UI 和零 console/page error 均通过。实测 normal distance `0.142333`，sprint distance `0.433939`，比例 `3.048762`；路径返回误差 `0.003311`。录屏为 H.264 `1280×720`、`10.3 s`、`402,824` bytes，真实展示 zoom → walk → sprint → look up/down → walk。

用户视觉门为 FAIL：7k 画面被大块模糊/雾状区域和不稳定浮动纹理主导；只有 back 方向部分可辨认，front/left/right 不能稳定辨认室内结构；up/down 不能可靠识别顶梁/灯和地面；移动虽改变视角，但遮挡与几何关系不稳定。因此不能把它接受为可走室内重建。合同明确规定 7k 用户门失败时禁止用 30k 掩盖输入/位姿或重建问题，所以 30k 未运行。

照片回位不在 v10 范围，未作为门槛测试。

## 存储和安全

源全景、作者位姿、600 张训练视图、checkpoint、PLY、SOG 和 work 均只留在 `/home/max/src/unseen-3dgs-sceneworker` 的 WSL ext4；浏览器帧与临时证据位于 `D:\UNSEEN\v10-evidence-20260903T2118`，避免继续占用接近满载的 C 盘。回传目录只含报告、修复 patch、脱敏日志、小图和小于 15 MiB 的安全 Viewer 录屏。

未调用生产或付费 API，未安装包，未改 firewall，未监听 LAN/公网，未使用未知镜像或私密媒体。结果中没有源全景、位姿、训练图、checkpoint、PLY、SOG、work、token 或 `.env`。
