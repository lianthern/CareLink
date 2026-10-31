# v12 Mac 发布前验证

本页只记录发布端能证明的代码合同，不伪造 Windows/4060 或真实 v11 cache 定位结果。

## 已完成

- Python compile、JSON parse、Bash syntax和 Bridge 边界检查：发布前执行。
- 冻结 query selection 单测：从 10 个 held-out panorama 固定选择第 2/front、中间/right、倒数第 2/left。
- train/val 泄漏拒绝单测。
- synthetic 120-point PnP：含 10 个离群点，验证 RANSAC/LM 可恢复相机旋转和平移。
- 入口显式设置 `CUDA_VISIBLE_DEVICES=""`，不调用 Nerfstudio，不安装依赖，不下载或上传任何素材。

## 必须由 4060 实测

- Windows PowerShell/WSL interop：`PENDING_WINDOWS`。
- v11 本机 cache 与结果锁复核：`PENDING_4060`。
- training-only reference map 点数与 3 张真实 held-out query 的 PnP：`PENDING_4060`。
- 三张 position/rotation/reprojection/inlier 指标：全部 `null/PENDING_4060`。
- estimated pose → v11 Viewer transform、三按钮、并排图与浏览器 E2E：`PENDING_4060`。

因此当前只能写 `PUBLISHED / PENDING_4060`；synthetic PnP 通过不等于真实照片定位通过。
