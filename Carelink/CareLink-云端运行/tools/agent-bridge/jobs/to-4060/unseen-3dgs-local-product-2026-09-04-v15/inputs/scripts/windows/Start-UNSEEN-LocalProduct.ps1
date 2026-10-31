[CmdletBinding()]
param(
  [string]$Distro = "Ubuntu-22.04",
  [string]$BridgeCheckout = "$HOME\AgentBridge\control",
  [string]$PayloadRoot = "",
  [switch]$Install,
  [switch]$BootstrapDependencies,
  [switch]$DoctorOnly,
  [switch]$OpenBrowser
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$minimumHostFreeGiB = 40

function Get-WslStorage([string]$DistributionName) {
  $lxss = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss"
  if (-not (Test-Path -LiteralPath $lxss)) {
    throw "WSL registry metadata is missing. Install WSL 2 and $DistributionName first. Nothing was changed."
  }

  $matches = @(
    Get-ChildItem -LiteralPath $lxss | ForEach-Object {
      Get-ItemProperty -LiteralPath $_.PSPath
    } | Where-Object { $_.DistributionName -eq $DistributionName }
  )
  if ($matches.Count -ne 1) {
    $known = @(
      Get-ChildItem -LiteralPath $lxss | ForEach-Object {
        (Get-ItemProperty -LiteralPath $_.PSPath).DistributionName
      } | Where-Object { $_ }
    ) -join ", "
    throw "Expected exactly one WSL distro named '$DistributionName'; found $($matches.Count). Installed: $known. Nothing was changed."
  }

  $basePath = [Environment]::ExpandEnvironmentVariables([string]$matches[0].BasePath)
  if ($basePath.StartsWith("\\?\")) { $basePath = $basePath.Substring(4) }
  if (-not (Test-Path -LiteralPath $basePath)) {
    throw "WSL distro '$DistributionName' has an unreadable BasePath: $basePath. Nothing was changed."
  }

  $vhdx = @(Get-ChildItem -LiteralPath $basePath -Filter "ext4.vhdx" -File -ErrorAction SilentlyContinue)
  if ($vhdx.Count -ne 1) {
    throw "Expected exactly one ext4.vhdx for '$DistributionName' under $basePath; found $($vhdx.Count). WSL 2 storage cannot be identified unambiguously. Nothing was changed."
  }
  $volumeRoot = [IO.Path]::GetPathRoot($vhdx[0].FullName)
  if ($volumeRoot -notmatch "^[A-Za-z]:\\$") {
    throw "Could not map WSL VHDX to a local Windows volume: $($vhdx[0].FullName). Nothing was changed."
  }
  $driveLetter = $volumeRoot.Substring(0, 1)
  $drive = Get-PSDrive -Name $driveLetter -PSProvider FileSystem -ErrorAction Stop
  if ($null -eq $drive.Free) {
    throw "Free space is unavailable for WSL host volume $volumeRoot. Nothing was changed."
  }
  [pscustomobject]@{
    Distro = $DistributionName
    Vhdx = $vhdx[0].FullName
    Volume = $volumeRoot
    FreeBytes = [int64]$drive.Free
    FreeGiB = [Math]::Round(([double]$drive.Free / 1GB), 2)
  }
}

function Assert-WslHostStorage([string]$DistributionName) {
  $storage = Get-WslStorage $DistributionName
  if ($storage.FreeBytes -lt ([int64]$minimumHostFreeGiB * 1GB)) {
    throw "BLOCKED_WSL_HOST_DISK: '$($storage.Distro)' is stored on $($storage.Volume) with only $($storage.FreeGiB) GiB free; at least $minimumHostFreeGiB GiB is required before a preview. Startup did not install, move, delete, or train anything. Free space or follow the explicitly approved D: migration section in START-HERE.md."
  }
  Write-Host "PASS WSL host storage: $($storage.Distro) VHDX is on $($storage.Volume), $($storage.FreeGiB) GiB free (minimum $minimumHostFreeGiB GiB)."
}

function Assert-ReadOnlyHostFacts([string]$DistributionName) {
  $distroOutput = & wsl.exe --list --verbose
  $distroExit = $LASTEXITCODE
  $distroText = ((@($distroOutput) -join "`n") -replace [string][char]0, "")
  if ($distroExit -ne 0 -or $distroText -notmatch "(?m)^\s*\*?\s*$([Regex]::Escape($DistributionName))\s+\S+\s+2\s*$") {
    throw "wsl.exe --list --verbose did not prove that '$DistributionName' is a WSL 2 distro. Nothing was changed."
  }
  Write-Host "PASS wsl.exe --list --verbose: $DistributionName is WSL 2."

  $wslUserOutput = & wsl.exe -d $DistributionName -- id -un
  $wslUserExit = $LASTEXITCODE
  $wslUsers = @($wslUserOutput | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
  if ($wslUserExit -ne 0 -or $wslUsers.Count -ne 1 -or $wslUsers[0] -cne "max") {
    throw "R3 requires the '$DistributionName' default WSL user to be exactly 'max'; found '$($wslUsers -join ',')'. Nothing was changed."
  }
  Write-Host "PASS default WSL user is exactly max."

  $adapters = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop)
  $rtx4060 = @($adapters | Where-Object { $_.Name -match "RTX\s+4060" -and $_.DriverVersion })
  if ($rtx4060.Count -lt 1) {
    throw "Windows did not expose an RTX 4060 with a driver version. Install the Windows NVIDIA driver explicitly; nothing was changed."
  }
  $rtx4060 | ForEach-Object { Write-Host "PASS Windows GPU: $($_.Name), driver $($_.DriverVersion)." }
}

function Get-SafePayloadRelativePath([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 240 -or
      $Value.Contains("\") -or $Value.StartsWith("/") -or $Value -match '^[A-Za-z]:') {
    throw "Unsafe portable payload path: $Value"
  }
  $parts = @($Value.Split('/'))
  if ($parts.Count -eq 0 -or @($parts | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0) {
    throw "Unsafe payload path component: $Value"
  }
  foreach ($part in $parts) {
    $deviceBase = ([Regex]::Replace($part, '\..*$', '')).TrimEnd([char[]]@(' '))
    if ($part -match '[\x00-\x1f<>:"|?*]' -or $part.EndsWith(".") -or $part.EndsWith(" ") -or
        $deviceBase -match '^(?i:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM(?:[1-9]|\u00B9|\u00B2|\u00B3)|LPT(?:[1-9]|\u00B9|\u00B2|\u00B3))$') {
      throw "Payload path is not portable to Windows: $Value"
    }
  }
  return ($parts -join '/')
}

function Read-VerifiedBridgeReceipt([string]$ReceiptPath, [string]$ExpectedJob, [object]$ExpectedTask) {
  if (-not (Test-Path -LiteralPath $ReceiptPath -PathType Leaf)) {
    throw "Verified unpacked payload is missing .bridge-receipt.json. Re-run Receive-BridgeJob.ps1; nothing was installed."
  }
  try {
    $receipt = Get-Content -LiteralPath $ReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $bytes = [int64]$receipt.assetBytes
    $valid = (
      ([string]$receipt.jobId -ceq $ExpectedJob) -and
      ([string]$receipt.releaseTag -match "^[A-Za-z0-9._-]+$") -and
      ([string]$receipt.assetName -match "^[A-Za-z0-9._-]+$") -and
      ([string]$receipt.assetSha256 -match "^[a-f0-9]{64}$") -and
      ($bytes -gt 0) -and
      ([string]$receipt.controlCommit -match "^[a-f0-9]{40,64}$") -and
      ([string]$receipt.payloadManifestSha256 -match "^[a-f0-9]{64}$") -and
      ([int]$receipt.payloadFileCount -gt 0)
    )
  } catch {
    throw "Invalid .bridge-receipt.json: $($_.Exception.Message). Nothing was installed."
  }
  if (-not $valid) {
    throw "The Bridge receipt does not bind this exact job/tag/asset/SHA/bytes/control commit. Nothing was installed."
  }
  $artifact = $ExpectedTask.artifact
  foreach ($field in @("releaseTag", "assetName", "sha256", "bytes", "payloadManifestSha256", "payloadFileCount")) {
    $receiptField = switch ($field) {
      "sha256" { [string]$receipt.assetSha256 }
      "bytes" { [string]$receipt.assetBytes }
      default { [string]$receipt.$field }
    }
    if ($receiptField -cne [string]$artifact.$field) {
      throw "Bridge receipt disagrees with current TASK.json artifact.$field. Nothing was installed."
    }
  }
  return $receipt
}

function Assert-CompletePayload([string]$Root, [object]$TaskObject, [object]$Receipt) {
  if ([string]$TaskObject.artifact.payloadManifestPath -cne "MANIFEST.json") {
    throw "Expected a flat MANIFEST.json payload contract. Nothing was installed."
  }
  $manifestPath = Join-Path $Root "MANIFEST.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "MANIFEST.json is missing. Nothing was installed." }
  $manifestSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($manifestSha -cne [string]$TaskObject.artifact.payloadManifestSha256 -or
      $manifestSha -cne [string]$Receipt.payloadManifestSha256) {
    throw "MANIFEST.json SHA256 no longer matches the received release. Nothing was installed."
  }
  try { $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json }
  catch { throw "MANIFEST.json is invalid: $($_.Exception.Message). Nothing was installed." }
  $entries = @($manifest.files)
  if ($manifest.schemaVersion -cne "1.0" -or $manifest.jobId -cne $TaskObject.jobId -or
      $manifest.releaseTag -cne $TaskObject.artifact.releaseTag -or
      $manifest.scope -cne "release-payload" -or -not ($manifest.selfExcluded -is [bool]) -or
      $manifest.selfExcluded -ne $true -or -not ($manifest.taskExcluded -is [bool]) -or
      $manifest.taskExcluded -ne $true -or $entries.Count -ne [int]$Receipt.payloadFileCount) {
    throw "MANIFEST.json identity/count contract failed. Nothing was installed."
  }
  $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  foreach ($entry in $entries) {
    $relative = Get-SafePayloadRelativePath ([string]$entry.path)
    if ($relative -ceq "MANIFEST.json" -or -not $expected.Add($relative)) {
      throw "MANIFEST.json contains itself or a duplicate path. Nothing was installed."
    }
    $candidate = Join-Path $Root ($relative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Payload file is missing: $relative" }
    $item = Get-Item -LiteralPath $candidate -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne [int64]$entry.bytes) {
      throw "Payload file type/size check failed: $relative"
    }
    $digest = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $digest -cne ([string]$entry.sha256).ToLowerInvariant()) {
      throw "Payload SHA256 check failed: $relative"
    }
  }
  $null = $expected.Add("MANIFEST.json")
  $null = $expected.Add(".bridge-receipt.json")
  $actual = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force -Recurse)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Payload contains a reparse point. Nothing was installed." }
    if (-not $item.PSIsContainer) {
      $full = [IO.Path]::GetFullPath($item.FullName)
      if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) { throw "Payload escaped its root." }
      $null = $actual.Add($full.Substring($rootFull.Length).Replace('\', '/'))
    }
  }
  if (-not $actual.SetEquals($expected)) {
    throw "Payload tree has an unlisted, missing or altered file. Re-run Receive-BridgeJob.ps1; nothing was installed."
  }
  Write-Host "PASS complete payload manifest: $($entries.Count) files / $manifestSha."
  return [pscustomobject]@{ Manifest = $manifest; ManifestSha256 = $manifestSha }
}

function Get-ManifestFileSha256([object]$Manifest, [string]$RelativePath) {
  $safeRelative = Get-SafePayloadRelativePath $RelativePath
  $matches = @($Manifest.files | Where-Object { [string]$_.path -ceq $safeRelative })
  if ($matches.Count -ne 1 -or [string]$matches[0].sha256 -notmatch '^[a-f0-9]{64}$') {
    throw "MANIFEST.json does not contain exactly one valid SHA256 for $safeRelative."
  }
  return ([string]$matches[0].sha256).ToLowerInvariant()
}

function Get-WslFileSha256([string]$DistributionName, [string]$LinuxPath) {
  if ($LinuxPath -notmatch '^/home/max/[A-Za-z0-9._/-]+$') { throw "Unsafe installed WSL path: $LinuxPath" }
  $checkCommand = "test -f '$LinuxPath' && test ! -L '$LinuxPath'"
  & wsl.exe -d $DistributionName -- bash -lc $checkCommand
  if ($LASTEXITCODE -ne 0) { throw "Installed runtime file is missing, non-regular or a symlink: $LinuxPath" }
  $hashOutput = & wsl.exe -d $DistributionName -- sha256sum -- $LinuxPath
  if ($LASTEXITCODE -ne 0 -or -not $hashOutput) { throw "Could not hash installed runtime file: $LinuxPath" }
  $fields = (([string]@($hashOutput)[-1]).Trim() -split '\s+')
  $digest = ([string]$fields[0]).ToLowerInvariant()
  if ($digest -notmatch '^[a-f0-9]{64}$') { throw "Installed runtime returned a malformed SHA256: $LinuxPath" }
  return $digest
}

function Assert-InstalledRuntime([string]$DistributionName, [object]$Manifest, [string]$WindowsReceiptPath) {
  $expectedReceiptSha = (Get-FileHash -LiteralPath $WindowsReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $actualReceiptSha = Get-WslFileSha256 $DistributionName "/home/max/src/unseen-local-product/release-evidence.json"
  if ($actualReceiptSha -cne $expectedReceiptSha) { throw "Installed release evidence SHA256 mismatch." }

  $installedFiles = [ordered]@{
    "/home/max/src/unseen-local-product/app/doctor-local-product.sh" = "inputs/scripts/linux/doctor-local-product.sh"
    "/home/max/src/unseen-local-product/app/start-local-product.sh" = "inputs/scripts/linux/start-local-product.sh"
    "/home/max/src/unseen-local-product/app/stop-local-product.sh" = "inputs/scripts/linux/stop-local-product.sh"
    "/home/max/src/unseen-local-product/app/bootstrap-dependencies.sh" = "inputs/scripts/linux/bootstrap-dependencies.sh"
    "/home/max/src/unseen-local-product/app/unseen_local_product.py" = "inputs/product/unseen_local_product.py"
    "/home/max/src/unseen-local-product/app/pipeline_runner.py" = "inputs/product/pipeline_runner.py"
  }
  foreach ($installedPath in $installedFiles.Keys) {
    $expected = Get-ManifestFileSha256 $Manifest $installedFiles[$installedPath]
    $actual = Get-WslFileSha256 $DistributionName $installedPath
    if ($actual -cne $expected) { throw "Installed runtime fingerprint mismatch: $installedPath" }
  }
  Write-Host "PASS installed ext4 runtime receipt and executable fingerprints match the verified Release payload."
}

function Get-OwnedRuntimeProcesses([string]$DistributionName) {
  $probe = 'app=/home/max/src/unseen-local-product/app/unseen_local_product.py; runner=/home/max/src/unseen-local-product/app/pipeline_runner.py; for f in /proc/[0-9]*/cmdline; do [ -r "$f" ] || continue; p=${f#/proc/}; p=${p%/cmdline}; [ "$p" = "$$" ] && continue; c=$(tr "\000" " " < "$f"); case "$c" in *"$app"*" _supervise-runner "*) role=supervisor ;; *"$app"*" server "*) role=server ;; *"$app"*" worker "*) role=worker ;; *"$runner"*" --job-spec "*) role=runner ;; *) continue ;; esac; s=$(cat "/proc/$p/stat") || exit 1; rest=${s##*) }; set -- $rest; [ "$#" -ge 3 ] || exit 1; printf "%s|%s|%s|%s\n" "$p" "$role" "$2" "$3"; done'
  $probeOutput = & wsl.exe -d $DistributionName -- bash -lc $probe
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect /proc for owned UNSEEN server/worker processes." }
  $facts = @()
  foreach ($line in @($probeOutput | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })) {
    $text = ([string]$line).Trim()
    if ($text -notmatch '^(?<pid>[0-9]+)\|(?<role>server|worker|supervisor|runner)\|(?<ppid>[0-9]+)\|(?<pgid>[0-9]+)$') {
      throw "Malformed owned-process probe output: $text"
    }
    $facts += [pscustomobject]@{
      Pid = [int]$Matches.pid
      Role = [string]$Matches.role
      ParentPid = [int]$Matches.ppid
      ProcessGroupId = [int]$Matches.pgid
    }
  }
  return @($facts)
}

function Assert-NoOrphanedRuntime([string]$DistributionName) {
  $facts = @(Get-OwnedRuntimeProcesses $DistributionName)
  foreach ($role in @("server", "worker", "supervisor", "runner")) {
    $roleFacts = @($facts | Where-Object { $_.Role -ceq $role })
    if ($roleFacts.Count -gt 1) { throw "Multiple owned $role processes exist; refusing to start or replace code." }
    if ($role -in @("server", "worker") -and $roleFacts.Count -eq 1) {
      $pidPath = "/home/max/unseen-local-product/reports/$role.pid"
      $pidOutput = & wsl.exe -d $DistributionName -- cat -- $pidPath
      if ($LASTEXITCODE -ne 0 -or -not $pidOutput) {
        throw "Owned $role PID $($roleFacts[0].Pid) has no matching PID file; refusing an orphaned runtime."
      }
      $recordedPid = ([string]@($pidOutput)[-1]).Trim()
      if ($recordedPid -notmatch '^[0-9]+$' -or [int]$recordedPid -ne $roleFacts[0].Pid) {
        throw "Owned $role process does not match its PID file; refusing an ambiguous runtime."
      }
    }
  }

  $workers = @($facts | Where-Object { $_.Role -ceq "worker" })
  $supervisors = @($facts | Where-Object { $_.Role -ceq "supervisor" })
  $runners = @($facts | Where-Object { $_.Role -ceq "runner" })
  if ($supervisors.Count -gt 0 -or $runners.Count -gt 0) {
    if ($workers.Count -ne 1 -or $supervisors.Count -ne 1) {
      throw "An owned runner/supervisor exists without one unambiguous worker parent; refusing an orphaned GPU process tree."
    }
    $workerPid = [int]$workers[0].Pid
    $supervisorPid = [int]$supervisors[0].Pid
    if ([int]$supervisors[0].ParentPid -ne $workerPid -or [int]$supervisors[0].ProcessGroupId -ne $supervisorPid) {
      throw "The runner supervisor is not the worker's dedicated process-group child; refusing an ambiguous GPU process tree."
    }
    foreach ($runnerFact in $runners) {
      if ([int]$runnerFact.ParentPid -ne $supervisorPid -or [int]$runnerFact.ProcessGroupId -ne $supervisorPid) {
        throw "The pipeline runner is not owned by the verified supervisor process group; refusing an orphaned GPU process."
      }
    }
  }
  return @($facts)
}

$startupMutex = New-Object System.Threading.Mutex($false, "Global\UNSEEN-v15-local-product-start")
$startupLockTaken = $false
try {
try {
  $startupLockTaken = $startupMutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $startupLockTaken = $true
}
if (-not $startupLockTaken) { throw "Another Windows UNSEEN start/install/doctor invocation is already active." }

$job = "unseen-3dgs-local-product-2026-09-04-v15"
if ($BootstrapDependencies -and -not $Install) {
  throw "-BootstrapDependencies requires -Install. No apt, network, or file change was attempted."
}
if ($DoctorOnly -and ($Install -or $BootstrapDependencies -or $OpenBrowser)) {
  throw "-DoctorOnly cannot be combined with -Install, -BootstrapDependencies or -OpenBrowser. Nothing was changed."
}
if (-not $PayloadRoot) {
  $scriptJobRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
  $selfContainedPayload = (
    (Test-Path -LiteralPath (Join-Path $scriptJobRoot "START-HERE.md") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $scriptJobRoot "inputs") -PathType Container)
  )
  if ($selfContainedPayload) {
    $PayloadRoot = $scriptJobRoot
  } else {
    $PayloadRoot = Join-Path $BridgeCheckout "jobs\to-4060\$job"
  }
}
$PayloadRoot = (Resolve-Path -LiteralPath $PayloadRoot).Path
$BridgeCheckout = (Resolve-Path -LiteralPath $BridgeCheckout).Path
$receiptPath = Join-Path $PayloadRoot ".bridge-receipt.json"
$taskPath = Join-Path $BridgeCheckout "jobs\to-4060\$job\TASK.json"
if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) {
  throw "Current Bridge TASK.json is missing: $taskPath"
}
try { $task = Get-Content -Raw -LiteralPath $taskPath -Encoding UTF8 | ConvertFrom-Json }
catch { throw "Current Bridge TASK.json is invalid: $($_.Exception.Message)" }
if ($task.jobId -cne $job -or $task.state -cne "PUBLISHED") { throw "Current Bridge task identity/state failed." }
$verifiedReceipt = Read-VerifiedBridgeReceipt $receiptPath $job $task
$payloadVerification = Assert-CompletePayload $PayloadRoot $task $verifiedReceipt
$linux = Join-Path $PayloadRoot "inputs\scripts\linux"
if (-not (Test-Path -LiteralPath $linux)) { throw "Verified payload is incomplete; missing $linux" }
Assert-WslHostStorage $Distro
Assert-ReadOnlyHostFacts $Distro
if ($DoctorOnly) {
  $activeScheme = & powercfg.exe /getactivescheme
  if ($LASTEXITCODE -ne 0) { throw "Could not read the active Windows power scheme. Nothing was changed." }
  $sleepPolicy = & powercfg.exe /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
  if ($LASTEXITCODE -ne 0) { throw "Could not read the Windows sleep policy. Nothing was changed." }
  Write-Host "READ_ONLY_EVIDENCE active Windows power scheme: $($activeScheme -join ' ')"
  Write-Host "READ_ONLY_EVIDENCE AC/DC sleep policy was read successfully; preserve the command output with the doctor log."
  $sleepPolicy | Write-Host
  Write-Host "PENDING_MANUAL: confirm plugged-in power, NVIDIA-only/MUX mode, and that Windows plus WSL will not sleep during the canary."
}
if ($Install) {
  # Preserve Windows separators across the WSL interop argv boundary. This is
  # needed only while executing the already manifest-verified installer/stopper.
  $escapedLinux = $linux.Replace('\', '\\')
  $wslLinuxOutput = & wsl.exe -d $Distro -- wslpath -u -a $escapedLinux
  if ($LASTEXITCODE -ne 0) { throw "Could not translate Bridge path into WSL distro '$Distro'." }
  $wslLinuxCandidates = @($wslLinuxOutput | Where-Object { $_ })
  if ($wslLinuxCandidates.Count -lt 1) { throw "WSL path translation returned no path for $linux." }
  $wslLinux = ([string]$wslLinuxCandidates[-1]).Trim()
  if (-not $wslLinux) { throw "WSL path translation returned an empty path for $linux." }

  $runtimeBeforeInstall = @(Assert-NoOrphanedRuntime $Distro)
  $oldRuntimePresent = & wsl.exe -d $Distro -- bash -lc 'test -f /home/max/unseen-local-product/reports/server.pid -o -f /home/max/unseen-local-product/reports/worker.pid'
  $oldRuntimeStatus = $LASTEXITCODE
  if ($oldRuntimeStatus -eq 0 -or $runtimeBeforeInstall.Count -gt 0) {
    & wsl.exe -d $Distro -- bash "$wslLinux/stop-local-product.sh" /home/max/unseen-local-product
    if ($LASTEXITCODE -ne 0) { throw "Existing product processes could not be stopped safely. No new version was installed." }
    $remainingOwnedProcesses = @(Get-OwnedRuntimeProcesses $Distro)
    if ($remainingOwnedProcesses.Count -ne 0) { throw "Owned UNSEEN processes remain after the verified stop boundary. No new version was installed." }
    Write-Host "PASS stopped the owned old server/worker before replacing code; queue/media/checkpoints were preserved."
  } elseif ($oldRuntimeStatus -ne 1) {
    throw "Could not determine whether an old product runtime is active. No new version was installed."
  }
  & wsl.exe -d $Distro -- bash "$wslLinux/install-local-product.sh" --confirm-install
  if ($LASTEXITCODE -ne 0) { throw "WSL userland install failed." }
  $escapedReceipt = $receiptPath.Replace('\', '\\')
  $wslReceiptOutput = & wsl.exe -d $Distro -- wslpath -u -a $escapedReceipt
  if ($LASTEXITCODE -ne 0 -or -not $wslReceiptOutput) { throw "Could not translate the verified Bridge receipt path." }
  $wslReceipt = ([string]@($wslReceiptOutput)[-1]).Trim()
  & wsl.exe -d $Distro -- install -m 0600 -- $wslReceipt /home/max/src/unseen-local-product/release-evidence.json
  if ($LASTEXITCODE -ne 0) { throw "Could not install the verified release receipt." }
}
Assert-InstalledRuntime $Distro $payloadVerification.Manifest $receiptPath
if ($BootstrapDependencies) {
  & wsl.exe -d $Distro -- bash /home/max/src/unseen-local-product/app/bootstrap-dependencies.sh --confirm-system-packages --install-root /home/max/src/unseen-local-product
  if ($LASTEXITCODE -ne 0) { throw "Explicit WSL dependency bootstrap failed; inspect its last concrete error." }
}
& wsl.exe -d $Distro -- bash /home/max/src/unseen-local-product/app/doctor-local-product.sh --product-root /home/max/src/unseen-local-product
if ($LASTEXITCODE -ne 0) { throw "Read the doctor failures. This script did not change drivers, CUDA, firewall, sleep or MUX settings." }
if ($DoctorOnly) {
  Write-Host "DOCTOR_ONLY_PASS: read-only checks completed; server, worker and browser were not started. Manual power/MUX/sleep items remain PENDING until the 4060 Agent confirms them."
  return
}
$null = Assert-NoOrphanedRuntime $Distro
$output = & wsl.exe -d $Distro -- bash /home/max/src/unseen-local-product/app/start-local-product.sh
if ($LASTEXITCODE -ne 0) { throw "Local product startup failed." }
$output | Write-Host
$url = ($output | Where-Object { $_ -match '^http://127\.0\.0\.1:[0-9]+/$' } | Select-Object -First 1)
if (-not $url) { throw "WSL startup returned no exact loopback URL." }
try {
  $hostHealth = Invoke-WebRequest -UseBasicParsing -Uri ($url + "api/health") -TimeoutSec 10
} catch {
  throw "Windows host could not reach the WSL loopback product URL: $($_.Exception.Message)"
}
if ([int]$hostHealth.StatusCode -ne 200) { throw "Windows-to-WSL loopback health returned HTTP $($hostHealth.StatusCode)." }
Write-Host "PASS Windows browser path can reach $($url)api/health over loopback."
if ($OpenBrowser -and $url) { Start-Process $url }
Write-Host "No firewall rule, public/LAN listener, production connection, scheduled task or token was created."
} finally {
  if ($startupLockTaken) { $startupMutex.ReleaseMutex() }
  $startupMutex.Dispose()
}
