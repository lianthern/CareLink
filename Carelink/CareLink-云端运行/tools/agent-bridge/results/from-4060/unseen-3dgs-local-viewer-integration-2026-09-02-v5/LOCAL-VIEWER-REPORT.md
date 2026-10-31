# UNSEEN local Viewer integration v5

状态：**COMPLETED**。v3/v4 代码已经整合成一份可复现补丁，Pexels v3 Viewer 已在 4060 本机以 loopback-only 方式启动并在 Windows 默认浏览器中打开。实际地址是 `http://127.0.0.1:8765/?scene=./repair-v3.scene.json`；Viewer 仍在运行。

## 本轮边界

- 新训练：`0` 次；quality 30k：`0` 次。
- 新 PLY 导出：`0`；新 SOG 转换：`0`。
- 未访问生产 API、数据库、租约、token、vault 或任何公网入口。
- 只启动了 Pexels repair-v3；TUM v4 仅整合代码与执行静态/单元检查。
- v1-v4 的 config、checkpoint、PLY、SOG、transforms 已在集成后重新计算 hash，变更数为 `0`。明细见 `logs/artifact-freeze.json`。

## 整合结果

补丁为 `fixes/unseen-3dgs-local-viewer-integration-v5.patch`，大小 `116031` bytes，SHA256 `30dca681aad09cfdadb85ad075e14f68173076953e25d241005822249e269781`。它包含 21 个文件，对原始干净 PoC Viewer 副本执行 `git apply --check` 为 PASS；`viewer/app.js` 与 `viewer/scene.schema.json` 各只出现一次，repair-v3 与 tum-v4 仍为独立 profile。

补丁补齐了 v4 训练/评估/产物验证脚本和两份 Viewer E2E 脚本，并修复了以下验收缺口：

- v3 SfM candidate 使用位置参数；TUM adapter 不再出现不存在的 `--target-hz/--max-frames`；两个 Viewer generator 使用真实的 `--manifest-output/--validation-output`。
- checkpoint/artifact/anchor gate validator 在 gate 失败时返回非零，尤其移除了 v3 artifact validator 的无条件成功退出。
- photo-anchor 恢复完整 position（包括照片相机 Y）、quaternion 和 FOV；第一次自由移动才切换到 `navigation.eyeHeight`；界面 eye height 与实际 walk Y 同步。
- 新增无管理员权限的 `Start-Local-PexelsViewer.ps1` / `Stop-Local-PexelsViewer.ps1`。启动器只绑定 `127.0.0.1`，优先 `8765`，不会修改防火墙、端口转发、Task Scheduler、systemd 或开机启动。
- `RUNBOOK.md` 中没有伪占位参数，项目命令逐条与 `--help` 或等价 dry-run 核对。

## 实机 Viewer 门禁

冻结的真实 Pexels v3 SOG 同时在源路径和 Viewer-local 路径验证为 `2693010` bytes、SHA256 `0d417735d1b91573f2e2199b53567c07014a420943dac8c84cb73811a1ec0e01`。

服务进程为 WSL PID `420`（Windows `wsl.exe` PID `19544`），命令行是 `python3 -m http.server 8765 --bind 127.0.0.1`。监听检查只看到 `127.0.0.1:8765`；WSL HTTP 和 Windows PowerShell HTTP 均为 `200`。默认浏览器启动调用已执行。

真实 SOG 浏览器 E2E 为 PASS：

- 场景状态：`SOG ready`。
- XZ 移动距离：`0.10627589956010673`，且仍在 boundary 内。
- 首次移动后的实际 walk Y：`-0.010611543`，与 manifest `navigation.eyeHeight` 一致；UI 显示与实际 walk plane 一致。
- 返回照片锚点 `frame_00036` 后，position 最大绝对误差 `5.257560720117738e-9`，quaternion 最大绝对误差 `7.756686210003139e-9`，FOV 误差 `0`；照片 Y 被完整恢复，确认文案精确出现。
- E2E 读取的采样 FPS 是 `220`；截图上的瞬时 FPS 是 `212`。两者分开记录，均不作为稳定 benchmark。

## 静态与复现门禁

Python `py_compile`、Bash `bash -n`、ShellCheck 0.11.0、Viewer `node --check`、两份 manifest JSON parse/schema、PoC contract 全部 PASS。generator/adapter 单元测试共 `8` 个通过、`0` 个失败；v3 三个 Viewer anchor 均对应真实训练相机且几何/FOV 误差约为 `1e-7` 或更小。

完整可复制命令见 `RUNBOOK.md`。停止 Viewer 时执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-22.04\home\max\src\unseen-3dgs-sceneworker\scripts\windows\Stop-Local-PexelsViewer.ps1"
```

## 回传边界

结果目录禁止文件扫描为 `0`；只包含一张本轮生成场景截图。未回传 SOG、PLY、checkpoint、source frame、视频、depth、TGZ/压缩包、`.env`、token 或完整工作目录。本地 Viewer 截图只展示任务指定的 Pexels 场景。
