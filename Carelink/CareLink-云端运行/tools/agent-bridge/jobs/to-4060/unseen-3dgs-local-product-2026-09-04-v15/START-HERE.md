# 4060 Agent：唯一入口

本任务不是又一个静态 demo。目标是把已经验证过的 360 投影、3DGS、Viewer 和照片回位整合成一套本机产品，并保持 Issue 打开，直到未知位姿的 360 视频 canary 真正跑通。

已知 4060 实机的 WSL 发行版是 **`Ubuntu-22.04`**，不是 `Ubuntu`。在 Windows PowerShell 中执行：

```powershell
$ErrorActionPreference = "Stop"
Remove-Variable Payload, LaunchOutput, LaunchResult -ErrorAction SilentlyContinue
$BridgeHome = "$HOME\AgentBridge"
$Control = "$BridgeHome\control"
$Job = "unseen-3dgs-local-product-2026-09-04-v15"
$Missing = @("gh", "git", "wsl.exe") | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) }
if ($Missing) { throw "Missing prerequisites: $($Missing -join ', '). Install them explicitly, then rerun; nothing was changed." }
if (Test-Path -LiteralPath "$Control\.git") {
  $Origin = ([string]@(& git -C $Control remote get-url origin)[-1]).Trim()
  if ($LASTEXITCODE -ne 0 -or $Origin -notmatch '^(https://github\.com/maxi-max-dev/max-agent-bridge(?:\.git)?/?|git@github\.com:maxi-max-dev/max-agent-bridge(?:\.git)?)$') { throw "Bridge origin is not the canonical private repository; nothing was pulled." }
  $Branch = ([string]@(& git -C $Control symbolic-ref --quiet --short HEAD)[-1]).Trim()
  if ($LASTEXITCODE -ne 0 -or $Branch -cne "main") { throw "Bridge checkout is not on main; nothing was pulled." }
  $Status = @(& git -C $Control status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $Status.Count -ne 0) { throw "Bridge checkout is dirty or unreadable; preserve/push it before receiving." }
  git -C $Control pull --ff-only origin main
  if ($LASTEXITCODE -ne 0) { throw "Bridge control update failed; no payload was received." }
  $Head = ([string]@(& git -C $Control rev-parse HEAD)[-1]).Trim()
  $RemoteHead = ([string]@(& git -C $Control rev-parse refs/remotes/origin/main)[-1]).Trim()
  if ($Head -cne $RemoteHead) { throw "Bridge main is locally ahead or stale; no payload was received." }
} else {
  gh auth status --hostname github.com
  if ($LASTEXITCODE -ne 0) { throw "Run gh auth login first; no repository was cloned." }
  gh repo clone maxi-max-dev/max-agent-bridge $Control
  if ($LASTEXITCODE -ne 0) { throw "Private Bridge clone failed." }
}
$LaunchOutput = @(
  & "$Control\scripts\windows\Start-V15-LocalProduct.ps1" `
    -BridgeRoot $BridgeHome -JobId $Job -Distro Ubuntu-22.04 `
    -Install -BootstrapDependencies -OpenBrowser
)
$LaunchResult = @(
  $LaunchOutput | Where-Object {
    $_ -and ($_.PSObject.TypeNames -ccontains "UNSEEN.Bridge.ReceiveResult")
  }
)
if ($LaunchResult.Count -ne 1) { throw "The launcher did not return one exact verified receive run." }
$Payload = [IO.Path]::GetFullPath([string]$LaunchResult[0].PayloadRoot)
if (-not (Test-Path -LiteralPath (Join-Path $Payload ".bridge-receipt.json") -PathType Leaf)) {
  throw "The exact launched payload lost its verified receipt."
}
```

如果是空 Windows，先让 Agent 报告缺项并取得这一次安装/重启的明确确认，再安装 Git、GitHub CLI、WSL 2、`Ubuntu-22.04` 和笔记本厂商或 NVIDIA 官方的 Windows 驱动；例如可用 `winget install --exact --id Git.Git`、`winget install --exact --id GitHub.cli` 和 `wsl.exe --install -d Ubuntu-22.04`，随后按系统提示重启。WSL 使用 Windows 主机驱动，禁止在 Ubuntu 内另装 Linux NVIDIA 驱动。第一次启动全新 Ubuntu 时完成微软要求的首次初始化，并把 Linux 用户名设为**恰好 `max`**；当前 R3 的固定 `/home/max` 路径不支持其他默认用户名，脚本会在任何安装或启动前 fail closed。唯一入口中的显式 `-BootstrapDependencies` 是本次 apt/官方 HTTPS/pip/npm 修改边界；它不会安装 Windows/WSL NVIDIA 驱动、改防火墙或开放端口。若下载或安装中断，重新运行同一完整入口块；接收回执会幂等复用合同，但启动器仍只绑定该次新返回的 exact run，ext4 中已完成的依赖步骤可续用。

每次首次安装都必须经过接收器：它先确认 control checkout 正是 canonical private repository、main 分支、干净且与 `origin/main` 完全一致，再下载 private Release、核验大小与 SHA256。解压前会枚举 ZIP，拒绝超预算、重复/大小写碰撞、Windows 保留名、路径穿越和 symlink/reparse/non-regular entry；随后核对 Release tag 内的任务合同，并按 `MANIFEST.json` 逐个核验 ZIP 内**全部**文件和精确文件集合。接收器只在回执提交成功后返回带类型的本次 `runRoot/payloadRoot`；薄启动器要求恰好一个该结果，并复核 `.bridge-receipt.json` 后才启动，绝不扫描“最新目录”或回退到旧 payload。`-Install` 会在覆盖代码前用 `/proc`、PID 文件和命令行共同排除孤儿/重复 server 或 worker，同时保留 SQLite、媒体和 checkpoint；然后只把产品、Viewer、schemas 和冻结依赖清单复制到 WSL ext4，不会调用 apt/npm/pip。这样升级不会产生“旧内存进程 + 新磁盘 runner”的混合版本。

产品至少成功安装一次后，可单独执行真正只读的 doctor；它会先重新核验 Windows payload 的 receipt/manifest，再逐文件确认 ext4 中的 release evidence、doctor/start/stop/bootstrap、产品和 runner 指纹，之后只读检查 distro/VHDX 与宿主剩余空间、`wsl -l -v`、默认用户 `max`、Windows RTX 4060 驱动、可读取的电源/睡眠策略和 Linux 工具链，然后返回，不启动 server、worker 或浏览器，也不改系统。空机第一次执行直接使用上面的 `-Install`；不能用未安装的 mounted payload 冒充 doctor：

```powershell
& "$Payload\inputs\scripts\windows\Start-UNSEEN-LocalProduct.ps1" -Distro Ubuntu-22.04 -PayloadRoot $Payload -DoctorOnly
```

插电、NVIDIA-only/MUX 和整轮禁止睡眠无法在所有笔记本上可靠自动判定，doctor 会把这些明确标为 `PENDING_MANUAL`，由 4060 Agent 当场确认。只读 doctor 若报告产品 `.venv` 缺失，或旧 PoC `.venv` 虽存在但 Python/Nerfstudio/gsplat 版本不符合冻结合同，4060 Agent 直接在同一个 PowerShell 窗口重跑下面一条；这条命令中的 `-BootstrapDependencies` 就是 apt、官方 HTTPS 下载、pip 和 npm 的显式确认边界。它只新建/修复产品自己的 `.venv`，不修改旧 PoC `.venv`；会出现 WSL `sudo` 提示，但仍不会安装 Linux NVIDIA 驱动、改防火墙或开放端口：

```powershell
& "$Payload\inputs\scripts\windows\Start-UNSEEN-LocalProduct.ps1" -Distro Ubuntu-22.04 -PayloadRoot $Payload -Install -BootstrapDependencies -OpenBrowser
```

缺少 `gh`、Git、WSL 2、`Ubuntu-22.04` 或 Windows NVIDIA 驱动时必须明确报告缺项，不能把“依赖不存在”写成成功。依赖 bootstrap 只支持 Ubuntu 22.04 x86_64；Node、gsplat、Nerfstudio 与 Python lock 均固定版本，包内 wheel/npm lock 与已捆绑依赖文件有 SHA256；PyPI lock 并非每一行都有独立下载哈希，不能把它描述成完全 hash-locked。下载失败就停住，不换成未审计版本。

执行前确认：电脑插电；Windows 使用 NVIDIA 独显/MUX；系统和 WSL 均禁止自动睡眠；Windows NVIDIA 驱动可用。不要在 Windows `/mnt/c`、iCloud 或 GitHub checkout 内训练；脚本会把代码与全部媒体/训练 work 分开，后者固定在 WSL ext4 `/home/max/unseen-local-product`。

上述命令会先只读定位 `Ubuntu-22.04` 的真实 `ext4.vhdx` 所在 Windows 卷并检查宿主卷剩余空间；低于 **40 GiB** 时以 `BLOCKED_WSL_HOST_DISK` 停止，且发生在安装、启动或训练之前。不能只相信 WSL 内的 `df`：VHDX 可能仍显示很大的逻辑空间，但承载它的 Windows C: 已接近写满。通过后才做用户目录安装、只读 WSL doctor、启动 `127.0.0.1:8780` UI 和一个 GPU worker；启动后还会从 Windows 宿主真实请求一次 `/api/health`，证明 Windows 浏览器能经 WSL loopback forwarding 访问。不会改驱动/CUDA、不会 `apt install`、不会改防火墙、不会装开机任务、不会连接生产。

### 宿主盘不足时（默认只报告，不自动迁移）

启动脚本绝不会移动 WSL。优先清理 VHDX 当前所在卷；如果必须移到 D:，先把阻断信息回传，并取得 Max 对这一次系统迁移的明确确认。获批后由 4060 Agent 独立执行并逐条检查，不能塞进启动脚本：

```powershell
$Distro = "Ubuntu-22.04"
$BackupDir = "D:\UNSEEN-WSL-backup"
$TargetDir = "D:\WSL\Ubuntu-22.04"
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
wsl.exe --shutdown
wsl.exe --export $Distro "$BackupDir\Ubuntu-22.04-before-move.tar"
if ($LASTEXITCODE -ne 0) { throw "WSL export failed; do not move or unregister anything." }
$MoveSupported = wsl.exe --help | Select-String -SimpleMatch "--move" -Quiet
if (-not $MoveSupported) { throw "This WSL does not expose --move. Stop and request a dedicated migration; do not use --unregister." }
wsl.exe --manage $Distro --move $TargetDir
if ($LASTEXITCODE -ne 0) { throw "WSL move failed. Keep the backup and stop for diagnosis." }
wsl.exe -d $Distro -- bash -lc 'test -d /home/max && nvidia-smi --query-gpu=name --format=csv,noheader'
if ($LASTEXITCODE -ne 0) { throw "Moved distro failed the /home/max or NVIDIA visibility check. Keep the backup and stop." }
```

保留导出备份，直到产品重新通过 doctor、原 PoC 文件存在、队列数据库可读。不要用资源管理器手工剪切 `ext4.vhdx`，也不要把 `wsl --unregister` 当成快捷迁移。全新空机如确定要直接装到 D:，同样先取得明确确认，再使用当前 `wsl.exe --help` 所支持的 `wsl --install -d Ubuntu-22.04 --location D:\WSL\Ubuntu-22.04`；安装/重启完成后才继续本页。

页面是唯一日常入口：场景完成后点击“打开可漫游场景”，不需要另开 Viewer 服务；新照片定位完成后重新打开同一场景，“Return to source frame”会指向最新照片的估计位置。相同视频重复上传或重复点击生成不会再造 sceneRevision/job。

然后由 Agent 自动执行**完整**集成 canary（不是让 Max 手抄，也不是只排队后就结束）：

```powershell
$bridgeWindows = "$HOME\AgentBridge\control"
$bridgeEscaped = $bridgeWindows.Replace('\', '\\')
$bridgeWslOutput = & wsl.exe -d Ubuntu-22.04 -- wslpath -u -a $bridgeEscaped
if ($LASTEXITCODE -ne 0 -or -not $bridgeWslOutput) { throw "Bridge path translation failed." }
$bridgeWsl = ([string]@($bridgeWslOutput)[-1]).Trim()
& "$bridgeWindows\scripts\windows\Submit-BridgeReceipt.ps1" -RepoDir $bridgeWindows -JobId "unseen-3dgs-local-product-2026-09-04-v15" -State RUNNING -Message "Starting the exact verified R3 isolated 4060 canary; production remains disabled." -Evidence @("profile:preview-7000", "production:false", "gpu_jobs:1")
if ($LASTEXITCODE -ne 0) { throw "RUNNING receipt failed; do not begin an untracked GPU run." }
wsl.exe -d Ubuntu-22.04 -- bash /home/max/src/unseen-local-product/app/run-v15-integration-canary.sh --confirm-full-canary --bridge-root "$bridgeWsl"
if ($LASTEXITCODE -ne 0) { throw "V15 integration canary failed; keep the goal open and inspect the concrete WSL error before retrying." }
```

如果真实 cache 路径 `/home/max/src/unseen-3dgs-sceneworker/data/360roam-base-v10/download/panos` 不存在，默认命令会停住，不下载隐私素材，也不把任务写成成功。只有 Agent 明确同意取得这份约 674 MB 的公开研究 fixture 时，才在 canary 命令末尾加 `--confirm-download-public-fixture`：打包的可续传 downloader 只出站到 360Roam 作者的官方 HTTPS 主机，按 payload 内自包含的 source manifest 对 60 张图逐文件核验大小/SHA256，媒体只留 WSL ext4。下载器也会为源选择校验保留作者 pose，但产品上传只读取 60 张 panorama 合成的视频，绝不接收 pose/remotePath。核验通过后，脚本会生成一个 2:1 MP4，然后自动跑完：真实 HTTP 上传 → 未知位姿 SfM → 单个 7k preview → PLY/SOG → Viewer HTTP/Range → 三张未参与训练的不同时间/方向照片回位 → 杀掉一次在途 worker → 180 秒 lease 到期后由新 worker 以相同 jobId、增加的 attempt 和不同 lease owner 完成。

默认 runId 由核验后的 Release asset SHA/Release tag 目标 commit、产品与 runner、完整 Viewer、安装/doctor/start/canary 脚本、冻结依赖与 source manifest、ffmpeg 编码合同和实测运行时指纹共同确定；同一合同失败后重跑会得到相同 MP4 SHA/scene/job，并从安全失败阶段续跑，任何这些代码、Viewer、依赖、素材合同或运行时改变才会自动形成新 revision。若同一版已经 ready，脚本只在本机上一份同 runId 报告已证明 recovery PASS 时复验 Viewer/三张照片并保留该恢复证据，否则会 fail closed。只有 Agent 明确决定重做完整 7k 恢复实验时，才可在上述命令末尾加 `--new-run`；它会加入随机 salt。整轮脚本持有单 GPU canary lock，第二个并发调用会明确退出。

脚本把脱敏后的 `V15-REPORT.md` 与 `V15-RESULT.json` 写入 Bridge 的 `results/from-4060/unseen-3dgs-local-product-2026-09-04-v15/`。4060 Agent 随后必须亲自打开脚本输出的 Viewer URL，确认能平视走动、滚轮/按钮缩放、方向不歪、六方向可辨，而且三个照片锚点都能分别返回。不能手改报告；只有全部为真时运行下面的 allowlist 发布门。它会再次核对 Release/manifest/runtime、GPU、7k、SOG HTTP、三照片质量、180 秒租约恢复、loopback 和隐私边界，只提交两份报告，并依次写 `UPLOADING`、`COMPLETED` 回执；Issue #16 仍保持打开：

```powershell
& "$Payload\inputs\scripts\windows\Publish-V15-VisualAcceptance.ps1" `
  -BridgeCheckout "$HOME\AgentBridge\control" `
  -ConfirmPublish -WalkPass -ZoomInOutPass -HorizonLevelPass `
  -SixDirectionsPass -ThreePhotoAnchorsPass -NoPageErrors
```

若任何一项不通过，不要传这些开关；保留 `RUNNING_*`，修复后从安全 checkpoint 重试。报告里不能出现绝对媒体路径。

canary 中发现 SfM、训练、SOG、Viewer 或恢复缺陷时，继续修复这个 v15 分支并重复安全的失败阶段；不要把某次失败当作本目标结束。每次最多一个 GPU job，禁止同时跑旧版本。

产物只留本机。GitHub 只回传 `V15-REPORT.md`、`V15-RESULT.json`、脱敏日志/benchmark、源码 patch 与 hash；禁止提交 MP4、frames、照片、SOG、PLY、checkpoint、数据库、权重、token、`.env` 或 work。

v15 达到 `LOCAL_PRODUCT_READY_FOR_NEW_INPUT` 后也不是整个 UNSEEN 成品完成：保持 UI 可用，等待下一份从未参与开发的真实 360 视频和三张不同实拍照片完成最终验收。

### 可选常驻（默认 disabled）

包内两个 systemd 文件只是 **user unit 模板**。不得复制到 `/etc/systemd/system`、不得用 `sudo systemctl`；只有 preview 成功且 Max 明确同意后，才可复制到 `~/.config/systemd/user/`，运行 `systemctl --user daemon-reload` 并按需 enable。它们固定使用产品自己的 `.venv`，默认模板本身不会安装或启用服务。Windows 登录任务同样必须在 preview 成功和 Max 同意后显式运行下面命令；注册后仍保持 disabled，并精确复核 action、参数、当前用户 logon trigger 与状态，之后还需另一次明确的 `Enable-ScheduledTask` 才会启动：

```powershell
& "$Payload\inputs\scripts\windows\Install-Disabled-StartupTask.ps1" -PayloadRoot $Payload -Distro Ubuntu-22.04 -ConfirmInstall
```

脚本只管理根 TaskPath `\` 下这个确切任务；若它已存在，默认不改任何内容。先人工检查它；只有 Max 明确同意替换时才额外传 `-ReplaceExisting`。替换前会导出原任务，任何注册/复核失败都会先禁用部分新任务并精确复核原 XML 是否恢复；不要删掉 `$Payload`，因为登录动作每次都会重新核验该 payload 后才运行 ext4 内已安装脚本。
