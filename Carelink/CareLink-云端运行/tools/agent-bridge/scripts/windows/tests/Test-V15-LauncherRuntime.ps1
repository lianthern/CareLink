[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$job = "unseen-3dgs-local-product-2026-09-04-v15"
$resultType = "UNSEEN.Bridge.ReceiveResult"
$sourceLauncher = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\Start-V15-LocalProduct.ps1"))
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("unseen-v15-launcher-runtime-" + [guid]::NewGuid().ToString("N"))
$control = Join-Path $testRoot "control"
$windowsScripts = Join-Path $control "scripts\windows"
$receiver = Join-Path $windowsScripts "Receive-BridgeJob.ps1"
$launcher = Join-Path $windowsScripts "Start-V15-LocalProduct.ps1"
$runRoot = Join-Path $testRoot "jobs\$job\run-success"
$payloadRoot = Join-Path $runRoot "unpacked"
$payloadWindows = Join-Path $payloadRoot "inputs\scripts\windows"
$entryPath = Join-Path $payloadRoot "START-HERE.md"
$receiptPath = Join-Path $payloadRoot ".bridge-receipt.json"
$startScript = Join-Path $payloadWindows "Start-UNSEEN-LocalProduct.ps1"
$marker = Join-Path $testRoot "starter-calls.txt"
$assetSha = "a" * 64
$commit = "b" * 40
$manifestSha = "c" * 64
$previousMarker = [Environment]::GetEnvironmentVariable("UNSEEN_V15_LAUNCHER_TEST_MARKER", "Process")

function Write-Utf8NoBom([string]$Path, [string]$Text) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, (($Text -replace "`r`n", "`n") -replace "`r", "`n"), $encoding)
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Write-FakeReceiver([ValidateSet("success", "throw", "zero", "two")][string]$Mode) {
    $body = switch ($Mode) {
        "success" {
@'
[CmdletBinding()]
param([string]$BridgeRoot, [string]$JobId)
Write-Output "ordinary receiver progress"
$runRoot = Join-Path $BridgeRoot "jobs\$JobId\run-success"
$payloadRoot = Join-Path $runRoot "unpacked"
$result = [pscustomobject][ordered]@{
    JobId = $JobId
    State = "RECEIVED_VERIFIED"
    RunRoot = $runRoot
    PayloadRoot = $payloadRoot
    EntryPath = (Join-Path $payloadRoot "START-HERE.md")
    ReleaseTag = "$JobId-r3"
    AssetSha256 = ("a" * 64)
    AssetBytes = [int64]123
    ControlCommit = ("b" * 40)
    PayloadManifestSha256 = ("c" * 64)
    PayloadFileCount = 49
}
$result.PSObject.TypeNames.Insert(0, "UNSEEN.Bridge.ReceiveResult")
Write-Output $result
'@
        }
        "throw" {
@'
[CmdletBinding()]
param([string]$BridgeRoot, [string]$JobId)
throw "intentional receiver failure"
'@
        }
        "zero" {
@'
[CmdletBinding()]
param([string]$BridgeRoot, [string]$JobId)
Write-Output "no typed result"
'@
        }
        "two" {
@'
[CmdletBinding()]
param([string]$BridgeRoot, [string]$JobId)
foreach ($index in 1..2) {
    $result = [pscustomobject]@{ JobId = $JobId; State = "RECEIVED_VERIFIED"; Index = $index }
    $result.PSObject.TypeNames.Insert(0, "UNSEEN.Bridge.ReceiveResult")
    Write-Output $result
}
'@
        }
    }
    Write-Utf8NoBom $receiver $body
}

function Assert-FailedWithoutStarter([string]$Mode) {
    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
    Write-FakeReceiver $Mode
    $failed = $false
    try {
        & $launcher -BridgeRoot $testRoot -JobId $job -Distro "Ubuntu-22.04" -Install | Out-Null
    } catch {
        $failed = $true
    }
    Assert-True $failed "Launcher mode '$Mode' unexpectedly succeeded."
    Assert-True (-not (Test-Path -LiteralPath $marker)) "Launcher mode '$Mode' called the starter after receive failure."
}

try {
    New-Item -ItemType Directory -Path $windowsScripts, $payloadWindows -Force | Out-Null
    Copy-Item -LiteralPath $sourceLauncher -Destination $launcher
    Write-Utf8NoBom $entryPath "# test entry`n"
    $receipt = [ordered]@{
        schemaVersion = "1.0"
        jobId = $job
        releaseTag = "$job-r3"
        assetName = "test.zip"
        assetSha256 = $assetSha
        assetBytes = [int64]123
        controlCommit = $commit
        payloadManifestSha256 = $manifestSha
        payloadFileCount = 49
        verifiedAt = "2026-09-04T00:00:00.0000000Z"
        verifiedBy = "runtime-harness"
    }
    Write-Utf8NoBom $receiptPath (($receipt | ConvertTo-Json -Depth 5) + "`n")
    Write-Utf8NoBom $startScript @'
[CmdletBinding()]
param(
    [string]$Distro,
    [string]$BridgeCheckout,
    [string]$PayloadRoot,
    [switch]$Install,
    [switch]$BootstrapDependencies,
    [switch]$DoctorOnly,
    [switch]$OpenBrowser
)
if ($Distro -cne "Ubuntu-22.04" -or -not $Install -or $DoctorOnly) {
    throw "starter received incorrect parameters"
}
[IO.File]::AppendAllText($env:UNSEEN_V15_LAUNCHER_TEST_MARKER, "START`n")
'@
    [Environment]::SetEnvironmentVariable("UNSEEN_V15_LAUNCHER_TEST_MARKER", $marker, "Process")

    Write-FakeReceiver "success"
    $output = @(& $launcher -BridgeRoot $testRoot -JobId $job -Distro "Ubuntu-22.04" -Install)
    $typed = @($output | Where-Object { $_ -and ($_.PSObject.TypeNames -ccontains $resultType) })
    Assert-True ($typed.Count -eq 1) "Success case did not preserve exactly one typed receive result."
    $calls = @(Get-Content -LiteralPath $marker | Where-Object { $_ -eq "START" })
    Assert-True ($calls.Count -eq 1) "Success case did not call the exact starter once."

    Assert-FailedWithoutStarter "throw"
    Assert-FailedWithoutStarter "zero"
    Assert-FailedWithoutStarter "two"
    Write-Host "V15_LAUNCHER_RUNTIME_PASS success=1 receiver_throw=blocked zero_result=blocked two_results=blocked"
} finally {
    [Environment]::SetEnvironmentVariable("UNSEEN_V15_LAUNCHER_TEST_MARKER", $previousMarker, "Process")
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
