[CmdletBinding()]
param(
    [string]$BridgeRoot = (Join-Path $HOME "AgentBridge"),
    [string]$JobId = "unseen-3dgs-local-product-2026-09-04-v15",
    [string]$Distro = "Ubuntu-22.04",
    [switch]$Install,
    [switch]$BootstrapDependencies,
    [switch]$DoctorOnly,
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$expectedJob = "unseen-3dgs-local-product-2026-09-04-v15"
$expectedType = "UNSEEN.Bridge.ReceiveResult"

if ($JobId -cne $expectedJob) {
    throw "This launcher is pinned to $expectedJob; no other job may be selected."
}
if ($Distro -cne "Ubuntu-22.04") {
    throw "R3 is pinned to the known WSL distro Ubuntu-22.04. Nothing was received or started."
}
if ($BootstrapDependencies -and -not $Install) {
    throw "-BootstrapDependencies requires -Install. Nothing was received or changed."
}
if ($DoctorOnly -and ($Install -or $BootstrapDependencies -or $OpenBrowser)) {
    throw "-DoctorOnly cannot be combined with install, bootstrap or browser startup."
}

$trimSeparators = [char[]]@('\', '/')
$controlDir = [IO.Path]::GetFullPath((Join-Path $BridgeRoot "control")).TrimEnd($trimSeparators)
$launcherControl = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..")).TrimEnd($trimSeparators)
if (-not $controlDir.Equals($launcherControl, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Run this launcher from the exact BridgeRoot control checkout. expected=$controlDir actual=$launcherControl"
}

$receiveScript = Join-Path $controlDir "scripts\windows\Receive-BridgeJob.ps1"
if (-not (Test-Path -LiteralPath $receiveScript -PathType Leaf)) {
    throw "The exact receiver is missing from the control checkout: $receiveScript"
}

# Capture all ordinary command output, but select only the deliberately typed
# terminal result. A failed receive throws; there is no directory scan or old-run fallback.
$receiveOutput = @(& $receiveScript -BridgeRoot $BridgeRoot -JobId $JobId)
$receiveResults = @(
    $receiveOutput | Where-Object {
        $_ -and ($_.PSObject.TypeNames -ccontains $expectedType)
    }
)
if ($receiveResults.Count -ne 1) {
    throw "Receiver did not return exactly one typed result; refusing to scan or reuse any prior payload."
}
$received = $receiveResults[0]
if ([string]$received.JobId -cne $JobId -or [string]$received.State -cne "RECEIVED_VERIFIED") {
    throw "Typed receiver result has the wrong job or state."
}
if ([string]$received.ReleaseTag -cne "$JobId-r3" -or [string]$received.AssetSha256 -notmatch '^[a-f0-9]{64}$' -or
    [int64]$received.AssetBytes -lt 1 -or [string]$received.ControlCommit -notmatch '^[a-f0-9]{40}$' -or
    [string]$received.PayloadManifestSha256 -notmatch '^[a-f0-9]{64}$' -or [int]$received.PayloadFileCount -lt 1) {
    throw "Typed receiver result is not bound to the expected immutable R3 release."
}

$runParent = [IO.Path]::GetFullPath((Join-Path $BridgeRoot "jobs\$JobId")).TrimEnd($trimSeparators)
$runRoot = [IO.Path]::GetFullPath([string]$received.RunRoot).TrimEnd($trimSeparators)
$payloadRoot = [IO.Path]::GetFullPath([string]$received.PayloadRoot).TrimEnd($trimSeparators)
$entryPath = [IO.Path]::GetFullPath([string]$received.EntryPath).TrimEnd($trimSeparators)
$runPrefix = $runParent + [IO.Path]::DirectorySeparatorChar
if (-not $runRoot.StartsWith($runPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Receiver runRoot escaped the exact job directory."
}
$expectedPayloadRoot = [IO.Path]::GetFullPath((Join-Path $runRoot "unpacked")).TrimEnd($trimSeparators)
if (-not $payloadRoot.Equals($expectedPayloadRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Receiver payloadRoot is not the unpacked directory of this exact run."
}
$expectedEntryPath = [IO.Path]::GetFullPath((Join-Path $payloadRoot "START-HERE.md")).TrimEnd($trimSeparators)
if (-not $entryPath.Equals($expectedEntryPath, [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw "Receiver entryPath is not this exact payload's START-HERE.md."
}

$receiptPath = Join-Path $payloadRoot ".bridge-receipt.json"
if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
    throw "The exact received payload lacks .bridge-receipt.json."
}
try {
    $receipt = Get-Content -Raw -LiteralPath $receiptPath -Encoding UTF8 | ConvertFrom-Json
} catch {
    throw "The exact received payload has an invalid .bridge-receipt.json: $($_.Exception.Message)"
}
if ([string]$receipt.jobId -cne $JobId -or [string]$receipt.releaseTag -cne [string]$received.ReleaseTag -or
    [string]$receipt.assetSha256 -cne [string]$received.AssetSha256 -or
    [string]$receipt.controlCommit -cne [string]$received.ControlCommit) {
    throw "Typed receiver result disagrees with the exact payload receipt."
}

$startScript = Join-Path $payloadRoot "inputs\scripts\windows\Start-UNSEEN-LocalProduct.ps1"
if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) {
    throw "Verified payload lacks its Windows product starter."
}
$startParameters = @{
    Distro = $Distro
    BridgeCheckout = $controlDir
    PayloadRoot = $payloadRoot
}
if ($Install) { $startParameters["Install"] = $true }
if ($BootstrapDependencies) { $startParameters["BootstrapDependencies"] = $true }
if ($DoctorOnly) { $startParameters["DoctorOnly"] = $true }
if ($OpenBrowser) { $startParameters["OpenBrowser"] = $true }
& $startScript @startParameters

# Preserve the exact successful receive binding for the caller. This is the
# only object of this type emitted by the launcher.
Write-Output $received
