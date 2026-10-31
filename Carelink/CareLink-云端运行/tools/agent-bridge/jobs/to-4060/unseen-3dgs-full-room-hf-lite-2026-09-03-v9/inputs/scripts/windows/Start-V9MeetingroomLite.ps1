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
    throw "Read the v9 source/license boundary, then rerun with -ConfirmResearchCanary."
}
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL is required. This script does not install or modify WSL."
}

$linuxDir = Join-Path (Split-Path -Parent $PSScriptRoot) "linux"
$shellScript = Join-Path $linuxDir "Prepare-V9MeetingroomLite.sh"
if (-not (Test-Path -LiteralPath $shellScript -PathType Leaf)) {
    throw "Missing v9 Linux preparation script: $shellScript"
}

$wslScript = (& wsl.exe -d $WslDistro -- wslpath -u -a $shellScript).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslScript) {
    throw "Could not translate the frozen v9 script path into WSL."
}

& wsl.exe -d $WslDistro -- bash $wslScript --confirm-research-canary --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) {
    throw "v9 lightweight Meetingroom preparation failed; preserve any .part file for resume."
}

Write-Host "v9 source preparation passed. Media and work remain in WSL ext4; no GPU job was started."
