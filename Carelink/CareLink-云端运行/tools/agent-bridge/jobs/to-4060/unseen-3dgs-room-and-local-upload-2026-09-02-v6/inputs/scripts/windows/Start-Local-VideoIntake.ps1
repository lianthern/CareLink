[CmdletBinding()]
param(
    [string]$Distro = "Ubuntu-22.04",
    [string]$ProjectPath = "/home/max/src/unseen-3dgs-sceneworker",
    [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"
if ($ProjectPath -notmatch '^/[A-Za-z0-9._/-]+$' -or $ProjectPath -match '^/mnt/') {
    throw "ProjectPath must be a WSL ext4 path such as /home/max/src/unseen-3dgs-sceneworker."
}
if ($Distro -notmatch '^[A-Za-z0-9._-]+$') {
    throw "Distro contains unsupported characters."
}

$ScriptPath = "$ProjectPath/scripts/local_video_intake.py"
$IntakeRoot = "$ProjectPath/data/local-intake"
$ReportPath = "$ProjectPath/reports/local-intake"
$StatePath = "$ReportPath/server-state.json"
$ServerLogPath = "$ReportPath/server.log"
$StateWindowsPath = "\\wsl.localhost\$Distro" + ($StatePath -replace '/', '\')

function Invoke-Wsl {
    param([Parameter(Mandatory)][string]$Command)
    $output = & wsl.exe -d $Distro -- bash -lc $Command 2>&1
    $exitCode = $LASTEXITCODE
    $clean = @($output | ForEach-Object { ([string]$_).Replace(([char]0).ToString(), '') })
    if ($exitCode -ne 0) {
        throw "WSL command failed with exit code $exitCode`: $($clean -join [Environment]::NewLine)"
    }
    return $clean
}

Invoke-Wsl "test -f '$ScriptPath' && command -v ffprobe >/dev/null && mkdir -p '$ReportPath' '$IntakeRoot'" | Out-Null

if (Test-Path -LiteralPath $StateWindowsPath -PathType Leaf) {
    $existing = Get-Content -LiteralPath $StateWindowsPath -Raw | ConvertFrom-Json
    if ($existing.bindAddress -ne "127.0.0.1") {
        throw "Refusing an existing intake state that is not bound to 127.0.0.1."
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:{0}/api/health" -f $existing.port) -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            if ($OpenBrowser) { Start-Process $existing.url }
            $existing | ConvertTo-Json
            exit 0
        }
    } catch {
    }
}

for ($port = 8780; $port -le 8789; $port++) {
    $alreadyListening = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq $port }
    if ($alreadyListening) { continue }

    $serverCommand = "cd '$ProjectPath' && exec python3 '$ScriptPath' --host 127.0.0.1 --port $port --root '$IntakeRoot' --state-path '$StatePath' > '$ServerLogPath' 2>&1"
    $wslArguments = "-d $Distro -- bash -lc `"$serverCommand`""
    $wslProcess = Start-Process -FilePath "wsl.exe" -ArgumentList $wslArguments -WindowStyle Hidden -PassThru
    $healthUrl = "http://127.0.0.1:$port/api/health"
    $ready = $false
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if ($wslProcess.HasExited) { break }
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $healthUrl -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch {
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $ready -or -not (Test-Path -LiteralPath $StateWindowsPath -PathType Leaf)) {
        if (-not $wslProcess.HasExited) { Stop-Process -Id $wslProcess.Id -Force }
        continue
    }

    $state = Get-Content -LiteralPath $StateWindowsPath -Raw | ConvertFrom-Json
    if ($state.bindAddress -ne "127.0.0.1" -or [int]$state.port -ne $port) {
        throw "The local intake server reported an unexpected bind address or port."
    }
    if ($OpenBrowser) { Start-Process $state.url }
    $state | Add-Member -NotePropertyName windowsPid -NotePropertyValue $wslProcess.Id -Force
    $state | ConvertTo-Json
    exit 0
}

throw "No loopback port was available in the preferred range 8780-8789. No firewall rule was changed."
