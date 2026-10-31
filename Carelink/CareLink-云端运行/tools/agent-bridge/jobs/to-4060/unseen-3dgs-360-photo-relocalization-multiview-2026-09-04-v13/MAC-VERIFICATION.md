# v13 Mac 发布前验证

本页只记录发布端可以真实证明的静态与合成测试；不伪造 Windows、RTX 4060 或 v11 本机数据结果。

## 发布端验证范围

- Python compile、JSON parse、Bash syntax、ShellCheck（若本机存在）与 Bridge 边界检查。
- RootSIFT 数值归一化单测。
- distinct-landmark ratio test：同一 landmark 的重复观察不能充当 runner-up，真正歧义的不同 landmark 会被拒绝。
- v12 冻结脚本 SHA256 锁、同三张 query 与五项原通过门槛单测。
- synthetic 120-point PnP（含 10 个离群点）恢复位姿测试。
- 入口显式设置 `CUDA_VISIBLE_DEVICES=""`，不含安装、素材下载、训练、生产连接或端口开放行为。

## 必须由 4060 实测

- Windows PowerShell/WSL interop：`PENDING_WINDOWS`。
- v11/v12 本机 cache 与冻结结果复核：`PENDING_4060`。
- 400 张训练图的多视角 descriptor bank：`PENDING_4060`。
- 同三张 held-out query 的 matches、PnP 与五项指标：全部 `null/PENDING_4060`。
- 只有 3/3 后的 estimated pose → v11 Viewer、三按钮、并排图和 E2E：`PENDING_4060`。

因此发布状态只能是 `PUBLISHED / PENDING_4060`。合成测试通过不等于真实照片定位或 Viewer 通过。
