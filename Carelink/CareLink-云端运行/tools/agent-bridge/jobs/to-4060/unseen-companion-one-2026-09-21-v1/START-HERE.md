# 4060 接手：UNSEEN × Companion One 空间窗口

Job：`unseen-companion-one-2026-09-21-v1`。接收方是已经开发 UNSEEN 的真实 RTX 4060 Windows Agent。**这是已授权的继续开发任务，不是只保存一份资料。**

Max 在 2026-09-21 明确要求：“推送给4060……把所有的信息都推送给他……直接在上面加以开发……屏幕马上到了”。此前已经确认买了自由象限 Companion One，并可以使用 Windows 电脑测试。

目标：接管已有 v0.1，在 4060 的 Windows 环境实际跑通并修复，接入一份已有 UNSEEN 静态空间内容，准备屏幕到货后的校准和光学测试。电脑负责计算，C1 负责显示；树莓派和独立计算硬件暂不进入范围。

## 先取得本次精确包

复用自己的既有 Bridge control checkout，读取本机 AGENTS 和本 job 的最新回执。不要重跑 v15、重建 3DGS 或恢复 H3。以下默认根目录为 Windows 用户目录下的 `AgentBridge`；若现有 control 在其他目录，使用已核实的原路径，不猜最新目录。

```powershell
$ErrorActionPreference = 'Stop'
$C1JobId = 'unseen-companion-one-2026-09-21-v1'
$C1BridgeRoot = Join-Path $env:USERPROFILE 'AgentBridge'
$C1Control = Join-Path $C1BridgeRoot 'control'
# 先保存 control 的未提交工作；只在它为干净 main 时快进，不做 reset/clean。
git -C $C1Control pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'Preserve local work and resolve the control checkout before receiving' }
$C1Receive = @(& (Join-Path $C1Control 'scripts/windows/Receive-BridgeJob.ps1') -JobId $C1JobId -BridgeRoot $C1BridgeRoot)
$C1Typed = @($C1Receive | Where-Object { $_.PSObject.TypeNames -contains 'UNSEEN.Bridge.ReceiveResult' })
if ($C1Typed.Count -ne 1) { throw 'Expected one current typed receive result' }
$C1Received = $C1Typed[0]
if ($C1Received.JobId -cne $C1JobId -or $C1Received.State -cne 'RECEIVED_VERIFIED') { throw 'Wrong receive identity' }
$C1Project = & (Join-Path $C1Received.PayloadRoot 'Prepare-Runtime.ps1')
Write-Host ('Verified baseline project: ' + $C1Project)
```

本任务是 **Windows 原生浏览器/Node 显示端**，接收器末尾通用“进入 WSL 训练”的提示不适用。WSL 只在复用现有 3DGS 离线渲染器确有需要时使用。

`Prepare-Runtime.ps1` 会从同一 private Release 下载原始 2.1 MiB 运行包，核完整 SHA、大小和 30 个文件，然后解压到短路径下。控制包、运行包都要核验，之后才回报运行包已收到。原 ZIP 内含完整源码、最小 Three.js 依赖、Windows/Mac 启动器、官方调研记录及源码定位、标准 Quilt PNG、许可和测试。

## 立即继续的开发工作

1. **Windows 基线。** 记录实际 Windows / GPU / Node / Chrome或Edge版本，检查现有进程和端口，复用可用依赖。运行 `start-windows.cmd`，确认 localhost 页面、两个场景、GLB 导入和 Quilt 导出。项目依赖可安装或修复；不要重装 CUDA/WSL/训练环境。自动测试里的 Chrome 路径和 Metal 参数来自 Mac，按实际 Windows 浏览器改成平台适用配置；保留原始包，改动在固定开发目录/分支记录。
2. **显示端产品化。** 把启动、停止、端口占用提示、参数导入错误、全屏/退出、校准丢失提示做可靠。程序仅监听本机。无设备时预览/导出仍可用；不能写成设备已连接。保留 40 视图、8×5、每格 540×960、完整 4320×4800、1440×2560 输出，以及已实现的平行相机离轴投影。新增内容需验证焦平面稳定、行列/视序、DPR 和原生像素检查。
3. **接入你已有的 UNSEEN 内容。** 先检查本机当前场景目录、scene.json/相机约定和真实可加载产物。优先复用已经存在的 SOG/PLY/3DGS 与现有渲染器，做“选择一个场景 → 定取景/焦平面/浅景深 → 输出 C1 Quilt”的最短链路。可先离线渲染 40 视角，不要求第一版实时 40 相机。当前 GLB 导入器不支持 3DGS；不得把改扩展名、普通截图平移或视频自转当作完成接入。模型、照片、原视频留在本机，不上传 Git。
4. **准备光学验证。** 准备官方 CubeStage 安装入口及一页接线指南。先用官方样例建立硬件基线，再导入实际这台 C1 的校准。校准文件可能在 `%APPDATA%\Cubestage\deviceConfig.json` 或旧 `OpenstageAI` 路径；当前解析代码只是公开 SDK 格式移植，遇到新版本按实际文件适配，不猜参数。账号登录由 Max 正常完成，不读取或发送凭据。
5. **持续推进到可用交付。** 普通代码修复/测试/本机运行不逐步退回 Mac 等批准。屏幕未到不阻塞前三项；完成所有独立项后写 `READY_FOR_HARDWARE` 与下一条接屏动作，不伪造光学通过。屏幕到达并由 Max 接上后，继续实际验证和修复。

代码建议放在既有仓库的独立 `development/companion-one-lab/` 或独立本地开发仓，用 `codex/` 分支；以本机真实上下文选择最少改动的路径。不要覆盖冻结交接包或把实验代码直接合并到 UNSEEN 生产应用。你已熟悉 UNSEEN，先读 `CONTEXT.md` 的最新指针，无需重读整个历史。

## 回执与结果

原接收器产生控制包 `RECEIVED_VERIFIED`。运行包验证成功后，在本 job 的 Issue 回报实际机器名、运行包 SHA、代码路径/版本与第一条实际运行结果，并使用既有 `Submit-BridgeReceipt.ps1` 追加 `RUNNING`。不要仅回复“收到，开始研究”。

源码变更通过独立分支/PR提交；必要的脱敏报告放在 `results/from-4060/unseen-companion-one-2026-09-21-v1/`。至少交：`REPORT.md`、`STATUS.json`、实际测试命令/结果、启动步骤、选定场景的来源/本机 hash、输出格式/性能和未过项。屏幕测试如实分开记录官方样例与自研内容的结果。测试图片和本机模型按原数据边界处理；Git 只交源码和脱敏元数据。

仅“网页打开”“GPU 在跑”“生成了 PNG”都不代表光学完成。`COMPLETED` 需满足 `ACCEPTANCE.md` 的全项并有 Max 的肉眼观察；无硬件时用报告里的 `READY_FOR_HARDWARE` 子状态，Bridge 不虚构硬件回执。

保持其他工作的现场和单 GPU 约束。不要打断已有健康训练/生成进程，不删除数据，不改生产、不付费调用、不开放公网端口。重建/训练新空间不是这次显示研发的前提。
