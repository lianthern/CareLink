[CmdletBinding(SupportsShouldProcess=$true, ConfirmImpact='High')]
param(
  [Parameter(Mandatory=$true)][switch]$ConfirmInstall,
  [switch]$ReplaceExisting,
  [string]$Distro = "Ubuntu-22.04",
  [string]$PayloadRoot = ""
)
$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if (-not $ConfirmInstall) { throw "Pass -ConfirmInstall after preview succeeds and Max approves login startup." }
if ($Distro -notmatch '^[A-Za-z0-9][A-Za-z0-9._ -]{0,79}$') { throw "Distro contains unsafe Task Scheduler argument characters." }
if (-not $PayloadRoot) {
  $PayloadRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..\..")).Path
}
$PayloadRoot = (Resolve-Path -LiteralPath $PayloadRoot).Path
$script = Join-Path $PayloadRoot "inputs\scripts\windows\Start-UNSEEN-LocalProduct.ps1"
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "Missing startup script: $script" }
$scriptItem = Get-Item -LiteralPath $script -Force
if (($scriptItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Startup script must not be a reparse point." }

$taskName = "UNSEEN Local Product"
$taskPath = "\"
$description = "Loopback-only UNSEEN UI and one local GPU worker"
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ([string]::IsNullOrWhiteSpace($currentUser)) { throw "Could not identify the current Windows user for the login trigger." }
$arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -Distro `"$Distro`" -PayloadRoot `"$PayloadRoot`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet -Disable -StartWhenAvailable -AllowStartIfOnBatteries:$false -DontStopIfGoingOnBatteries:$false
$existing = @(Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue)
if ($existing.Count -gt 1) { throw "Task Scheduler returned multiple tasks for the exact root task name; refusing replacement." }
$hadExisting = $existing.Count -eq 1
if ($hadExisting -and -not $ReplaceExisting) {
  throw "A task named '$taskName' already exists. It was not changed. Inspect it, then rerun with -ReplaceExisting only if Max explicitly approves replacement."
}
$previousXml = $null
if ($hadExisting) {
  $previousXml = ((Export-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop) | Out-String)
  if ([string]::IsNullOrWhiteSpace($previousXml)) { throw "Existing task could not be exported for rollback; it was not changed." }
}

$operation = if ($hadExisting) { "replace the existing task with an exactly verified DISABLED login task" } else { "register an exactly verified DISABLED login task" }
if ($PSCmdlet.ShouldProcess($taskName, $operation)) {
  try {
    Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description $description -Force | Out-Null
    $installedRows = @(Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop)
    if ($installedRows.Count -ne 1) { throw "Task Scheduler did not return exactly one installed task." }
    $installed = $installedRows[0]
    $installedActions = @($installed.Actions)
    $installedTriggers = @($installed.Triggers)
    if ([string]$installed.State -cne "Disabled" -or -not ($installed.Settings.Enabled -is [bool]) -or $installed.Settings.Enabled -ne $false) {
      throw "Task Scheduler did not create the task atomically disabled."
    }
    if ($installedActions.Count -ne 1 -or
        [string]$installedActions[0].Execute -ine "powershell.exe" -or
        [string]$installedActions[0].Arguments -cne $arguments) {
      throw "Installed task action/arguments do not exactly match the requested safe launcher."
    }
    if ($installedTriggers.Count -ne 1 -or
        [string]$installedTriggers[0].CimClass.CimClassName -cne "MSFT_TaskLogonTrigger" -or
        [string]$installedTriggers[0].UserId -ine $currentUser -or
        -not ($installedTriggers[0].Enabled -is [bool]) -or $installedTriggers[0].Enabled -ne $true) {
      throw "Installed task trigger is not the exact enabled current-user logon trigger under a disabled task."
    }
    if ([string]$installed.Description -cne $description) { throw "Installed task description does not match the expected product identity." }
  } catch {
    $installFailure = $_.Exception.Message
    $rollbackFailures = @()
    try {
      $current = @(Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue)
      if ($current.Count -eq 1) { Disable-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop | Out-Null }
    } catch {
      $rollbackFailures += "could not disable partial replacement: $($_.Exception.Message)"
    }
    if ($hadExisting) {
      try {
        Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Xml $previousXml -Force -ErrorAction Stop | Out-Null
        $restoredXml = ((Export-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop) | Out-String)
        $previousDocument = New-Object System.Xml.XmlDocument
        $restoredDocument = New-Object System.Xml.XmlDocument
        $previousDocument.PreserveWhitespace = $false
        $restoredDocument.PreserveWhitespace = $false
        $previousDocument.LoadXml($previousXml)
        $restoredDocument.LoadXml($restoredXml)
        if ($previousDocument.OuterXml -cne $restoredDocument.OuterXml) {
          throw "Task Scheduler did not restore the exact exported original XML."
        }
      } catch {
        $rollbackFailures += "could not restore exported original task: $($_.Exception.Message)"
      }
    } else {
      try {
        $partial = @(Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue)
        if ($partial.Count -eq 1) { Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction Stop }
        if (@(Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue).Count -ne 0) {
          throw "Task Scheduler still exposes the partial new task after unregister."
        }
      } catch {
        $rollbackFailures += "could not remove partial new task: $($_.Exception.Message)"
      }
    }
    if ($rollbackFailures.Count -gt 0) {
      try { Disable-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop | Out-Null }
      catch { $rollbackFailures += "final fail-safe disable failed: $($_.Exception.Message)" }
      throw "Task installation failed: $installFailure. Rollback was incomplete; $($rollbackFailures -join '; '). The partial task was disabled when possible."
    }
    throw "Task installation failed and the previous state was restored: $installFailure"
  }
  Write-Host "Installed and exactly verified DISABLED. Enable only after a successful real preview: Enable-ScheduledTask -TaskPath '\' -TaskName '$taskName'"
}
