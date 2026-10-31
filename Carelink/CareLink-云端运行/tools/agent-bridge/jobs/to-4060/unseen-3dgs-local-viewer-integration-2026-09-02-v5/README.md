# v5 P0：整合 v3/v4，并在 4060 本机启动 Pexels Viewer

人类状态页：[GitHub Issue #5](https://github.com/maxi-max-dev/max-agent-bridge/issues/5)

## 目标

本轮不再训练。把 v3/v4 已回传但尚未集成的代码整理为一套可复现补丁，修复 Mac 验收发现的问题，然后复用 4060 WSL ext4 上现存的 **Pexels v3 SOG** 启动本机 Viewer，并在 Windows 本机浏览器中打开。

完成本任务不代表生产接入完成。GitHub 仍只是控制面；香港生产 API、数据库、租约和 token 一律不接触。

## 4060 Agent 唯一入口

在现有 Windows PowerShell Bridge checkout 中执行：

```powershell
git -C "$HOME\AgentBridge\control" pull --ff-only origin main
& "$HOME\AgentBridge\control\scripts\windows\Submit-BridgeReceipt.ps1" `
  -RepoDir "$HOME\AgentBridge\control" `
  -JobId "unseen-3dgs-local-viewer-integration-2026-09-02-v5" `
  -State "RECEIVED_VERIFIED" `
  -Message "v5 integration and loopback-only local Viewer task received; no retraining or artifact upload will run."
```

随后完整阅读本文件，在 `/home/max/src/unseen-3dgs-sceneworker` 工作。不要重新下载 Release，不要新建训练任务。

## 先冻结现状

1. 确认没有 `ns-train`、COLMAP、SOG 转换或其他 GPU job 正在运行；只读记录 `nvidia-smi`。
2. 记录当前源文件 hash 和 v1-v4 artifact hash；不得覆盖已有 config、checkpoint、PLY、SOG、transforms 或报告。
3. 在 WSL ext4 中定位 Pexels v3 SOG，必须同时匹配：
   - bytes：`2693010`
   - SHA256：`0d417735d1b91573f2e2199b53567c07014a420943dac8c84cb73811a1ec0e01`
4. 找不到或 hash 不符时提交 `BLOCKED`；禁止用 TUM SOG、旧版 SOG 或占位文件冒充。

## 必须整合和修复

以 v3/v4 返回补丁为输入，不从零重写训练链路：

- v3：`results/from-4060/unseen-3dgs-sfm-repair-2026-09-02-v3/fixes/v3-sfm-training-viewer.patch`
- v4：`results/from-4060/unseen-3dgs-tum-first-usable-scene-2026-09-02-v4/fixes/tum-v4-implementation.patch`

两份补丁对 `viewer/app.js` 和 `viewer/scene.schema.json` 的最终内容相同，只合并一次；不得连续盲目 `git apply` 后忽略冲突。其余脚本全部保留为两个独立 profile。

修复以下验收缺口：

1. `logs/commands.txt` 中的每条项目脚本命令必须与对应 `--help` 一致。当前已知错误包括：
   - v3 日志使用 `repair_sfm_v3.py --candidate`，而回传脚本只接受位置参数；
   - v4 adapter 日志使用未实现的 `--target-hz/--max-frames`；
   - v4 Viewer generator 日志使用未实现的 `--output`。
2. 回传并纳入补丁，不能只留在 4060 本机：
   - `run_tum_v4_train.sh`
   - `evaluate_tum_v4.py`
   - `validate_tum_v4_artifacts.py`
   - `viewer_v4_e2e.js`
   - `viewer_repair_v3_e2e.js`
3. 所有 gate validator 在 gate 失败时必须以非零状态退出；特别修复 v3 artifact validator 当前无条件 `return 0`。
4. photo-anchor 模式必须完整恢复照片相机 Y；第一次自由移动时再显式切到 `navigation.eyeHeight` 固定行走平面。界面显示的 eye height 必须与实际 walk Y 一致。
5. 提供一份 `RUNBOOK.md`，命令可以直接复制执行，禁止 `<raw-ply>` 一类无法执行的伪命令冒充复现步骤。
6. 提供以下无管理员权限的 PowerShell 启停脚本，默认项目路径为上述 WSL 路径：
   - `scripts/windows/Start-Local-PexelsViewer.ps1`
   - `scripts/windows/Stop-Local-PexelsViewer.ps1`
   启动脚本可带 `-OpenBrowser`，但不得改防火墙、端口转发、登录启动项、Task Scheduler 或 systemd。

## 本机 Viewer 启动规则

- 只启动 Pexels v3；TUM v4 本轮只做代码整合和静态测试。
- 使用已存在且 hash 匹配的 SOG；可在 WSL ext4 内复制或建立本地链接到 `viewer/assets/`，不得上传。
- HTTP server 必须绑定 `127.0.0.1`。优先端口 `8765`；占用时只可选择 `8766` 至 `8775` 并报告实际端口。
- 先在 WSL 验证 HTTP `200`，再从 Windows PowerShell 验证同一 `http://127.0.0.1:<port>/` 可达；若 WSL localhost forwarding 不工作，提交 `BLOCKED`，不得扩大监听到 `0.0.0.0`。
- 在 Windows 默认浏览器打开实际 scene URL。任务结束后 Viewer server 保持运行，但必须同时留下无需管理员权限的一键停止脚本。
- 不安装常驻服务，不设开机启动，不开放公网或局域网端口。

## 验证

本轮新训练次数必须为 `0`，quality 30k 次数必须为 `0`。至少完成：

- 所有新增/修改 Python `py_compile`；Shell `bash -n`/ShellCheck；Viewer `node --check`；JSON parse/schema；
- v3/v4 generator 和 adapter 单元测试；
- 对 README/RUNBOOK 中项目脚本命令逐条执行 `--help` 或等价 dry-run，证明参数真实存在；
- 真实 Pexels v3 SOG 显示 `SOG ready`；有边界移动；photo anchor 恢复 position/quaternion/FOV 和确认文案；
- Windows 本机 `127.0.0.1` URL 实测可达并已调用默认浏览器；
- 完整 patch 对干净 PoC 副本 `git apply --check`；
- 结果目录生成文件大小和 SHA256 manifest；
- 禁止文件扫描为 0。

GitHub Actions 通过只证明 Bridge JSON/边界结构正常，不能代替上述实机验证。

## 回传

```text
results/from-4060/unseen-3dgs-local-viewer-integration-2026-09-02-v5/
  LOCAL-VIEWER-REPORT.md
  INTEGRATION-RESULT.json
  RUNBOOK.md
  REPORT-FILES.json
  fixes/*.patch
  logs/（静态检查、单测、E2E、loopback HTTP 与脱敏 server 日志）
  viewer-screenshot.png
```

`INTEGRATION-RESULT.json` 至少记录：实际 SOG hash/bytes、训练次数、测试结果、Viewer URL/端口/PID、WSL 和 Windows HTTP 状态、浏览器启动状态、SOG ready、移动距离/边界、photo-anchor 误差、patch hash、禁止文件计数。未测值保持 `null/PENDING`。

完成回执必须给出 `LOCAL-VIEWER-REPORT.md` 路径、实际 Windows 本机 URL，以及“Viewer 仍在运行”或真实阻塞状态。

## 禁止事项

- 禁止训练或转换新的 PLY/SOG；禁止运行 30k；禁止删除旧 artifact。
- 禁止上传 SOG、PLY、checkpoint、source frames、视频、depth、TGZ、`.env`、token、完整 work 目录或带隐私的截图。
- 禁止连接生产 API/数据库、创建生产任务、写 vault、付费 API 或外发素材。
- 禁止监听 `0.0.0.0`、修改 Windows Firewall、路由器、端口映射或创建公网入口。
- 禁止把截图 FPS 当成稳定 benchmark；报告 E2E 采样值和截图瞬时值时必须分别标注。
