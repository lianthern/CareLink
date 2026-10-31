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
    throw "Read the complete v12 contract, then rerun with -ConfirmResearchCanary."
}
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL is required. This script does not install or modify WSL."
}

$linuxDir = Join-Path (Split-Path -Parent $PSScriptRoot) "linux"
$runScript = Join-Path $linuxDir "Run-V12-Relocalization.sh"
if (-not (Test-Path -LiteralPath $runScript -PathType Leaf)) {
    throw "Missing frozen v12 Linux launcher: $runScript"
}
$escapedRunScript = $runScript.Replace('\', '\\')
$wslRunScript = (& wsl.exe -d $WslDistro -- wslpath -u -a $escapedRunScript).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslRunScript) {
    throw "Could not translate the frozen v12 launcher into WSL."
}

& wsl.exe -d $WslDistro -- bash $wslRunScript --confirm-research-canary --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) {
    throw "v12 photo relocalization did not pass 3/3. Do not tune thresholds or start GPU training; preserve the report and submit BLOCKED."
}

Write-Host "v12 3/3 photo relocalization gate passed. No GPU job, upload, port, firewall or production setting was changed."
