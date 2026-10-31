[CmdletBinding()]
param(
    [string]$Distro = "Ubuntu-22.04",
    [string]$ProjectPath = "/home/max/src/unseen-3dgs-sceneworker"
)

$ErrorActionPreference = "Stop"
if ($ProjectPath -notmatch '^/[A-Za-z0-9._/-]+$' -or $ProjectPath -match '^/mnt/') {
    throw "ProjectPath must be a WSL ext4 path."
}
if ($Distro -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Distro contains unsupported characters."
}

$StatePath = "$ProjectPath/reports/local-intake/server-state.json"
$StateWindowsPath = "\\wsl.localhost\$Distro" + ($StatePath -replace '/', '\')
if (-not (Test-Path -LiteralPath $StateWindowsPath -PathType Leaf)) {
    Write-Output "No local video intake state file was found; nothing was stopped."
    exit 0
}

$state = Get-Content -LiteralPath $StateWindowsPath -Raw | ConvertFrom-Json
if ($state.bindAddress -ne "127.0.0.1" -or $state.pid -notmatch '^\d+$') {
    throw "Refusing an invalid local intake state file."
}
$commandLine = & wsl.exe -d $Distro -- bash -lc "ps -p '$($state.pid)' -o args= 2>/dev/null" 2>&1
$cleanCommandLine = (@($commandLine | ForEach-Object { ([string]$_).Replace(([char]0).ToString(), '') }) -join " ").Trim()
if ($LASTEXITCODE -eq 0) {
    if (-not $cleanCommandLine.Contains("local_video_intake.py") -or -not $cleanCommandLine.Contains("--host 127.0.0.1")) {
        throw "Refusing to stop PID $($state.pid): it is not the recorded loopback intake process."
    }
    & wsl.exe -d $Distro -- bash -lc "kill '$($state.pid)'" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to stop local intake PID $($state.pid)." }
}
if (Test-Path -LiteralPath $StateWindowsPath) {
    Remove-Item -LiteralPath $StateWindowsPath -Force
}
Write-Output "Stopped the local video intake on $($state.url)."
