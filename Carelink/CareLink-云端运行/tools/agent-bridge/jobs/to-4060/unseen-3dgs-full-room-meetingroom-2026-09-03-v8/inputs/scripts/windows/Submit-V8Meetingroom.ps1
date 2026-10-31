[CmdletBinding()]
param(
    [switch]$ConfirmResearchCanary,
    [ValidatePattern('^http://(127\.0\.0\.1|localhost):\d{1,5}/?$')]
    [string]$IntakeUrl = "http://127.0.0.1:8780/",
    [string]$WslDistro = "Ubuntu",
    [string]$OfficialPath = (Join-Path $env:LOCALAPPDATA "UNSEEN\public-canary\TanksAndTemples-Meetingroom.mp4"),
    [string]$PreparedPath = (Join-Path $env:LOCALAPPDATA "UNSEEN\public-canary\Meetingroom-v8-1600x900.mp4"),
    [switch]$DeleteOfficialAfterUpload,
    [switch]$DeletePreparedAfterUpload
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SourcePage = "https://www.tanksandtemples.org/download/"
$LicenseUrl = "https://www.tanksandtemples.org/license/"
$SourceUrl = "https://drive.usercontent.google.com/download?id=0B-ePgl6HF260V3BFSFFTZFJwSWc&export=download&confirm=t"
$ExpectedBytes = [int64]4271432079
$ExpectedMd5 = "5beeb4e21ca5b8fda31235cf15972393"
$ExpectedDuration = 370.370000

if (-not $ConfirmResearchCanary) {
    throw "This is a non-production research canary using the Tanks and Temples dataset. Read its license, then re-run with -ConfirmResearchCanary."
}
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    throw "curl.exe is required for the resumable 4.27 GB download."
}
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL is required. This script does not install or modify WSL."
}

$IntakeUrl = $IntakeUrl.TrimEnd('/')
$intakeUri = [uri]$IntakeUrl
if ($intakeUri.Port -lt 8780 -or $intakeUri.Port -gt 8789) {
    throw "Refusing intake port outside the frozen 8780-8789 range: $($intakeUri.Port)"
}

function Get-ReadyIntake {
    $health = Invoke-RestMethod -Uri "$IntakeUrl/api/health" -Method Get -TimeoutSec 15
    if ($health.status -ne "READY") { throw "Local intake is not READY." }
    if ($health.bindAddress -ne "127.0.0.1") { throw "Refusing non-loopback intake: $($health.bindAddress)" }
    if ($health.trainingStartsAutomatically -ne $false) { throw "Refusing intake that auto-starts training." }
    return $health
}

function Assert-OfficialAsset([string]$Path) {
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -ne $ExpectedBytes) {
        throw "Official download has $($item.Length) bytes; expected $ExpectedBytes. Preserve it for diagnosis and do not upload it."
    }
    $md5 = (Get-FileHash -Algorithm MD5 -LiteralPath $Path).Hash.ToLowerInvariant()
    if ($md5 -ne $ExpectedMd5) {
        throw "Official download MD5 mismatch; expected $ExpectedMd5, got $md5."
    }
}

function Probe-PreparedVideo([string]$Path) {
    $wslPath = (& wsl.exe -d $WslDistro -- wslpath -u -a $Path).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $wslPath) { throw "Could not translate PreparedPath into WSL." }
    $probeLines = & wsl.exe -d $WslDistro -- ffprobe -v error -show_entries "format=duration,size:stream=codec_type,codec_name,width,height,avg_frame_rate" -of json $wslPath
    if ($LASTEXITCODE -ne 0) { throw "ffprobe failed for prepared video." }
    $probe = ($probeLines -join [Environment]::NewLine) | ConvertFrom-Json
    $video = @($probe.streams | Where-Object { $_.codec_type -eq "video" })[0]
    if ($null -eq $video) { throw "Prepared file has no video stream." }
    $duration = [double]$probe.format.duration
    $bytes = [int64]$probe.format.size
    if ([int]$video.width -ne 1600 -or [int]$video.height -ne 900) {
        throw "Prepared video must be exactly 1600x900; got $($video.width)x$($video.height)."
    }
    if ([math]::Abs($duration - $ExpectedDuration) -gt 0.75) {
        throw "Prepared duration $duration is outside the frozen full-video tolerance."
    }
    if ($bytes -le 0 -or $bytes -ge 2GB) {
        throw "Prepared video must be positive and below the intake 2 GiB limit; got $bytes bytes."
    }
    return [pscustomobject]@{ WslPath = $wslPath; Duration = $duration; Bytes = $bytes; Codec = $video.codec_name }
}

$health = Get-ReadyIntake
$officialDir = Split-Path -Parent $OfficialPath
$preparedDir = Split-Path -Parent $PreparedPath
if (-not $officialDir -or -not $preparedDir) { throw "Both output paths must include a parent directory." }
New-Item -ItemType Directory -Force -Path $officialDir | Out-Null
New-Item -ItemType Directory -Force -Path $preparedDir | Out-Null

if (Test-Path -LiteralPath $OfficialPath) {
    Assert-OfficialAsset $OfficialPath
} else {
    $partPath = "$OfficialPath.part"
    $curlArgs = @(
        "--location", "--fail", "--retry", "3", "--retry-delay", "5",
        "--continue-at", "-", "--output", $partPath, $SourceUrl
    )
    & curl.exe @curlArgs
    if ($LASTEXITCODE -ne 0) { throw "Official download failed; any .part file is preserved for a later resume." }
    Assert-OfficialAsset $partPath
    Move-Item -LiteralPath $partPath -Destination $OfficialPath
}

$toolCheck = & wsl.exe -d $WslDistro -- bash -lc "command -v ffmpeg >/dev/null && command -v ffprobe >/dev/null"
if ($LASTEXITCODE -ne 0) { throw "ffmpeg and ffprobe must already exist inside WSL. This script does not install packages." }
$officialWsl = (& wsl.exe -d $WslDistro -- wslpath -u -a $OfficialPath).Trim()
if ($LASTEXITCODE -ne 0 -or -not $officialWsl) { throw "Could not translate OfficialPath into WSL." }

if (-not (Test-Path -LiteralPath $PreparedPath)) {
    $preparedWsl = (& wsl.exe -d $WslDistro -- wslpath -u -a $PreparedPath).Trim()
    & wsl.exe -d $WslDistro -- ffmpeg -nostdin -hide_banner -loglevel warning -n -i $officialWsl -an -vf "scale=1600:900:flags=lanczos" -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart $preparedWsl
    if ($LASTEXITCODE -ne 0) { throw "WSL ffmpeg failed while creating the intake-safe full-length copy." }
}
$prepared = Probe-PreparedVideo $PreparedPath
$preparedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PreparedPath).Hash.ToLowerInvariant()

$health = Get-ReadyIntake
$page = Invoke-WebRequest -UseBasicParsing -Uri "$IntakeUrl/" -Method Get -TimeoutSec 15
$csrfMatch = [regex]::Match($page.Content, '<meta name="unseen-csrf" content="([^"]+)">')
if (-not $csrfMatch.Success) { throw "Could not read the local intake CSRF token." }
$csrf = [System.Net.WebUtility]::HtmlDecode($csrfMatch.Groups[1].Value)

$uploadUri = "$IntakeUrl/api/upload?filename=tandt-meetingroom-v8-1600x900.mp4"
$response = Invoke-WebRequest -UseBasicParsing -Uri $uploadUri -Method Put -Headers @{ "X-UNSEEN-CSRF" = $csrf } -ContentType "video/mp4" -InFile $PreparedPath -TimeoutSec 3600
if ($response.StatusCode -ne 201) { throw "Local intake returned HTTP $($response.StatusCode)." }
$payload = $response.Content | ConvertFrom-Json
if ($payload.sha256 -ne $preparedHash -or [int64]$payload.bytes -ne $prepared.Bytes) {
    throw "Local intake response does not match the prepared full-length video."
}
if ($payload.status -ne "UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW" -or $payload.trainingStarted -ne $false) {
    throw "Unexpected intake state: $($payload.status)"
}

if ($DeletePreparedAfterUpload) { Remove-Item -LiteralPath $PreparedPath -Force }
if ($DeleteOfficialAfterUpload) { Remove-Item -LiteralPath $OfficialPath -Force }

[pscustomobject]@{
    schemaVersion = "1.0"
    sourcePage = $SourcePage
    licenseUrl = $LicenseUrl
    officialBytes = $ExpectedBytes
    officialMd5 = $ExpectedMd5
    officialRetained = -not [bool]$DeleteOfficialAfterUpload
    preparedBytes = $prepared.Bytes
    preparedSha256 = $preparedHash
    preparedDurationSeconds = $prepared.Duration
    preparedCodec = $prepared.Codec
    preparedRetained = -not [bool]$DeletePreparedAfterUpload
    jobId = $payload.jobId
    status = $payload.status
    intakeRoot = $health.intakeRoot
    trainingStarted = [bool]$payload.trainingStarted
} | ConvertTo-Json -Depth 4
