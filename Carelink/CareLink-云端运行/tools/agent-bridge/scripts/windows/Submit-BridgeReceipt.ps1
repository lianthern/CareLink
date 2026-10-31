[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RepoDir,
    [Parameter(Mandatory = $true)][string]$JobId,
    [Parameter(Mandatory = $true)]
    [ValidateSet("RECEIVED_VERIFIED", "RUNNING", "UPLOADING", "COMPLETED", "BLOCKED", "FAILED")]
    [string]$State,
    [Parameter(Mandatory = $true)][ValidateLength(1, 2000)][string]$Message,
    [string[]]$Evidence = @()
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($JobId -notmatch '^[a-z0-9][a-z0-9-]{5,127}$') { throw "Invalid JobId." }

function Get-CanonicalGitHubRepo([string]$Url) {
    $value = $Url.Trim()
    if ($value.EndsWith(".git", [StringComparison]::OrdinalIgnoreCase)) {
        $value = $value.Substring(0, $value.Length - 4)
    }
    foreach ($pattern in @(
        '^https://github\.com/(?<repo>[^/]+/[^/]+)$',
        '^git@github\.com:(?<repo>[^/]+/[^/]+)$',
        '^ssh://git@github\.com/(?<repo>[^/]+/[^/]+)$'
    )) {
        if ($value -match $pattern) { return $Matches.repo.ToLowerInvariant() }
    }
    return ""
}

function Assert-SafeReceiptText([string]$Label, [string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { throw "$Label must not be empty." }
    if ($Value.Length -gt 2000) { throw "$Label is too long." }
    $secretPattern = '(?i)(github_pat_|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-|authorization\s*[:=]\s*bearer|api[_-]?key\s*[:=]|token\s*[:=]|-----BEGIN [^-]*(PRIVATE|OPENSSH) KEY-----)'
    $absolutePathPattern = '(?i)([A-Z]:\\|\\\\[^\\]+\\|/(home|Users|private|mnt)/)'
    if ($Value -match $secretPattern) {
        throw "$Label looks like it contains a secret. Submit only a redacted summary or SHA256."
    }
    if ($Value -match $absolutePathPattern) {
        throw "$Label contains a local absolute path. Submit a relative Bridge locator or a redacted summary."
    }
}

function Assert-ExactReceiptProperties($Value, [string]$Label) {
    $expected = @("schemaVersion", "jobId", "state", "createdAt", "agent", "machine", "message", "evidence") | Sort-Object
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    if ($actual.Count -ne $expected.Count) { throw "$Label has missing or unknown fields." }
    for ($index = 0; $index -lt $expected.Count; $index++) {
        if ([string]$actual[$index] -cne [string]$expected[$index]) { throw "$Label has missing or unknown fields." }
    }
}

function Test-ExactStringArray($Left, $Right) {
    $leftItems = @($Left)
    $rightItems = @($Right)
    if ($leftItems.Count -ne $rightItems.Count) { return $false }
    for ($index = 0; $index -lt $leftItems.Count; $index++) {
        if ([string]$leftItems[$index] -cne [string]$rightItems[$index]) { return $false }
    }
    return $true
}

function ConvertFrom-StrictReceiptText([string]$Text, [string]$FileName, [string]$ExpectedJob, [string]$SourceLabel) {
    try { $value = $Text | ConvertFrom-Json }
    catch { throw "Receipt JSON is invalid: $SourceLabel" }
    Assert-ExactReceiptProperties $value "Receipt"
    foreach ($stringProperty in @("schemaVersion", "jobId", "state", "createdAt", "agent", "machine", "message")) {
        if ($value.PSObject.Properties[$stringProperty].Value -isnot [string]) {
            throw "Receipt field '$stringProperty' is not an exact string: $SourceLabel"
        }
    }
    if ($value.schemaVersion -cne "1.0" -or $value.jobId -cne $ExpectedJob) {
        throw "Receipt JSON belongs to another schema/job: $SourceLabel"
    }
    if ($fileName -cnotmatch '^(?<stamp>[0-9]{8}T[0-9]{6}Z)-(?<state>received_verified|running|uploading|completed|blocked|failed)-[a-f0-9]{8}\.json$') {
        throw "Receipt filename is outside the exact ledger contract: $fileName"
    }
    $fileStamp = [string]$Matches.stamp
    $fileState = [string]$Matches.state
    if ($fileState.ToUpperInvariant() -cne [string]$value.state) {
        throw "Receipt filename state disagrees with its JSON state: $fileName"
    }
    $created = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParseExact(
        [string]$value.createdAt,
        "o",
        [Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::RoundtripKind,
        [ref]$created
    )) {
        throw "Receipt createdAt is invalid: $fileName"
    }
    if ($created.Offset -ne [TimeSpan]::Zero -or $created.UtcDateTime.ToString("yyyyMMddTHHmmssZ") -cne $fileStamp) {
        throw "Receipt filename timestamp disagrees with an exact UTC createdAt: $fileName"
    }
    if ($value.agent -cne "4060 Agent" -or $value.machine -notmatch '^[A-Za-z0-9._-]{1,128}$') {
        throw "Receipt agent/machine identity is invalid: $fileName"
    }
    Assert-SafeReceiptText "Receipt message" ([string]$value.message)
    if ($value.evidence -isnot [System.Array]) { throw "Receipt evidence is not an exact JSON array: $fileName" }
    $evidenceItems = @($value.evidence)
    if ($evidenceItems.Count -gt 32) { throw "Receipt evidence exceeds the 32-entry boundary: $fileName" }
    foreach ($evidenceItem in $evidenceItems) {
        if ($evidenceItem -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$evidenceItem) -or ([string]$evidenceItem).Length -gt 500) {
            throw "Receipt evidence contains an invalid entry: $fileName"
        }
        Assert-SafeReceiptText "Receipt evidence" ([string]$evidenceItem)
    }
    return [pscustomobject]@{ Receipt = $value; Created = $created; FileName = $fileName }
}

function Read-StrictReceipt([string]$Path, [string]$ExpectedJob) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Receipt file is missing: $Path" }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Receipt file must not be a reparse point: $Path"
    }
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try { $text = [IO.File]::ReadAllText($Path, $strictUtf8) }
    catch { throw "Receipt is not strict UTF-8 text: $Path" }
    return ConvertFrom-StrictReceiptText $text (Split-Path -Leaf $Path) $ExpectedJob $Path
}

function Test-ReceiptMatchesRequest($Receipt, [string]$ExpectedState, [string]$ExpectedMessage, [string[]]$ExpectedEvidence) {
    return (
        $Receipt.state -ceq $ExpectedState -and
        $Receipt.agent -ceq "4060 Agent" -and
        $Receipt.machine -ceq $env:COMPUTERNAME -and
        $Receipt.message -ceq $ExpectedMessage -and
        (Test-ExactStringArray -Left @($Receipt.evidence) -Right @($ExpectedEvidence))
    )
}

function Get-FilteredBlobOid([string]$Checkout, [string]$RelativePath, [string]$AbsolutePath) {
    $rows = @(& git -C $Checkout hash-object "--path=$RelativePath" -- $AbsolutePath)
    if ($LASTEXITCODE -ne 0 -or $rows.Count -ne 1 -or ([string]$rows[0]).Trim() -cnotmatch '^[a-f0-9]{40,64}$') {
        throw "Could not compute the filtered receipt blob: $RelativePath"
    }
    return ([string]$rows[0]).Trim()
}

function Assert-RemoteReceiptBlob([string]$Checkout, [string]$RelativePath, [string]$ExpectedBlob) {
    $rows = @(& git -C $Checkout rev-parse "refs/remotes/origin/main`:$RelativePath")
    if ($LASTEXITCODE -ne 0 -or $rows.Count -ne 1 -or ([string]$rows[0]).Trim() -cne $ExpectedBlob) {
        throw "origin/main does not contain the exact receipt blob: $RelativePath"
    }
}

function Publish-ExactReceiptCommit(
    [string]$Checkout,
    [string]$RelativePath,
    [string]$ExpectedBlob,
    [string]$RelativeDirectory,
    [string]$ExpectedJob,
    $ProposedReceipt,
    [bool]$EnforceV15Transitions
) {
    $headRows = @(& git -C $Checkout rev-parse "HEAD`:$RelativePath")
    if ($LASTEXITCODE -ne 0 -or $headRows.Count -ne 1 -or ([string]$headRows[0]).Trim() -cne $ExpectedBlob) {
        throw "HEAD does not contain the exact receipt being published: $RelativePath"
    }
    $pushRows = @(& git -C $Checkout push origin HEAD:main)
    if ($LASTEXITCODE -ne 0) {
        $fetchRows = @(& git -C $Checkout fetch origin main)
        if ($LASTEXITCODE -ne 0) { throw "Receipt is safely committed locally, but the concurrent remote ledger could not be fetched. Retry the exact same command." }
        $concurrentRemoteRows = @(& git -C $Checkout rev-parse refs/remotes/origin/main)
        if ($LASTEXITCODE -ne 0 -or $concurrentRemoteRows.Count -ne 1) { throw "Could not capture the concurrent remote ledger commit." }
        $concurrentRemote = ([string]$concurrentRemoteRows[0]).Trim().ToLowerInvariant()
        $concurrentLedger = @(Get-ValidatedRemoteReceiptLedger $Checkout $concurrentRemote $RelativeDirectory $ExpectedJob $EnforceV15Transitions)
        if ($EnforceV15Transitions) { Assert-ProposedV15Transition $concurrentLedger $ProposedReceipt }
        $rebaseRows = @(& git -C $Checkout rebase --autostash $concurrentRemote)
        if ($LASTEXITCODE -ne 0) { throw "Receipt is safely committed locally, but rebase failed. Retry the exact same command." }
        $headRows = @(& git -C $Checkout rev-parse "HEAD`:$RelativePath")
        if ($LASTEXITCODE -ne 0 -or $headRows.Count -ne 1 -or ([string]$headRows[0]).Trim() -cne $ExpectedBlob) {
            throw "Rebase changed or removed the exact receipt; refusing publication."
        }
        $pushRows = @(& git -C $Checkout push origin HEAD:main)
        if ($LASTEXITCODE -ne 0) { throw "Receipt is safely committed locally, but push failed. Retry the exact same command." }
    }
    $fetchRows = @(& git -C $Checkout fetch origin main)
    if ($LASTEXITCODE -ne 0) { throw "Receipt may be remote and remains safely committed locally; retry the exact same command." }
    $publishedRemoteRows = @(& git -C $Checkout rev-parse refs/remotes/origin/main)
    if ($LASTEXITCODE -ne 0 -or $publishedRemoteRows.Count -ne 1) { throw "Could not capture origin/main after receipt publication." }
    $publishedRemote = ([string]$publishedRemoteRows[0]).Trim().ToLowerInvariant()
    $publishedLedger = @(Get-ValidatedRemoteReceiptLedger $Checkout $publishedRemote $RelativeDirectory $ExpectedJob $EnforceV15Transitions)
    $publishedMatches = @($publishedLedger | Where-Object { $_.RelativePath -ceq $RelativePath -and $_.Blob -ceq $ExpectedBlob })
    if ($publishedMatches.Count -ne 1) { throw "The fully validated remote ledger lacks the exact published receipt blob: $RelativePath" }
    $commitRows = @(& git -C $Checkout log -1 --format=%H -- $RelativePath)
    if ($LASTEXITCODE -ne 0 -or $commitRows.Count -ne 1) { throw "Could not resolve the receipt commit." }
    $commit = ([string]$commitRows[0]).Trim()
    & git -C $Checkout merge-base --is-ancestor $commit $publishedRemote
    if ($LASTEXITCODE -ne 0) { throw "Receipt commit is not contained by origin/main." }
    return $commit
}

function Test-AllowedV15Transition([string]$PreviousState, [string]$NextState) {
    $allowed = switch ($PreviousState) {
        "RECEIVED_VERIFIED" { @("RUNNING", "BLOCKED", "FAILED") }
        "RUNNING" { @("UPLOADING", "BLOCKED", "FAILED") }
        "UPLOADING" { @("COMPLETED", "BLOCKED", "FAILED") }
        "BLOCKED" { @("RUNNING") }
        "FAILED" { @("RUNNING") }
        "COMPLETED" { @() }
        default { @() }
    }
    return @($allowed) -ccontains $NextState
}

function Assert-V15LedgerStateMachine($Ledger) {
    $entries = @($Ledger)
    if ($entries.Count -eq 0) { return }
    if ([string]$entries[0].Receipt.state -cne "RECEIVED_VERIFIED") {
        throw "The v15 remote receipt ledger must begin with RECEIVED_VERIFIED."
    }
    for ($index = 1; $index -lt $entries.Count; $index++) {
        $previous = [string]$entries[$index - 1].Receipt.state
        $current = [string]$entries[$index].Receipt.state
        if ($previous -ceq $current) {
            throw "The v15 remote ledger contains a duplicate $current entry; same-state retries must be exact idempotent no-ops."
        }
        if (-not (Test-AllowedV15Transition $previous $current)) {
            throw "The v15 remote receipt transition is invalid: $previous -> $current."
        }
    }
}

function Assert-ProposedV15Transition($Ledger, $ProposedReceipt) {
    $entries = @($Ledger)
    $nextState = [string]$ProposedReceipt.Receipt.state
    if ($entries.Count -eq 0) {
        if ($nextState -cne "RECEIVED_VERIFIED") {
            throw "The first v15 receipt must be RECEIVED_VERIFIED."
        }
        return
    }
    $latest = $entries[-1]
    $previousState = [string]$latest.Receipt.state
    if ([int64]$ProposedReceipt.Created.UtcDateTime.Ticks -le [int64]$latest.Created.UtcDateTime.Ticks) {
        throw "The proposed v15 receipt is not later than the complete remote ledger. Correct the Windows UTC clock before retrying."
    }
    if ($previousState -ceq $nextState) {
        throw "A same-state v15 receipt may only be an exact idempotent duplicate of the current remote receipt; no new ledger entry is allowed."
    }
    if (-not (Test-AllowedV15Transition $previousState $nextState)) {
        throw "The proposed v15 receipt transition is invalid: $previousState -> $nextState."
    }
}

function Read-GitBlobStrictUtf8([string]$Checkout, [string]$Blob, [string]$RelativePath) {
    $sizeRows = @(& git -C $Checkout cat-file -s $Blob)
    if ($LASTEXITCODE -ne 0 -or $sizeRows.Count -ne 1 -or ([string]$sizeRows[0]).Trim() -notmatch '^[0-9]+$') {
        throw "Could not determine the remote receipt blob size: $RelativePath"
    }
    $blobBytes = [int64]([string]$sizeRows[0]).Trim()
    if ($blobBytes -lt 2 -or $blobBytes -gt 65536) {
        throw "Remote receipt blob is outside the 2..65536 byte boundary: $RelativePath"
    }
    $gitCommand = Get-Command git -ErrorAction Stop
    $gitExecutable = [string]$gitCommand.Source
    if ([string]::IsNullOrWhiteSpace($gitExecutable)) { $gitExecutable = [string]$gitCommand.Definition }
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $gitExecutable
    $startInfo.WorkingDirectory = $Checkout
    $startInfo.Arguments = "cat-file blob $Blob"
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $memory = New-Object IO.MemoryStream
    try {
        if (-not $process.Start()) { throw "Could not start git cat-file for: $RelativePath" }
        $process.StandardOutput.BaseStream.CopyTo($memory)
        $standardError = $process.StandardError.ReadToEnd()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw "Could not read remote receipt blob: $RelativePath ($standardError)" }
        $bytes = $memory.ToArray()
    } finally {
        $memory.Dispose()
        $process.Dispose()
    }
    if ([int64]$bytes.Length -ne $blobBytes) { throw "Remote receipt blob byte count changed while reading: $RelativePath" }
    $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
    try { return $strictUtf8.GetString($bytes) }
    catch { throw "Remote receipt blob is not strict UTF-8: $RelativePath" }
}

function Get-ValidatedRemoteReceiptLedger([string]$Checkout, [string]$RemoteCommit, [string]$RelativeDirectory, [string]$ExpectedJob, [bool]$EnforceV15Transitions) {
    if ($RemoteCommit -cnotmatch '^[a-f0-9]{40,64}$') { throw "Remote ledger commit identity is invalid." }
    $prefix = "$RelativeDirectory/"
    $treeRows = @(& git -C $Checkout ls-tree -r --full-tree $RemoteCommit -- $prefix)
    if ($LASTEXITCODE -ne 0) { throw "Could not enumerate the complete remote receipt ledger." }
    $entries = @()
    $seenNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $seenTicks = New-Object 'System.Collections.Generic.HashSet[long]'
    $seenCommits = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($rawTreeRow in @($treeRows | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })) {
        $treeRow = [string]$rawTreeRow
        if ($treeRow -cnotmatch '^(?<mode>[0-9]{6}) (?<type>[a-z]+) (?<blob>[a-f0-9]{40,64})\t(?<path>.+)$') {
            throw "The remote receipt ledger contains an unparseable tree entry."
        }
        $mode = [string]$Matches.mode
        $objectType = [string]$Matches.type
        $blob = [string]$Matches.blob
        $relative = [string]$Matches.path
        if ($mode -cne "100644" -or $objectType -cne "blob" -or -not $relative.StartsWith($prefix, [StringComparison]::Ordinal)) {
            throw "The remote receipt ledger contains a non-regular or misplaced entry: $relative"
        }
        $fileName = $relative.Substring($prefix.Length)
        if ([string]::IsNullOrWhiteSpace($fileName) -or $fileName.Contains("/") -or $fileName.Contains("\") -or -not $seenNames.Add($fileName)) {
            throw "The remote receipt ledger contains a nested, duplicate or case-colliding entry: $relative"
        }
        $typeRows = @(& git -C $Checkout cat-file -t $blob)
        if ($LASTEXITCODE -ne 0 -or $typeRows.Count -ne 1 -or ([string]$typeRows[0]).Trim() -cne "blob") {
            throw "The remote receipt object is not an exact Git blob: $relative"
        }
        $content = Read-GitBlobStrictUtf8 $Checkout $blob $relative
        $parsed = ConvertFrom-StrictReceiptText $content $fileName $ExpectedJob "origin/main:$relative@$blob"
        if (-not $seenTicks.Add([int64]$parsed.Created.UtcDateTime.Ticks)) {
            throw "Two remote receipts have indistinguishable createdAt timestamps; ordering is ambiguous."
        }
        $historyRows = @(& git -C $Checkout log --format=%H $RemoteCommit -- $relative)
        $history = @($historyRows | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
        if ($LASTEXITCODE -ne 0 -or $history.Count -ne 1) {
            throw "Remote receipt is not an immutable append-only ledger entry: $relative"
        }
        $commit = ([string]$history[0]).Trim().ToLowerInvariant()
        if ($commit -cnotmatch '^[a-f0-9]{40,64}$' -or -not $seenCommits.Add($commit)) {
            throw "Remote receipt commit identity is invalid or shared by multiple ledger entries: $relative"
        }
        $commitBlobRows = @(& git -C $Checkout rev-parse "$commit`:$relative")
        if ($LASTEXITCODE -ne 0 -or $commitBlobRows.Count -ne 1 -or ([string]$commitBlobRows[0]).Trim().ToLowerInvariant() -cne $blob) {
            throw "Remote receipt content no longer matches its immutable commit blob: $relative"
        }
        $entries += [pscustomobject]@{
            Receipt = $parsed.Receipt
            Created = $parsed.Created
            RelativePath = $relative
            Blob = $blob
            Commit = $commit
        }
    }
    $ordered = @($entries | Sort-Object @{ Expression = { $_.Created.UtcDateTime.Ticks } })
    for ($index = 1; $index -lt $ordered.Count; $index++) {
        $previousCommit = [string]$ordered[$index - 1].Commit
        $currentCommit = [string]$ordered[$index].Commit
        & git -C $Checkout merge-base --is-ancestor $previousCommit $currentCommit
        if ($LASTEXITCODE -ne 0) {
            throw "Remote receipt createdAt ordering disagrees with the origin/main commit history."
        }
    }
    if ($EnforceV15Transitions) { Assert-V15LedgerStateMachine $ordered }
    return $ordered
}

function Remove-OwnedUncommittedReceipt([string]$Checkout, [string]$RelativePath, [string]$AbsolutePath) {
    & git -C $Checkout rm --cached --force --ignore-unmatch -- $RelativePath 2>$null | Out-Null
    if (Test-Path -LiteralPath $AbsolutePath) { Remove-Item -LiteralPath $AbsolutePath -Force }
    & git -C $Checkout ls-files --error-unmatch -- $RelativePath 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath $AbsolutePath)) {
        throw "Could not clean only the uncommitted receipt owned by this invocation: $RelativePath"
    }
}

$receiptMutex = New-Object System.Threading.Mutex($false, "Local\MaxAgentBridge-Receipt-$JobId")
$receiptMutexHeld = $false
try {
try {
    $receiptMutexHeld = $receiptMutex.WaitOne(0)
} catch [Threading.AbandonedMutexException] {
    $receiptMutexHeld = $true
}
if (-not $receiptMutexHeld) {
    throw "Another receipt publication for this exact job is already running. Retry after it finishes."
}

Assert-SafeReceiptText "Message" $Message
if ($Evidence.Count -gt 32) { throw "Evidence is limited to 32 short, non-secret entries." }
foreach ($item in @($Evidence)) {
    if ($null -eq $item -or ([string]$item).Length -gt 500) {
        throw "Each evidence entry must be a non-empty string of at most 500 characters."
    }
    Assert-SafeReceiptText "Evidence" ([string]$item)
}

$RepoDir = (Resolve-Path -LiteralPath $RepoDir).Path
if (-not (Test-Path -LiteralPath (Join-Path $RepoDir ".git"))) { throw "RepoDir is not a git checkout: $RepoDir" }
$topRows = @(& git -C $RepoDir rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0 -or $topRows.Count -lt 1) {
    throw "RepoDir must be the exact Bridge worktree root."
}
$topText = ([string]$topRows[-1]).Trim()
$resolvedTop = (Resolve-Path -LiteralPath $topText).Path
$trimSeparators = [char[]]@('\', '/')
$repoRoot = [IO.Path]::GetFullPath($RepoDir).TrimEnd($trimSeparators)
$topRoot = [IO.Path]::GetFullPath($resolvedTop).TrimEnd($trimSeparators)
if (-not $repoRoot.Equals($topRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "RepoDir must be the exact Bridge worktree root."
}
$branchRows = @(& git -C $RepoDir symbolic-ref --quiet --short HEAD)
if ($LASTEXITCODE -ne 0 -or $branchRows.Count -lt 1) {
    throw "Bridge receipt publication requires the main branch."
}
$branch = ([string]$branchRows[-1]).Trim()
if ($branch -cne "main") { throw "Bridge receipt publication requires the main branch." }
$originRows = @(& git -C $RepoDir remote get-url origin)
if ($LASTEXITCODE -ne 0 -or $originRows.Count -lt 1) {
    throw "Bridge origin is not the exact private max-agent-bridge repository."
}
$origin = Get-CanonicalGitHubRepo ([string]$originRows[-1])
if ($origin -cne "maxi-max-dev/max-agent-bridge") { throw "Bridge origin is not the exact private max-agent-bridge repository." }
$privacyRows = @(& gh repo view maxi-max-dev/max-agent-bridge --json isPrivate --jq '.isPrivate')
$privacyExit = $LASTEXITCODE
if ($privacyExit -ne 0 -or $privacyRows.Count -ne 1) { throw "GitHub repository privacy could not be proved." }
$privacy = ([string]$privacyRows[0]).Trim().ToLowerInvariant()
if ($privacy -cne "true") { throw "GitHub repository privacy could not be proved." }

$fetchRows = @(& git -C $RepoDir fetch origin main)
if ($LASTEXITCODE -ne 0) { throw "Could not refresh origin/main before writing or recovering a receipt." }
$headRows = @(& git -C $RepoDir rev-parse HEAD)
if ($LASTEXITCODE -ne 0 -or $headRows.Count -ne 1) { throw "Could not resolve the local Bridge commit." }
$remoteHeadRows = @(& git -C $RepoDir rev-parse refs/remotes/origin/main)
if ($LASTEXITCODE -ne 0 -or $remoteHeadRows.Count -ne 1) { throw "Could not resolve origin/main." }
$head = ([string]$headRows[0]).Trim().ToLowerInvariant()
$remoteHead = ([string]$remoteHeadRows[0]).Trim().ToLowerInvariant()
if ($head -notmatch '^[a-f0-9]{40,64}$' -or $remoteHead -notmatch '^[a-f0-9]{40,64}$') {
    throw "Bridge HEAD/origin main identity is invalid."
}
if ($head -cne $remoteHead) {
    & git -C $RepoDir merge-base --is-ancestor HEAD refs/remotes/origin/main
    if ($LASTEXITCODE -eq 0) {
        $pullRows = @(& git -C $RepoDir pull --ff-only origin main)
        if ($LASTEXITCODE -ne 0) { throw "Could not fast-forward Bridge before writing a receipt." }
    }
    # Local-only commits, including a branch that also has new remote commits,
    # fall through to the exact single-receipt validation below.
}

$taskPath = Join-Path $RepoDir "jobs\to-4060\$JobId\TASK.json"
if (-not (Test-Path -LiteralPath $taskPath -PathType Leaf)) { throw "Task not found: $taskPath" }
$task = Get-Content -Raw -LiteralPath $taskPath -Encoding UTF8 | ConvertFrom-Json
$taskJob = [string]$task.jobId
$taskState = [string]$task.state
if ($taskJob -cne $JobId -or $taskState -cne "PUBLISHED") { throw "TASK identity/state changed unexpectedly." }
$repo = [string]$task.receipt.repository
if ($repo -cne "maxi-max-dev/max-agent-bridge") { throw "TASK receipt repository changed unexpectedly." }
$relativeDir = "receipts/from-4060/$JobId"
if ([string]$task.receipt.directory -cne $relativeDir -or
    -not ($task.receipt.githubIsAuthoritative -is [bool]) -or $task.receipt.githubIsAuthoritative -ne $true) {
    throw "TASK receipt directory/authority contract changed unexpectedly."
}
if ([string]::IsNullOrWhiteSpace($env:COMPUTERNAME) -or $env:COMPUTERNAME -notmatch '^[A-Za-z0-9._-]{1,128}$') {
    throw "COMPUTERNAME is missing or unsafe for the receipt ledger."
}

$absoluteDir = Join-Path $RepoDir ($relativeDir -replace '/', '\')
$enforceV15Transitions = $JobId -ceq "unseen-3dgs-local-product-2026-09-04-v15"
$remoteLedger = @(Get-ValidatedRemoteReceiptLedger $RepoDir $remoteHead $relativeDir $JobId $enforceV15Transitions)
$latestRemote = if ($remoteLedger.Count -gt 0) { $remoteLedger[-1] } else { $null }

$ahead = @(& git -C $RepoDir rev-list --reverse refs/remotes/origin/main..HEAD)
if ($LASTEXITCODE -ne 0) { throw "Could not inspect local-ahead receipt recovery state." }
if ($ahead.Count -gt 0) {
    if ($ahead.Count -ne 1) { throw "Local main has multiple unpublished commits; refusing receipt recovery." }
    $paths = @(& git -C $RepoDir diff-tree --no-commit-id --name-only -r $ahead[0])
    if ($LASTEXITCODE -ne 0 -or $paths.Count -ne 1) { throw "Unpublished commit is not one exact receipt." }
    $relativePath = ([string]$paths[0]).Replace('\', '/')
    $expectedReceiptPattern = '^' + [regex]::Escape("$relativeDir/") + '[0-9]{8}T[0-9]{6}Z-' + [regex]::Escape($State.ToLowerInvariant()) + '-[a-f0-9]{8}\.json$'
    if ($relativePath -cnotmatch $expectedReceiptPattern) {
        throw "Unpublished commit is not the exact requested $State receipt for $JobId."
    }
    $absolutePath = Join-Path $RepoDir ($relativePath -replace '/', '\')
    if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) { throw "Unpublished receipt file is missing." }
    $receiptRecord = Read-StrictReceipt $absolutePath $JobId
    if (-not (Test-ReceiptMatchesRequest -Receipt $receiptRecord.Receipt -ExpectedState $State -ExpectedMessage $Message -ExpectedEvidence @($Evidence))) {
        throw "Unpublished receipt does not match this exact retry. Re-run the original command."
    }
    if ($enforceV15Transitions) { Assert-ProposedV15Transition $remoteLedger $receiptRecord }
    $receiptBlob = Get-FilteredBlobOid $RepoDir $relativePath $absolutePath
    $null = Publish-ExactReceiptCommit $RepoDir $relativePath $receiptBlob $relativeDir $JobId $receiptRecord $enforceV15Transitions
    $resumedReceipt = $true
} else {
    $resumedReceipt = $false
    if ($null -ne $latestRemote -and (Test-ReceiptMatchesRequest -Receipt $latestRemote.Receipt -ExpectedState $State -ExpectedMessage $Message -ExpectedEvidence @($Evidence))) {
        Write-Host "Receipt already published exactly: $($latestRemote.RelativePath)"
        $global:LASTEXITCODE = 0
        return
    }
    if ($null -ne $latestRemote -and $latestRemote.Receipt.state -ceq $State) {
        throw "Latest remote receipt already has state $State but different content; refusing an invalid duplicate-state transition."
    }

    $now = (Get-Date).ToUniversalTime()
    $suffix = [guid]::NewGuid().ToString("N").Substring(0, 8)
    $fileName = "$($now.ToString('yyyyMMddTHHmmssZ'))-$($State.ToLowerInvariant())-$suffix.json"
    $relativePath = "$relativeDir/$fileName"
    $absolutePath = Join-Path $absoluteDir $fileName
    if (Test-Path -LiteralPath $absolutePath) { throw "Generated receipt path already exists; refusing to overwrite it." }
    $receipt = [ordered]@{
        schemaVersion = "1.0"
        jobId = $JobId
        state = $State
        createdAt = $now.ToString("o")
        agent = "4060 Agent"
        machine = $env:COMPUTERNAME
        message = $Message
        evidence = @($Evidence)
    }
    $receiptRecord = [pscustomobject]@{ Receipt = [pscustomobject]$receipt; Created = [DateTimeOffset]$now; FileName = $fileName }
    if ($enforceV15Transitions) { Assert-ProposedV15Transition $remoteLedger $receiptRecord }
    New-Item -ItemType Directory -Force -Path $absoluteDir | Out-Null
    $receiptText = (($receipt | ConvertTo-Json -Depth 5) -replace "`r`n", "`n" -replace "`r", "`n")
    $receiptText = ($receiptText -replace "`n*\z", "") + "`n"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $receiptCommitted = $false
    try {
        [IO.File]::WriteAllText($absolutePath, $receiptText, $utf8NoBom)
        & git -C $RepoDir add -- $relativePath
        if ($LASTEXITCODE -ne 0) { throw "Could not stage receipt." }
        & git -C $RepoDir -c user.name="4060 Agent" -c user.email="4060-agent@users.noreply.github.com" -c commit.gpgsign=false commit --only -m "receipt($JobId): $State" -- $relativePath
        if ($LASTEXITCODE -ne 0) { throw "Could not commit receipt." }
        $receiptCommitted = $true
    } catch {
        $failure = $_
        if (-not $receiptCommitted) { Remove-OwnedUncommittedReceipt $RepoDir $relativePath $absolutePath }
        throw $failure
    }
    $receiptBlob = Get-FilteredBlobOid $RepoDir $relativePath $absolutePath
    $null = Publish-ExactReceiptCommit $RepoDir $relativePath $receiptBlob $relativeDir $JobId $receiptRecord $enforceV15Transitions
}

if ($null -ne $task.receipt.issueNumber) {
    $comment = "[$State] $Message`n`nReceipt: ``$relativePath``"
    gh issue comment ([int]$task.receipt.issueNumber) --repo $repo --body $comment | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Receipt was pushed, but the human-readable Issue comment failed. Repository receipt remains authoritative."
    }
}

if ($resumedReceipt) { Write-Host "Receipt publication safely resumed: $relativePath" }
else { Write-Host "Receipt published: $relativePath" }
$global:LASTEXITCODE = 0
} finally {
    if ($receiptMutexHeld) { $receiptMutex.ReleaseMutex() }
    $receiptMutex.Dispose()
}
