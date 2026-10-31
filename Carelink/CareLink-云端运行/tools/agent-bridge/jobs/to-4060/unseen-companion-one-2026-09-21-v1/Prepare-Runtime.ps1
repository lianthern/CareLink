[CmdletBinding()]
param([string]$RuntimeRoot = (Join-Path $env:USERPROFILE 'CompanionOne\baseline-v01'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$lockPath = Join-Path $PSScriptRoot 'RUNTIME-PACKAGE.json'
$lock = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($lock.jobId -cne 'unseen-companion-one-2026-09-21-v1' -or $lock.repository -cne 'maxi-max-dev/max-agent-bridge') { throw 'Runtime package identity mismatch' }
$visibility = & gh repo view $lock.repository --json visibility --jq .visibility
if ($LASTEXITCODE -ne 0 -or $visibility -cne 'PRIVATE') { throw 'Private repository verification failed' }
if (Test-Path -LiteralPath $RuntimeRoot) {
    $item = Get-Item -LiteralPath $RuntimeRoot -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Runtime root must be a plain directory' }
} else { New-Item -ItemType Directory -Path $RuntimeRoot -ErrorAction Stop | Out-Null }
$archivePath = Join-Path $RuntimeRoot $lock.assetName
if (-not (Test-Path -LiteralPath $archivePath)) {
    & gh release download $lock.releaseTag --repo $lock.repository --pattern $lock.assetName --dir $RuntimeRoot
    if ($LASTEXITCODE -ne 0) { throw 'Runtime download failed; preserve partials and retry deliberately' }
}
$archiveItem = Get-Item -LiteralPath $archivePath -Force
if ($archiveItem.PSIsContainer -or ($archiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Archive must be a plain file' }
if ($archiveItem.Length -ne [int64]$lock.bytes -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $lock.sha256) { throw 'Runtime archive hash/size mismatch; existing bytes preserved' }
$project = Join-Path $RuntimeRoot $lock.rootDirectory
if (-not (Test-Path -LiteralPath $project)) { Expand-Archive -LiteralPath $archivePath -DestinationPath $RuntimeRoot -ErrorAction Stop }
foreach ($record in @($lock.files)) {
    $path = Join-Path $RuntimeRoot ($record.path -replace '/', '\')
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne [int64]$record.bytes -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $record.sha256) {
        throw ('Runtime file mismatch; preserve changes and use a separate clean baseline: ' + $record.path)
    }
}
Write-Host ('Runtime archive and ' + @($lock.files).Count + ' files verified. Keep this baseline immutable; develop in a separate working copy.')
Write-Output $project
