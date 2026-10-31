[CmdletBinding()]
param(
    [string]$Repo = "maxi-max-dev/max-agent-bridge",
    [string]$JobId = "unseen-3dgs-local-product-2026-09-04-v15",
    [string]$BridgeRoot = (Join-Path $HOME "AgentBridge")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$maximumPayloadFiles = 4096
$maximumArchiveEntryBytes = [int64](32 * 1MB)
$maximumExpandedArchiveBytes = [int64](128 * 1MB)
$maximumManifestBytes = [int64](4 * 1MB)

if ($JobId -notmatch '^[a-z0-9][a-z0-9-]{0,127}$') {
    throw "JobId must be a portable lowercase identifier; no checkout or download was attempted."
}

function Assert-Command([string]$Name) {
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command '$Name'. Nothing was installed automatically."
    }
}

function Invoke-Checked([scriptblock]$Command, [string]$Failure) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw $Failure }
}

function Assert-PlainDirectory([string]$Path, [string]$Label) {
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Label is missing or is not a directory: $Path"
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label must not be a junction, symlink or reparse point: $Path"
    }
}

function Ensure-PlainDirectory([string]$Path, [string]$Label) {
    if (Test-Path -LiteralPath $Path) {
        Assert-PlainDirectory $Path $Label
    } else {
        New-Item -ItemType Directory -Path $Path -ErrorAction Stop | Out-Null
        Assert-PlainDirectory $Path $Label
    }
}

function Get-SafeRelativePath([string]$Value, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 240) {
        throw "$Label is empty or too long."
    }
    if ($Value.Contains("\") -or $Value.StartsWith("/") -or $Value -match '^[A-Za-z]:') {
        throw "$Label must be a portable, forward-slash relative path: $Value"
    }
    $parts = @($Value.Split('/'))
    if ($parts.Count -eq 0 -or @($parts | Where-Object { $_ -in @("", ".", "..") }).Count -gt 0) {
        throw "$Label contains an unsafe path component: $Value"
    }
    foreach ($part in $parts) {
        if ($part -match '[\x00-\x1f<>:"|?*]' -or $part.EndsWith(".") -or $part.EndsWith(" ")) {
            throw "$Label is not a portable Windows path: $Value"
        }
        $deviceBase = ([Regex]::Replace($part, '\..*$', '')).TrimEnd([char[]]@(' '))
        if ($deviceBase -match '^(?i:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM(?:[1-9]|\u00B9|\u00B2|\u00B3)|LPT(?:[1-9]|\u00B9|\u00B2|\u00B3))$') {
            throw "$Label contains a reserved Windows device name: $Value"
        }
    }
    return ($parts -join '/')
}

function Get-CanonicalGitHubSlug([string]$Value) {
    $candidate = ([string]$Value).Trim()
    if ($candidate -match '^(?<slug>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)$') {
        return $Matches.slug
    }
    foreach ($pattern in @(
        '^https://github\.com/(?<slug>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?$',
        '^git@github\.com:(?<slug>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?$',
        '^ssh://git@github\.com/(?<slug>[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?$'
    )) {
        if ($candidate -match $pattern) { return $Matches.slug }
    }
    throw "Git remote is not a canonical github.com owner/repository URL: $candidate"
}

function Assert-ControlCheckout([string]$Path, [string]$ExpectedRepo, [bool]$RequireSynchronized) {
    Assert-PlainDirectory $Path "Bridge control directory"
    if (-not (Test-Path -LiteralPath (Join-Path $Path ".git") -PathType Container)) {
        throw "Bridge control path is not a Git checkout: $Path"
    }
    $expectedSlug = Get-CanonicalGitHubSlug $ExpectedRepo
    $topOutput = & git -C $Path rev-parse --show-toplevel
    if ($LASTEXITCODE -ne 0 -or -not $topOutput) { throw "Could not resolve the Bridge checkout root." }
    $trimSeparators = [char[]]@('\', '/')
    $actualRoot = [IO.Path]::GetFullPath(([string]@($topOutput)[-1]).Trim()).TrimEnd($trimSeparators)
    $expectedRoot = [IO.Path]::GetFullPath($Path).TrimEnd($trimSeparators)
    if (-not $actualRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Bridge control path is nested in or aliases another Git checkout. expected=$expectedRoot actual=$actualRoot"
    }
    $originOutput = & git -C $Path remote get-url origin
    if ($LASTEXITCODE -ne 0 -or -not $originOutput) { throw "Bridge checkout has no readable origin remote." }
    $originSlug = Get-CanonicalGitHubSlug ([string]@($originOutput)[-1])
    if (-not $originSlug.Equals($expectedSlug, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Bridge origin mismatch. expected=$expectedSlug actual=$originSlug"
    }
    $branchOutput = & git -C $Path symbolic-ref --quiet --short HEAD
    if ($LASTEXITCODE -ne 0 -or (([string]@($branchOutput)[-1]).Trim() -cne "main")) {
        throw "Bridge checkout must be on the local main branch, not detached or another branch."
    }
    $status = @(& git -C $Path status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect Bridge checkout status." }
    if (@($status | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count -ne 0) {
        throw "Bridge checkout must be clean before receiving a release. Preserve/push local work, then retry."
    }
    if ($RequireSynchronized) {
        $headOutput = & git -C $Path rev-parse HEAD
        if ($LASTEXITCODE -ne 0 -or -not $headOutput) { throw "Could not resolve local Bridge HEAD." }
        $remoteOutput = & git -C $Path rev-parse refs/remotes/origin/main
        if ($LASTEXITCODE -ne 0 -or -not $remoteOutput) { throw "Could not resolve origin/main after synchronization." }
        $head = (([string]@($headOutput)[-1]).Trim()).ToLowerInvariant()
        $remoteHead = (([string]@($remoteOutput)[-1]).Trim()).ToLowerInvariant()
        if ($head -cne $remoteHead) {
            throw "Bridge main is not exactly synchronized with origin/main. Refusing local-ahead or stale task metadata."
        }
    }
}

function Receive-ZipPayloadFromLockedStream(
    [string]$ArchivePath,
    [string]$ExtractRoot,
    [object]$TaskObject,
    [object]$TagTaskObject,
    [bool]$HasPayloadManifest
) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $entryRelative = Get-SafeRelativePath ([string]$TaskObject.execution.entryPath) "execution.entryPath"
    $tagEntryRelative = Get-SafeRelativePath ([string]$TagTaskObject.execution.entryPath) "tag TASK execution.entryPath"
    if ($entryRelative -cne $tagEntryRelative) {
        throw "Current TASK.json and Release tag TASK.json disagree on execution.entryPath."
    }

    Assert-PlainDirectory $ExtractRoot "Payload extraction root"
    $extractRootFull = [IO.Path]::GetFullPath($ExtractRoot).TrimEnd([char[]]@('\', '/'))
    $extractPrefix = $extractRootFull + [IO.Path]::DirectorySeparatorChar
    $archiveStream = [IO.File]::Open(
        $ArchivePath,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::None
    )
    try {
        $actualBytes = [int64]$archiveStream.Length
        $archiveSha256 = [Security.Cryptography.SHA256]::Create()
        try {
            $actualSha = ([BitConverter]::ToString($archiveSha256.ComputeHash($archiveStream))).Replace("-", "").ToLowerInvariant()
        } finally {
            $archiveSha256.Dispose()
        }
        if ($actualBytes -ne [int64]$TaskObject.artifact.bytes) {
            throw "Byte-size mismatch. expected=$($TaskObject.artifact.bytes) actual=$actualBytes"
        }
        if ($actualSha -cne ([string]$TaskObject.artifact.sha256).ToLowerInvariant()) {
            throw "SHA256 mismatch. expected=$($TaskObject.artifact.sha256) actual=$actualSha"
        }
        $archiveStream.Position = 0
        $archiveArguments = @($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $true)
        $archive = New-Object -TypeName IO.Compression.ZipArchive -ArgumentList $archiveArguments
        try {
            $entries = @($archive.Entries)
            $maximumArchiveEntries = if ($HasPayloadManifest) { $maximumPayloadFiles + 1 } else { $maximumPayloadFiles }
            if ($entries.Count -lt 1 -or $entries.Count -gt $maximumArchiveEntries) {
                throw "ZIP entry count is outside the safe 1..$maximumArchiveEntries boundary."
            }
            $zipNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
            $windowsNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
            $entryByName = @{}
            $totalExpanded = [int64]0
            foreach ($zipEntry in $entries) {
                $rawName = [string]$zipEntry.FullName
                if ($rawName.EndsWith("/")) { throw "ZIP contains an explicit directory entry; only regular files are allowed: $rawName" }
                $relative = Get-SafeRelativePath $rawName "ZIP member"
                if ($relative -cne $rawName -or -not $zipNames.Add($relative) -or -not $windowsNames.Add($relative)) {
                    throw "ZIP contains a duplicate, case-colliding or non-normalized member: $rawName"
                }
                $external = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$zipEntry.ExternalAttributes), 0)
                $unixFileType = [int](($external -shr 16) -band 0xF000)
                $windowsNonRegular = $external -band 0x450  # directory (0x10), device (0x40), reparse point (0x400)
                if ($unixFileType -eq 0xA000 -or ($unixFileType -ne 0 -and $unixFileType -ne 0x8000) -or $windowsNonRegular -ne 0) {
                    throw "ZIP member is a symlink, reparse point or non-regular file: $relative"
                }
                $length = [int64]$zipEntry.Length
                if ($length -lt 1 -or $length -gt $maximumArchiveEntryBytes) {
                    throw "ZIP member size is outside the safe boundary: $relative ($length bytes)"
                }
                if ($totalExpanded -gt ($maximumExpandedArchiveBytes - $length)) {
                    throw "ZIP expanded size exceeds the $maximumExpandedArchiveBytes-byte safety budget."
                }
                $totalExpanded += $length
                $entryByName[$relative] = $zipEntry
            }
            if (-not $zipNames.Contains($entryRelative)) {
                throw "ZIP lacks the declared execution.entryPath: $entryRelative"
            }

            if ($HasPayloadManifest) {
                if ([string]$TaskObject.artifact.payloadManifestPath -cne "MANIFEST.json" -or
                    [string]$TaskObject.artifact.payloadManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
                    (($TaskObject.artifact.payloadFileCount -isnot [int]) -and ($TaskObject.artifact.payloadFileCount -isnot [long]))) {
                    throw "TASK.json does not declare the exact typed flat MANIFEST.json contract."
                }
                $declaredCount = [int]$TaskObject.artifact.payloadFileCount
                if ($declaredCount -lt 1 -or $declaredCount -gt $maximumPayloadFiles -or $entries.Count -ne ($declaredCount + 1)) {
                    throw "ZIP entry count does not equal payloadFileCount plus MANIFEST.json."
                }
                if (-not $entryByName.ContainsKey("MANIFEST.json")) { throw "ZIP lacks MANIFEST.json." }
                $manifestEntry = $entryByName["MANIFEST.json"]
                if ([int64]$manifestEntry.Length -gt $maximumManifestBytes) { throw "MANIFEST.json exceeds the safe size boundary." }
                $manifestStream = $manifestEntry.Open()
                $memory = New-Object IO.MemoryStream
                $manifestBuffer = New-Object byte[] 81920
                $manifestWritten = [int64]0
                try {
                    while (($manifestRead = $manifestStream.Read($manifestBuffer, 0, $manifestBuffer.Length)) -gt 0) {
                        if ($manifestWritten -gt ($maximumManifestBytes - [int64]$manifestRead) -or
                            $manifestWritten -gt ([int64]$manifestEntry.Length - [int64]$manifestRead)) {
                            throw "MANIFEST.json expanded beyond its declared or safe length."
                        }
                        $memory.Write($manifestBuffer, 0, $manifestRead)
                        $manifestWritten += [int64]$manifestRead
                    }
                    if ($manifestWritten -ne [int64]$manifestEntry.Length) {
                        throw "MANIFEST.json expanded shorter than its declared length."
                    }
                    $manifestBytes = $memory.ToArray()
                } finally {
                    $memory.Dispose()
                    $manifestStream.Dispose()
                }
                $sha256 = [Security.Cryptography.SHA256]::Create()
                try {
                    $manifestSha = ([BitConverter]::ToString($sha256.ComputeHash($manifestBytes))).Replace("-", "").ToLowerInvariant()
                } finally {
                    $sha256.Dispose()
                }
                if ($manifestSha -cne ([string]$TaskObject.artifact.payloadManifestSha256).ToLowerInvariant()) {
                    throw "In-ZIP MANIFEST.json SHA256 does not match TASK.json."
                }
                try {
                    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
                    $manifest = $strictUtf8.GetString($manifestBytes) | ConvertFrom-Json
                } catch {
                    throw "In-ZIP MANIFEST.json is not strict UTF-8 JSON: $($_.Exception.Message)"
                }
                if ($manifest.schemaVersion -cne "1.0" -or $manifest.jobId -cne $TaskObject.jobId -or
                    $manifest.releaseTag -cne $TaskObject.artifact.releaseTag -or $manifest.scope -cne "release-payload" -or
                    -not ($manifest.selfExcluded -is [bool]) -or $manifest.selfExcluded -ne $true -or
                    -not ($manifest.taskExcluded -is [bool]) -or $manifest.taskExcluded -ne $true) {
                    throw "In-ZIP MANIFEST.json identity/scope/type contract failed."
                }
                $manifestEntries = @($manifest.files)
                if ($manifestEntries.Count -ne $declaredCount) { throw "In-ZIP manifest file count disagrees with TASK.json." }
                $expectedNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
                foreach ($record in $manifestEntries) {
                    $relative = Get-SafeRelativePath ([string]$record.path) "manifest file path"
                    if ($relative -ceq "MANIFEST.json" -or -not $expectedNames.Add($relative)) {
                        throw "In-ZIP manifest contains itself or a duplicate path: $relative"
                    }
                    if (-not $entryByName.ContainsKey($relative)) { throw "ZIP lacks manifest member: $relative" }
                    if (($record.bytes -isnot [int]) -and ($record.bytes -isnot [long])) {
                        throw "Manifest byte count is not an integer: $relative"
                    }
                    if ([int64]$record.bytes -lt 1 -or [int64]$record.bytes -ne [int64]$entryByName[$relative].Length) {
                        throw "ZIP member size disagrees with manifest: $relative"
                    }
                    if ([string]$record.sha256 -notmatch '^[a-f0-9]{64}$') { throw "Manifest SHA256 is malformed: $relative" }
                }
                $null = $expectedNames.Add("MANIFEST.json")
                if (-not $expectedNames.SetEquals($zipNames)) { throw "ZIP member set does not exactly match MANIFEST.json." }
                if (-not $expectedNames.Contains($entryRelative) -or $entryRelative -ceq "MANIFEST.json") {
                    throw "execution.entryPath is not a payload file declared by MANIFEST.json."
                }
            }

            $copyBuffer = New-Object byte[] 81920
            foreach ($zipEntry in $entries) {
                $relative = [string]$zipEntry.FullName
                $targetPath = [IO.Path]::GetFullPath((Join-Path $extractRootFull ($relative -replace '/', '\')))
                if (-not $targetPath.StartsWith($extractPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    throw "ZIP extraction target escaped its root: $relative"
                }
                $parentPath = Split-Path -Parent $targetPath
                if ($parentPath.Equals($extractRootFull, [StringComparison]::OrdinalIgnoreCase)) {
                    $parentRelative = ""
                } elseif ($parentPath.StartsWith($extractPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                    $parentRelative = $parentPath.Substring($extractPrefix.Length).Trim([char[]]@('\', '/'))
                } else {
                    throw "ZIP extraction parent escaped its root: $relative"
                }
                $cursor = $extractRootFull
                if ($parentRelative) {
                    foreach ($component in @($parentRelative.Split([char[]]@('\', '/')))) {
                        $cursor = Join-Path $cursor $component
                        Ensure-PlainDirectory $cursor "ZIP extraction directory"
                    }
                }
                Assert-PlainDirectory $parentPath "ZIP extraction parent"
                if (Test-Path -LiteralPath $targetPath) {
                    throw "ZIP extraction target already exists; refusing overwrite: $relative"
                }

                $entryStream = $zipEntry.Open()
                $targetStream = $null
                $written = [int64]0
                try {
                    $targetStream = [IO.File]::Open(
                        $targetPath,
                        [IO.FileMode]::CreateNew,
                        [IO.FileAccess]::Write,
                        [IO.FileShare]::None
                    )
                    while (($read = $entryStream.Read($copyBuffer, 0, $copyBuffer.Length)) -gt 0) {
                        if ($written -gt ([int64]$zipEntry.Length - [int64]$read)) {
                            throw "ZIP member expanded beyond its declared length: $relative"
                        }
                        $targetStream.Write($copyBuffer, 0, $read)
                        $written += [int64]$read
                    }
                    $targetStream.Flush()
                    if ($written -ne [int64]$zipEntry.Length) {
                        throw "ZIP member expanded shorter than its declared length: $relative expected=$($zipEntry.Length) actual=$written"
                    }
                } catch {
                    $copyFailure = $_
                    if ($null -ne $targetStream) { $targetStream.Dispose(); $targetStream = $null }
                    if (Test-Path -LiteralPath $targetPath -PathType Leaf) { Remove-Item -LiteralPath $targetPath -Force }
                    throw $copyFailure
                } finally {
                    if ($null -ne $targetStream) { $targetStream.Dispose() }
                    $entryStream.Dispose()
                }
                $targetItem = Get-Item -LiteralPath $targetPath -Force
                if (($targetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
                    [int64]$targetItem.Length -ne [int64]$zipEntry.Length) {
                    throw "Extracted ZIP member type/size verification failed: $relative"
                }
            }
            return [pscustomobject]@{
                EntryPath = $entryRelative
                EntryCount = $entries.Count
                ExpandedBytes = $totalExpanded
                AssetBytes = $actualBytes
                AssetSha256 = $actualSha
            }
        } finally {
            $archive.Dispose()
        }
    } finally {
        $archiveStream.Dispose()
    }
}

function Assert-PayloadManifest([string]$Root, [object]$TaskObject) {
    $artifactProperties = @($TaskObject.artifact.PSObject.Properties.Name)
    foreach ($required in @("payloadManifestPath", "payloadManifestSha256", "payloadFileCount")) {
        if ($artifactProperties -notcontains $required) {
            throw "TASK.json is missing artifact.$required; extracted payload was not trusted."
        }
    }
    $manifestRelative = Get-SafeRelativePath ([string]$TaskObject.artifact.payloadManifestPath) "payload manifest path"
    if ($manifestRelative -cne "MANIFEST.json") {
        throw "This receiver requires the flat payload manifest at MANIFEST.json."
    }
    $manifestPath = Join-Path $Root ($manifestRelative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Verified ZIP lacks its declared payload manifest."
    }
    $manifestItem = Get-Item -LiteralPath $manifestPath -Force
    if (($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Payload manifest is a reparse point; refusing it."
    }
    $manifestSha = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$TaskObject.artifact.payloadManifestSha256 -notmatch '^[a-f0-9]{64}$' -or
        $manifestSha -cne ([string]$TaskObject.artifact.payloadManifestSha256).ToLowerInvariant()) {
        throw "Payload manifest SHA256 does not match TASK.json."
    }
    try {
        $manifest = Get-Content -Raw -LiteralPath $manifestPath -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Payload manifest JSON is invalid: $($_.Exception.Message)"
    }
    if ($manifest.schemaVersion -ne "1.0" -or $manifest.jobId -ne $TaskObject.jobId -or
        $manifest.releaseTag -ne $TaskObject.artifact.releaseTag -or
        $manifest.scope -ne "release-payload" -or $manifest.selfExcluded -ne $true -or
        $manifest.taskExcluded -ne $true -or $null -eq $manifest.files) {
        throw "Payload manifest identity/scope contract failed."
    }
    $declaredCount = [int]$TaskObject.artifact.payloadFileCount
    $entries = @($manifest.files)
    if ($declaredCount -lt 1 -or $entries.Count -ne $declaredCount) {
        throw "Payload manifest file count does not match TASK.json."
    }

    $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($entry in $entries) {
        $relative = Get-SafeRelativePath ([string]$entry.path) "payload file path"
        if ($relative -ceq $manifestRelative -or -not $expected.Add($relative)) {
            throw "Payload manifest contains itself or a duplicate path: $relative"
        }
        $candidate = Join-Path $Root ($relative -replace '/', '\')
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "Payload manifest entry is missing: $relative"
        }
        $item = Get-Item -LiteralPath $candidate -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Payload file is a reparse point: $relative"
        }
        if ($item.Length -ne [int64]$entry.bytes -or [int64]$entry.bytes -lt 1) {
            throw "Payload byte-size mismatch: $relative"
        }
        $digest = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
        if ([string]$entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $digest -cne ([string]$entry.sha256).ToLowerInvariant()) {
            throw "Payload SHA256 mismatch: $relative"
        }
    }
    $null = $expected.Add($manifestRelative)

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $actual = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($item in @(Get-ChildItem -LiteralPath $Root -Force -Recurse)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Extracted payload contains a reparse point: $($item.FullName)"
        }
        if (-not $item.PSIsContainer) {
            $full = [IO.Path]::GetFullPath($item.FullName)
            if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Extracted payload escaped its root."
            }
            $relative = $full.Substring($rootFull.Length).Replace('\', '/')
            $null = $actual.Add($relative)
        }
    }
    if (-not $actual.SetEquals($expected)) {
        $missing = @($expected | Where-Object { -not $actual.Contains($_) }) -join ', '
        $extra = @($actual | Where-Object { -not $expected.Contains($_) }) -join ', '
        throw "Payload tree does not exactly match MANIFEST.json. missing=[$missing] extra=[$extra]"
    }
    return [pscustomobject]@{ Sha256 = $manifestSha; FileCount = $entries.Count }
}

Assert-Command "gh"
Assert-Command "git"
Invoke-Checked { gh auth status --hostname github.com } "GitHub authentication failed. Run: gh auth login"

$expectedRepo = Get-CanonicalGitHubSlug $Repo
$repoInfoOutput = & gh repo view $expectedRepo --json nameWithOwner,isPrivate
if ($LASTEXITCODE -ne 0 -or -not $repoInfoOutput) {
    throw "Could not read repository identity/privacy from GitHub."
}
try { $repoInfo = ((@($repoInfoOutput) -join "`n") | ConvertFrom-Json) }
catch { throw "GitHub repository identity response was invalid JSON: $($_.Exception.Message)" }
if ([string]$repoInfo.nameWithOwner -ine $expectedRepo -or -not ($repoInfo.isPrivate -is [bool]) -or $repoInfo.isPrivate -ne $true) {
    throw "Fail closed: repository '$Repo' was not confirmed private."
}

$controlDir = Join-Path $BridgeRoot "control"
Ensure-PlainDirectory $BridgeRoot "Bridge root"
if (Test-Path -LiteralPath $controlDir) {
    Assert-PlainDirectory $controlDir "Bridge control directory"
}
if (Test-Path (Join-Path $controlDir ".git")) {
    Assert-ControlCheckout $controlDir $expectedRepo $false
    Invoke-Checked { git -C $controlDir pull --ff-only origin main } "Could not update Bridge control repository."
    Assert-ControlCheckout $controlDir $expectedRepo $true
} elseif (Test-Path $controlDir) {
    throw "Refusing to overwrite existing non-git path: $controlDir"
} else {
    Invoke-Checked { gh repo clone $expectedRepo $controlDir } "Could not clone private Bridge repository."
    Assert-PlainDirectory $controlDir "Bridge control directory"
    Assert-ControlCheckout $controlDir $expectedRepo $true
}

$taskPath = Join-Path $controlDir "jobs\to-4060\$JobId\TASK.json"
if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { throw "Unknown JobId or missing TASK.json: $JobId" }
$task = Get-Content -Raw -LiteralPath $taskPath -Encoding UTF8 | ConvertFrom-Json
if ($task.jobId -ne $JobId -or $task.state -ne "PUBLISHED") { throw "Task identity/state check failed." }
if ($task.artifact.delivery -ne "github-private-release" -or $task.artifact.format -ne "zip") {
    throw "Unsupported artifact contract."
}
$releaseTag = [string]$task.artifact.releaseTag
$assetName = [string]$task.artifact.assetName
if ($releaseTag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$') { throw "Unsafe Release tag in TASK.json." }
if ($assetName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,239}\.zip$') { throw "Unsafe Release asset name in TASK.json." }
$manifestFieldNames = @("payloadManifestPath", "payloadManifestSha256", "payloadFileCount")
$presentManifestFields = @($manifestFieldNames | Where-Object { $task.artifact.PSObject.Properties.Name -contains $_ })
if ($presentManifestFields.Count -notin @(0, 3)) { throw "Payload manifest fields must appear together in TASK.json." }
$hasPayloadManifest = $presentManifestFields.Count -eq 3
if ($JobId -eq "unseen-3dgs-local-product-2026-09-04-v15" -and -not $hasPayloadManifest) {
    throw "The v15 task requires a complete payload manifest contract."
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$runId = "$stamp-$([guid]::NewGuid().ToString('N'))"
$jobsRoot = Join-Path $BridgeRoot "jobs"
$runParent = Join-Path $jobsRoot $JobId
$runRoot = Join-Path $runParent $runId
$downloadDir = Join-Path $runRoot "download"
$extractDir = Join-Path $runRoot "unpacked"
Ensure-PlainDirectory $jobsRoot "Bridge jobs directory"
Ensure-PlainDirectory $runParent "Bridge job receive directory"
if (Test-Path -LiteralPath $runRoot) { throw "The unique receive run path already exists; no old run was reused: $runRoot" }
New-Item -ItemType Directory -Path $runRoot -ErrorAction Stop | Out-Null
Assert-PlainDirectory $runRoot "Bridge receive run directory"
New-Item -ItemType Directory -Path $downloadDir, $extractDir -ErrorAction Stop | Out-Null
Assert-PlainDirectory $downloadDir "Bridge download directory"
Assert-PlainDirectory $extractDir "Bridge unpacked directory"

Invoke-Checked {
    gh release download $releaseTag --repo $expectedRepo --pattern $assetName --dir $downloadDir
} "Release download failed. No receipt was submitted."

$assetPath = Join-Path $downloadDir $assetName
if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) { throw "Downloaded asset not found: $assetPath" }
$assetItem = Get-Item -LiteralPath $assetPath -Force
if (($assetItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Downloaded asset must not be a symlink or reparse point: $assetPath"
}

# Bind later GPU/result evidence to the exact bytes verified above. This is
# written after extraction, outside the immutable ZIP, so no circular asset
# hash is introduced. The v15 installer copies it into WSL ext4 and every
# canary report must quote these values.
$null = & git -C $controlDir fetch --force origin "refs/tags/$($releaseTag):refs/tags/$($releaseTag)"
if ($LASTEXITCODE -ne 0) {
    throw "Could not fetch the immutable Release tag for commit binding."
}
$controlCommitOutput = & git -C $controlDir rev-list -n 1 $releaseTag
if ($LASTEXITCODE -ne 0 -or -not $controlCommitOutput) {
    throw "Could not resolve the Release tag target commit."
}
$controlCommit = ([string]@($controlCommitOutput)[-1]).Trim()
if ($controlCommit -notmatch '^[0-9a-f]{40}$') {
    throw "Release tag target commit is malformed: $controlCommit"
}
if (($task.artifact.PSObject.Properties.Name -contains "commit") -and [string]$task.artifact.commit -ne $controlCommit) {
    throw "Release tag target does not match TASK.json artifact.commit."
}
$taskRelativePath = "jobs/to-4060/$JobId/TASK.json"
$headTaskSpec = "HEAD`:$taskRelativePath"
$tagTaskSpec = "$controlCommit`:$taskRelativePath"
$headTaskBlobOutput = & git -C $controlDir rev-parse $headTaskSpec
if ($LASTEXITCODE -ne 0 -or -not $headTaskBlobOutput) {
    throw "Current HEAD does not contain this job's TASK.json blob."
}
$tagTaskBlobOutput = & git -C $controlDir rev-parse $tagTaskSpec
if ($LASTEXITCODE -ne 0 -or -not $tagTaskBlobOutput) {
    throw "Release tag commit does not contain this job's TASK.json blob."
}
$headTaskBlob = ([string]@($headTaskBlobOutput)[-1]).Trim().ToLowerInvariant()
$tagTaskBlob = ([string]@($tagTaskBlobOutput)[-1]).Trim().ToLowerInvariant()
if ($headTaskBlob -notmatch '^[0-9a-f]{40}$' -or $tagTaskBlob -notmatch '^[0-9a-f]{40}$' -or
    $headTaskBlob -cne $tagTaskBlob) {
    throw "Current HEAD and Release tag commit do not contain the exact same TASK.json Git blob."
}
$workingTaskBlobOutput = & git -C $controlDir hash-object "--path=$taskRelativePath" -- $taskPath
if ($LASTEXITCODE -ne 0 -or -not $workingTaskBlobOutput) {
    throw "Could not bind the checked-out TASK.json bytes to their Git blob."
}
$workingTaskBlob = ([string]@($workingTaskBlobOutput)[-1]).Trim().ToLowerInvariant()
if ($workingTaskBlob -notmatch '^[0-9a-f]{40}$' -or $workingTaskBlob -cne $headTaskBlob) {
    throw "Checked-out TASK.json bytes do not match the exact HEAD and Release tag Git blob."
}
$tagTaskOutput = & git -C $controlDir show $tagTaskSpec
if ($LASTEXITCODE -ne 0 -or -not $tagTaskOutput) {
    throw "Release tag commit does not contain this job's TASK.json."
}
try {
    $tagTask = ((@($tagTaskOutput) -join "`n") | ConvertFrom-Json)
} catch {
    throw "Release tag TASK.json is invalid: $($_.Exception.Message)"
}
if ($tagTask.jobId -cne $task.jobId -or $tagTask.state -cne $task.state -or
    $tagTask.artifact.delivery -cne $task.artifact.delivery -or $tagTask.artifact.format -cne $task.artifact.format) {
    throw "Current TASK.json and Release tag TASK.json disagree on job/state/delivery/format identity."
}
$tagFields = @("releaseTag", "assetName", "sha256", "bytes", "format")
if ($hasPayloadManifest) { $tagFields += $manifestFieldNames }
foreach ($field in $tagFields) {
    if ([string]$tagTask.artifact.$field -cne [string]$task.artifact.$field) {
        throw "Current TASK.json and Release tag TASK.json disagree on artifact.$field."
    }
}
$zipEvidence = Receive-ZipPayloadFromLockedStream $assetPath $extractDir $task $tagTask $hasPayloadManifest
$actualBytes = [int64]$zipEvidence.AssetBytes
$actualSha = [string]$zipEvidence.AssetSha256
$entryPath = Join-Path $extractDir ($zipEvidence.EntryPath -replace '/', '\')
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
    throw "Verified ZIP lacks its declared file entryPath after extraction: $entryPath"
}
$payloadEvidence = $null
if ($hasPayloadManifest) { $payloadEvidence = Assert-PayloadManifest $extractDir $task }
$releaseEvidence = [ordered]@{
    schemaVersion = "1.0"
    jobId = $JobId
    releaseTag = $releaseTag
    assetName = $assetName
    assetSha256 = $actualSha
    assetBytes = [int64]$actualBytes
    controlCommit = $controlCommit
    verifiedAt = (Get-Date).ToUniversalTime().ToString("o")
    verifiedBy = "Receive-BridgeJob.ps1"
}
if ($hasPayloadManifest) {
    $releaseEvidence["payloadManifestSha256"] = $payloadEvidence.Sha256
    $releaseEvidence["payloadFileCount"] = [int]$payloadEvidence.FileCount
}
$releaseEvidencePath = Join-Path $extractDir ".bridge-receipt.json"
$releaseEvidenceJson = $releaseEvidence | ConvertTo-Json -Depth 5
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($releaseEvidencePath, $releaseEvidenceJson + [Environment]::NewLine, $utf8NoBom)

$submitScript = Join-Path $controlDir "scripts\windows\Submit-BridgeReceipt.ps1"
if ($hasPayloadManifest) {
    & $submitScript -RepoDir $controlDir -JobId $JobId -State "RECEIVED_VERIFIED" -Message "Private Release, tag contract, byte size, asset SHA256 and complete payload manifest verified." -Evidence @("asset_sha256:$actualSha", "asset_bytes:$actualBytes", "payload_manifest_sha256:$($payloadEvidence.Sha256)", "payload_files:$($payloadEvidence.FileCount)")
} else {
    & $submitScript -RepoDir $controlDir -JobId $JobId -State "RECEIVED_VERIFIED" -Message "Legacy private Release downloaded; tag contract, byte size and asset SHA256 verified." -Evidence @("asset_sha256:$actualSha", "asset_bytes:$actualBytes", "payload_manifest:legacy-absent")
}

Write-Host ""
Write-Host "RECEIVED_VERIFIED"
Write-Host "Read this file next:"
Write-Host $entryPath
Write-Host "Do not train under this Windows path. Follow START-HERE and copy the payload into WSL ext4 ~/src."

$resultManifestSha = $null
$resultManifestFiles = $null
if ($hasPayloadManifest) {
    $resultManifestSha = [string]$payloadEvidence.Sha256
    $resultManifestFiles = [int]$payloadEvidence.FileCount
}
$receiveResult = [pscustomobject][ordered]@{
    JobId = $JobId
    State = "RECEIVED_VERIFIED"
    RunRoot = $runRoot
    PayloadRoot = $extractDir
    EntryPath = $entryPath
    ReleaseTag = $releaseTag
    AssetSha256 = $actualSha
    AssetBytes = [int64]$actualBytes
    ControlCommit = $controlCommit
    PayloadManifestSha256 = $resultManifestSha
    PayloadFileCount = $resultManifestFiles
}
$receiveResult.PSObject.TypeNames.Insert(0, "UNSEEN.Bridge.ReceiveResult")
Write-Output $receiveResult
