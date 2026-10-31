[CmdletBinding()]
param(
    [switch]$ConfirmResearchCanary,
    [switch]$RunPreview,
    [switch]$ConfirmGpuPreview,
    [string]$WslDistro = "Ubuntu-22.04",
    [ValidatePattern('^/home/[^/]+/.+$')]
    [string]$ProjectRoot = "/home/max/src/unseen-3dgs-sceneworker"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $ConfirmResearchCanary) {
    throw "Read the v11 pose-fix contract, then rerun with -ConfirmResearchCanary."
}
if ($RunPreview -and -not $ConfirmGpuPreview) {
    throw "-RunPreview requires the separate -ConfirmGpuPreview switch."
}
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL is required. This script does not install or modify WSL."
}

$linuxDir = Join-Path (Split-Path -Parent $PSScriptRoot) "linux"
$prepareScript = Join-Path $linuxDir "Prepare-V11-360Roam.sh"
$previewScript = Join-Path $linuxDir "Run-V11-Preview.sh"
foreach ($script in @($prepareScript, $previewScript)) {
    if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
        throw "Missing frozen v11 Linux script: $script"
    }
}

$escapedPrepareScript = $prepareScript.Replace('\', '\\')
$wslPrepare = (& wsl.exe -d $WslDistro -- wslpath -u -a $escapedPrepareScript).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslPrepare) {
    throw "Could not translate the frozen v11 preparation script into WSL."
}
& wsl.exe -d $WslDistro -- bash $wslPrepare --confirm-research-canary --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) {
    throw "v11 pose/image gate failed. Do not start GPU; preserve v10 cache and report BLOCKED."
}

if ($RunPreview) {
    $escapedPreviewScript = $previewScript.Replace('\', '\\')
    $wslPreview = (& wsl.exe -d $WslDistro -- wslpath -u -a $escapedPreviewScript).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $wslPreview) {
        throw "Could not translate the frozen v11 preview script into WSL."
    }
    & wsl.exe -d $WslDistro -- bash $wslPreview --confirm-gpu-preview --project-root $ProjectRoot
    if ($LASTEXITCODE -ne 0) {
        throw "v11 7k preview failed. Do not retry without a new authorization record."
    }
}

Write-Host "v11 complete for the explicitly selected phase. Nothing was uploaded and no port/firewall setting was changed."
