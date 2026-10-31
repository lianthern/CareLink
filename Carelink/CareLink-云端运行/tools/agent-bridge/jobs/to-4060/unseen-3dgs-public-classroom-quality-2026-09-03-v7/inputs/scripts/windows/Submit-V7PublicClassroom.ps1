[CmdletBinding()]
param(
    [switch]$ConfirmPublicCanary,
    [ValidatePattern('^http://(127\.0\.0\.1|localhost):\d{1,5}/?$')]
    [string]$IntakeUrl = "http://127.0.0.1:8780/",
    [string]$DownloadPath = (Join-Path $env:TEMP "unseen-v7-pexels-classroom-5735358.mp4"),
    [switch]$KeepDownloadedVideo
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$SourceUrl = "https://videos.pexels.com/video-files/5735358/5735358-hd_1920_1080_30fps.mp4"
$ExpectedBytes = 12273501
$ExpectedSha256 = "b4dca2e138b475d5168bde72e61fe54beab9820b90aca1b22a4fe3739ea04ce6"

if (-not $ConfirmPublicCanary) {
    throw "This script downloads and uploads the frozen public Pexels canary. Re-run with -ConfirmPublicCanary."
}

$IntakeUrl = $IntakeUrl.TrimEnd('/')
$intakeUri = [uri]$IntakeUrl
if ($intakeUri.Port -lt 8780 -or $intakeUri.Port -gt 8789) {
    throw "Refusing intake port outside the frozen 8780-8789 range: $($intakeUri.Port)"
}
$health = Invoke-RestMethod -Uri "$IntakeUrl/api/health" -Method Get -TimeoutSec 15
if ($health.status -ne "READY") { throw "Local intake is not READY." }
if ($health.bindAddress -ne "127.0.0.1") { throw "Refusing non-loopback intake: $($health.bindAddress)" }
if ($health.trainingStartsAutomatically -ne $false) { throw "Refusing intake that auto-starts training." }

$downloadDir = Split-Path -Parent $DownloadPath
if (-not $downloadDir) { throw "DownloadPath must include a parent directory." }
New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
$partPath = "$DownloadPath.part"

if (Test-Path -LiteralPath $DownloadPath) {
    $existing = Get-Item -LiteralPath $DownloadPath
    $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DownloadPath).Hash.ToLowerInvariant()
    if ($existing.Length -ne $ExpectedBytes -or $existingHash -ne $ExpectedSha256) {
        throw "DownloadPath already exists but does not match the frozen public asset: $DownloadPath"
    }
} else {
    if (Test-Path -LiteralPath $partPath) {
        Remove-Item -LiteralPath $partPath -Force
    }
    Invoke-WebRequest -UseBasicParsing -Uri $SourceUrl -OutFile $partPath -MaximumRedirection 8
    $downloaded = Get-Item -LiteralPath $partPath
    $downloadedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $partPath).Hash.ToLowerInvariant()
    if ($downloaded.Length -ne $ExpectedBytes -or $downloadedHash -ne $ExpectedSha256) {
        throw "Downloaded asset failed bytes/SHA256 verification. The .part file is preserved for diagnosis."
    }
    Move-Item -LiteralPath $partPath -Destination $DownloadPath
}

$page = Invoke-WebRequest -UseBasicParsing -Uri "$IntakeUrl/" -Method Get -TimeoutSec 15
$csrfMatch = [regex]::Match($page.Content, '<meta name="unseen-csrf" content="([^"]+)">')
if (-not $csrfMatch.Success) { throw "Could not read the local intake CSRF token." }
$csrf = [System.Net.WebUtility]::HtmlDecode($csrfMatch.Groups[1].Value)

$uploadUri = "$IntakeUrl/api/upload?filename=pexels-classroom-5735358.mp4"
$response = Invoke-WebRequest -UseBasicParsing -Uri $uploadUri -Method Put -Headers @{ "X-UNSEEN-CSRF" = $csrf } -ContentType "video/mp4" -InFile $DownloadPath -TimeoutSec 600
if ($response.StatusCode -ne 201) { throw "Local intake returned HTTP $($response.StatusCode)." }
$payload = $response.Content | ConvertFrom-Json
if ($payload.sha256 -ne $ExpectedSha256 -or [int64]$payload.bytes -ne $ExpectedBytes) {
    throw "Local intake response does not match the frozen public asset."
}
if ($payload.status -ne "UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW" -or $payload.trainingStarted -ne $false) {
    throw "Unexpected intake state: $($payload.status)"
}

if (-not $KeepDownloadedVideo) {
    Remove-Item -LiteralPath $DownloadPath -Force
}

[pscustomobject]@{
    schemaVersion = "1.0"
    jobId = $payload.jobId
    status = $payload.status
    bytes = [int64]$payload.bytes
    sha256 = $payload.sha256
    durationSeconds = [double]$payload.durationSeconds
    intakeRoot = $health.intakeRoot
    windowsDownloadRetained = [bool]$KeepDownloadedVideo
    trainingStarted = [bool]$payload.trainingStarted
} | ConvertTo-Json -Depth 4
