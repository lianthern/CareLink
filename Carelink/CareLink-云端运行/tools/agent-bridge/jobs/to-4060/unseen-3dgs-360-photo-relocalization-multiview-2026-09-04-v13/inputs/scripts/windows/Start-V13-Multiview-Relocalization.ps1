[CmdletBinding()]
param(
    [switch]$ConfirmResearchCanary,
    [string]$WslDistro = "Ubuntu-22.04",
    [ValidatePattern('^/home/[^/]+/.+$')]
    [string]$ProjectRoot = "/home/max/src/unseen-3dgs-sceneworker"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $ConfirmResearchCanary) {
    throw "Read the complete v13 contract, then rerun with -ConfirmResearchCanary."
}
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL is required. This script does not install or modify WSL."
}

$linuxDir = Join-Path (Split-Path -Parent $PSScriptRoot) "linux"
$runScript = Join-Path $linuxDir "Run-V13-Multiview-Relocalization.sh"
if (-not (Test-Path -LiteralPath $runScript -PathType Leaf)) {
    throw "Missing frozen v13 Linux launcher: $runScript"
}
$escapedRunScript = $runScript.Replace('\', '\\')
$wslRunScript = (& wsl.exe -d $WslDistro -- wslpath -u -a $escapedRunScript).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslRunScript) {
    throw "Could not translate the frozen v13 launcher into WSL."
}

& wsl.exe -d $WslDistro -- bash $wslRunScript --confirm-research-canary --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) {
    throw "v13 did not pass the unchanged 3/3 gate. Do not replace query 2, lower thresholds, retune, rerun, or start Viewer/GPU work; preserve the report and submit BLOCKED."
}

Write-Host "v13 3/3 gate passed. Complete the separate Viewer Phase B from README.md before claiming user-visible acceptance."
