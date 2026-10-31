[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][switch]$ConfirmPublish,
  [Parameter(Mandatory=$true)][switch]$WalkPass,
  [Parameter(Mandatory=$true)][switch]$ZoomInOutPass,
  [Parameter(Mandatory=$true)][switch]$HorizonLevelPass,
  [Parameter(Mandatory=$true)][switch]$SixDirectionsPass,
  [Parameter(Mandatory=$true)][switch]$ThreePhotoAnchorsPass,
  [Parameter(Mandatory=$true)][switch]$NoPageErrors,
  [string]$BridgeCheckout = "$HOME\AgentBridge\control"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$job = "unseen-3dgs-local-product-2026-09-04-v15"
$relativeRoot = "results/from-4060/$job"
$relativeJson = "$relativeRoot/V15-RESULT.json"
$relativeMarkdown = "$relativeRoot/V15-REPORT.md"
$safeSha = '^[a-f0-9]{64}$'
$safeId = '^[A-Za-z0-9._-]{1,160}$'

function Invoke-Checked([scriptblock]$Command, [string]$Failure) {
  & $Command
  if ($LASTEXITCODE -ne 0) { throw $Failure }
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-StrictBoolean($Value, [bool]$Expected, [string]$Message) {
  if ($Value -isnot [bool] -or [bool]$Value -ne $Expected) { throw $Message }
}

function Assert-IntegerAtLeast($Value, [int64]$Minimum, [string]$Message) {
  if (($Value -isnot [int]) -and ($Value -isnot [long])) { throw $Message }
  if ([int64]$Value -lt $Minimum) { throw $Message }
}

function Assert-FiniteNumberRange($Value, [double]$Minimum, [double]$Maximum, [string]$Message) {
  if (($Value -isnot [int]) -and ($Value -isnot [long]) -and ($Value -isnot [double]) -and ($Value -isnot [decimal])) {
    throw $Message
  }
  $number = [double]$Value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt $Minimum -or $number -gt $Maximum) {
    throw $Message
  }
}

function Assert-ExactProperties($Value, [string[]]$Expected, [string]$Message) {
  if ($null -eq $Value) { throw $Message }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if ($actual.Count -ne $wanted.Count) { throw $Message }
  for ($index = 0; $index -lt $wanted.Count; $index++) {
    if ([string]$actual[$index] -cne [string]$wanted[$index]) { throw $Message }
  }
}

function Get-CanonicalGitHubRepo([string]$Url) {
  $trimmed = $Url.Trim()
  if ($trimmed.EndsWith(".git", [StringComparison]::OrdinalIgnoreCase)) {
    $trimmed = $trimmed.Substring(0, $trimmed.Length - 4)
  }
  $patterns = @(
    '^https://github\.com/(?<repo>[^/]+/[^/]+)$',
    '^git@github\.com:(?<repo>[^/]+/[^/]+)$',
    '^ssh://git@github\.com/(?<repo>[^/]+/[^/]+)$'
  )
  foreach ($pattern in $patterns) {
    if ($trimmed -match $pattern) { return $Matches.repo.ToLowerInvariant() }
  }
  return ""
}

function Assert-Issue16Open {
  $rows = @(& gh issue view 16 --repo maxi-max-dev/max-agent-bridge --json state --jq '.state')
  $exitCode = $LASTEXITCODE
  Assert-True ($exitCode -eq 0 -and $rows.Count -eq 1) "Could not prove that Issue #16 remains open."
  Assert-True (([string]$rows[0]).Trim().ToUpperInvariant() -ceq "OPEN") "Issue #16 must remain open for the post-release new-input gate."
}

function Assert-AllowedWorktree([string]$Checkout, [string[]]$AllowedPaths) {
  $rows = @(& git -C $Checkout status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect the Bridge working tree." }
  foreach ($row in $rows) {
    if ([string]::IsNullOrWhiteSpace([string]$row)) { continue }
    if ($row.Length -lt 4) { throw "Malformed git status output; refusing publication." }
    $path = ([string]$row).Substring(3).Replace('\', '/')
    if ($path.Contains(" -> ") -or $AllowedPaths -cnotcontains $path) {
      throw "Bridge has an unrelated or renamed working-tree change: $path. Only the two v15 report files may be published."
    }
  }
}

function Assert-SafeReportPath([string]$Checkout, [string]$Path) {
  $checkoutFull = [IO.Path]::GetFullPath($Checkout).TrimEnd('\') + '\'
  $targetFull = [IO.Path]::GetFullPath($Path)
  if (-not $targetFull.StartsWith($checkoutFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Report path escapes the Bridge checkout."
  }
  $cursor = Split-Path -Parent $targetFull
  while ($cursor -and -not $cursor.Equals($Checkout, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $cursor) {
      $directoryItem = Get-Item -LiteralPath $cursor -Force
      if (($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Report parent is a reparse point: $cursor"
      }
    }
    $parent = Split-Path -Parent $cursor
    if ($parent -ceq $cursor) { throw "Could not prove report path containment." }
    $cursor = $parent
  }
  if (-not $cursor) { throw "Could not prove report path containment." }
  if (Test-Path -LiteralPath $targetFull) {
    $item = Get-Item -LiteralPath $targetFull -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.PSIsContainer) {
      throw "Report target is not a regular file: $targetFull"
    }
  }
}

function Assert-TrackedOnOriginMain([string]$Checkout, [string]$RelativePath) {
  & git -C $Checkout ls-files --error-unmatch -- $RelativePath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Required evidence is not tracked: $RelativePath" }
  $commitRows = @(& git -C $Checkout log -1 --format=%H -- $RelativePath)
  if ($LASTEXITCODE -ne 0 -or $commitRows.Count -lt 1) { throw "Could not resolve evidence commit: $RelativePath" }
  $commit = ([string]$commitRows[-1]).Trim()
  if ($commit -notmatch '^[a-f0-9]{40}$') { throw "Evidence commit is invalid: $RelativePath" }
  & git -C $Checkout merge-base --is-ancestor $commit refs/remotes/origin/main
  if ($LASTEXITCODE -ne 0) { throw "Evidence is only local and is not contained by origin/main: $RelativePath" }
  return $commit
}

function Get-CurrentBlobOid([string]$Checkout, [string]$RelativePath) {
  $absolute = Join-Path $Checkout ($RelativePath -replace '/', '\')
  $rows = @(& git -C $Checkout hash-object "--path=$RelativePath" -- $absolute)
  if ($LASTEXITCODE -ne 0 -or $rows.Count -lt 1 -or ([string]$rows[-1]).Trim() -notmatch '^[a-f0-9]{40}$') {
    throw "Could not compute the canonical LF Git blob for $RelativePath"
  }
  return ([string]$rows[-1]).Trim()
}

function Assert-RemoteBlob([string]$Checkout, [string]$RelativePath, [string]$ExpectedOid) {
  $rows = @(& git -C $Checkout rev-parse "refs/remotes/origin/main`:$RelativePath")
  if ($LASTEXITCODE -ne 0 -or $rows.Count -lt 1 -or ([string]$rows[-1]).Trim() -cne $ExpectedOid) {
    throw "origin/main does not contain the exact accepted blob: $RelativePath"
  }
}

function Publish-AllowedLocalAhead(
  [string]$Checkout,
  [string[]]$AllowedReports,
  [string]$ReceiptPrefix,
  [hashtable]$ExpectedReportBlobs,
  [bool]$Retried = $false
) {
  Invoke-Checked { git -C $Checkout fetch origin main } "Could not refresh origin/main before local-ahead recovery."
  & git -C $Checkout merge-base --is-ancestor refs/remotes/origin/main HEAD
  if ($LASTEXITCODE -ne 0) { throw "Local main diverged from origin/main; refusing to publish any local commit." }
  $ahead = @(& git -C $Checkout rev-list --reverse refs/remotes/origin/main..HEAD)
  if ($LASTEXITCODE -ne 0) { throw "Could not inspect local-ahead commits." }
  foreach ($commit in $ahead) {
    $parents = @(& git -C $Checkout rev-list --parents -n 1 $commit)
    if ($LASTEXITCODE -ne 0 -or $parents.Count -ne 1 -or ([string]$parents[0]).Split(' ').Count -ne 2) {
      throw "Local-ahead recovery refuses merge/root commits: $commit"
    }
    $paths = @(& git -C $Checkout diff-tree --no-commit-id --name-only -r $commit)
    if ($LASTEXITCODE -ne 0 -or $paths.Count -lt 1) { throw "Local-ahead commit has no auditable paths: $commit" }
    foreach ($rawPath in $paths) {
      $path = ([string]$rawPath).Replace('\', '/')
      if ($AllowedReports -ccontains $path) {
        $blobRows = @(& git -C $Checkout rev-parse "$commit`:$path")
        if ($LASTEXITCODE -ne 0 -or $blobRows.Count -lt 1 -or ([string]$blobRows[-1]).Trim() -cne [string]$ExpectedReportBlobs[$path]) {
          throw "Local-ahead report commit does not contain the exact accepted report blob: $commit / $path"
        }
      } elseif ($path.StartsWith($ReceiptPrefix, [StringComparison]::Ordinal) -and $path.EndsWith(".json", [StringComparison]::Ordinal)) {
        $current = Join-Path $Checkout ($path -replace '/', '\')
        Assert-True (Test-Path -LiteralPath $current -PathType Leaf) "Local-ahead receipt is missing from the current ledger."
        $currentBlob = Get-CurrentBlobOid $Checkout $path
        $blobRows = @(& git -C $Checkout rev-parse "$commit`:$path")
        if ($LASTEXITCODE -ne 0 -or $blobRows.Count -lt 1 -or ([string]$blobRows[-1]).Trim() -cne $currentBlob) {
          throw "Local-ahead receipt commit was altered or deleted: $commit / $path"
        }
      } else {
        throw "Local-ahead commit touches a non-publication path: $commit / $path"
      }
    }
  }
  if ($ahead.Count -eq 0) { return }
  & git -C $Checkout push origin HEAD:main
  if ($LASTEXITCODE -ne 0) {
    if ($Retried) { throw "Allowed local publication commits still could not be pushed after one rebase." }
    Invoke-Checked { git -C $Checkout pull --rebase --autostash origin main } "Allowed local publication commits could not be rebased."
    Publish-AllowedLocalAhead $Checkout $AllowedReports $ReceiptPrefix $ExpectedReportBlobs $true
    return
  }
  Invoke-Checked { git -C $Checkout fetch origin main } "Local publication commits were pushed, but origin/main could not be refreshed."
  & git -C $Checkout merge-base --is-ancestor HEAD refs/remotes/origin/main
  if ($LASTEXITCODE -ne 0) { throw "Pushed local publication commits are not contained by origin/main." }
}

function Get-ReceiptLedger([string]$Checkout, [string]$ReceiptRoot, [string]$ExpectedJob) {
  $entries = @()
  $seenTicks = New-Object 'System.Collections.Generic.HashSet[long]'
  foreach ($receiptPath in @(Get-ChildItem -LiteralPath $ReceiptRoot -Filter "*.json" -File)) {
    if ($receiptPath.Name -notmatch '^(?<stamp>[0-9]{8}T[0-9]{6}Z)-(?<state>received_verified|running|uploading|completed|blocked|failed)-[a-f0-9]{8}\.json$') {
      throw "Receipt filename is outside the v15 ledger contract: $($receiptPath.Name)"
    }
    $fileStamp = [string]$Matches.stamp
    $fileState = [string]$Matches.state
    try { $receipt = Get-Content -Raw -LiteralPath $receiptPath.FullName -Encoding UTF8 | ConvertFrom-Json }
    catch { throw "Receipt ledger contains invalid JSON: $($receiptPath.Name)" }
    Assert-ExactProperties $receipt @("schemaVersion", "jobId", "state", "createdAt", "agent", "machine", "message", "evidence") "Receipt has missing or unknown fields: $($receiptPath.Name)"
    Assert-True ($receipt.schemaVersion -ceq "1.0" -and $receipt.jobId -ceq $ExpectedJob) "Receipt ledger contains the wrong schema/job identity."
    Assert-True ($receipt.state -cin @("RECEIVED_VERIFIED", "RUNNING", "UPLOADING", "COMPLETED", "BLOCKED", "FAILED")) "Receipt has an unknown state."
    Assert-True ($fileState.ToUpperInvariant() -ceq [string]$receipt.state) "Receipt filename state disagrees with its JSON state."
    $created = [DateTimeOffset]::MinValue
    $parsed = [DateTimeOffset]::TryParseExact(
      [string]$receipt.createdAt,
      "o",
      [Globalization.CultureInfo]::InvariantCulture,
      [Globalization.DateTimeStyles]::RoundtripKind,
      [ref]$created
    )
    Assert-True ($parsed -and $created.Offset -eq [TimeSpan]::Zero) "Receipt createdAt is not an exact UTC round-trip timestamp."
    Assert-True ($created.UtcDateTime.ToString("yyyyMMddTHHmmssZ") -ceq $fileStamp) "Receipt filename timestamp disagrees with createdAt."
    Assert-True ($seenTicks.Add($created.UtcDateTime.Ticks)) "Two receipts have indistinguishable createdAt timestamps; ordering is ambiguous."
    $relative = "receipts/from-4060/$ExpectedJob/$($receiptPath.Name)"
    & git -C $Checkout ls-files --error-unmatch -- $relative | Out-Null
    Assert-True ($LASTEXITCODE -eq 0) "Receipt is not tracked locally: $relative"
    $entries += [pscustomobject]@{ Created = $created; State = [string]$receipt.state; Evidence = @($receipt.evidence); RelativePath = $relative }
  }
  $ordered = @($entries | Sort-Object @{ Expression = { $_.Created.UtcDateTime.Ticks } })
  Assert-True ($ordered.Count -ge 2 -and $ordered[0].State -ceq "RECEIVED_VERIFIED") "Receipt ledger must begin with RECEIVED_VERIFIED."
  for ($index = 1; $index -lt $ordered.Count; $index++) {
    $previous = [string]$ordered[$index - 1].State
    $current = [string]$ordered[$index].State
    $allowedNext = switch ($previous) {
      "RECEIVED_VERIFIED" { @("RUNNING", "BLOCKED", "FAILED") }
      "RUNNING" { @("UPLOADING", "BLOCKED", "FAILED") }
      "UPLOADING" { @("COMPLETED", "BLOCKED", "FAILED") }
      "BLOCKED" { @("RUNNING") }
      "FAILED" { @("RUNNING") }
      "COMPLETED" { @() }
      default { @() }
    }
    Assert-True ($allowedNext -ccontains $current) "Receipt transition is invalid: $previous -> $current."
  }
  Assert-True ($ordered[-1].State -cin @("RUNNING", "UPLOADING", "COMPLETED")) "Latest receipt is an unresolved failure/blocker."
  return $ordered
}

function Assert-ReceiptLedgerOnOrigin([string]$Checkout, $Ledger) {
  foreach ($entry in @($Ledger)) { $null = Assert-TrackedOnOriginMain $Checkout ([string]$entry.RelativePath) }
}

function Assert-ReceiptHashes($Receipt, [string]$JsonSha, [string]$MarkdownSha, [string]$ExpectedState) {
  Assert-True ($Receipt.State -ceq $ExpectedState) "Receipt state mismatch while verifying published hashes."
  $evidence = @($Receipt.Evidence | ForEach-Object { [string]$_ })
  Assert-True ($evidence -ccontains "result_sha256:$JsonSha") "Receipt does not bind the exact V15-RESULT.json SHA256."
  Assert-True ($evidence -ccontains "report_sha256:$MarkdownSha") "Receipt does not bind the exact V15-REPORT.md SHA256."
}

function Assert-SafeReportText([string]$Text) {
  $secretPattern = '(?i)(github_pat_|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-|authorization\s*[:=]\s*bearer|api[_-]?key\s*[:=]|-----BEGIN [^-]*(PRIVATE|OPENSSH) KEY-----)'
  $absolutePathPattern = '(?i)([A-Z]:\\|\\\\[^\\]+\\|/(home|Users|private|mnt)/)'
  if ($Text -match $secretPattern) { throw "Refusing to publish a secret-like value." }
  if ($Text -match $absolutePathPattern) { throw "Refusing to publish a local absolute path." }
  if ($Text.Length -gt 1000000) { throw "Safe report exceeds the 1 MB boundary." }
}

function Write-Utf8Atomic([string]$Path, [string]$Text) {
  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = "$Path.tmp-$([guid]::NewGuid().ToString('N'))"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($temporary, $Text, $utf8NoBom)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

$publicationMutex = New-Object System.Threading.Mutex($false, "Local\MaxAgentBridge-UNSEEN-v15-VisualPublisher")
$publicationMutexHeld = $false
try {
  try { $publicationMutexHeld = $publicationMutex.WaitOne(0) }
  catch [System.Threading.AbandonedMutexException] { $publicationMutexHeld = $true }
  if (-not $publicationMutexHeld) {
    throw "Another v15 visual publisher is active. Wait for it to finish; no duplicate receipt was written."
  }

foreach ($gate in @($ConfirmPublish, $WalkPass, $ZoomInOutPass, $HorizonLevelPass, $SixDirectionsPass, $ThreePhotoAnchorsPass, $NoPageErrors)) {
  if (-not $gate.IsPresent) {
    throw "All explicit visual gates and -ConfirmPublish are required. Nothing was changed or published."
  }
}

$BridgeCheckout = (Resolve-Path -LiteralPath $BridgeCheckout).Path
Assert-True (Test-Path -LiteralPath (Join-Path $BridgeCheckout ".git")) "BridgeCheckout is not a Git checkout."
$resolvedTop = ([string]@(& git -C $BridgeCheckout rev-parse --show-toplevel)[-1]).Trim()
Assert-True ($LASTEXITCODE -eq 0 -and (Resolve-Path -LiteralPath $resolvedTop).Path -ceq $BridgeCheckout) "BridgeCheckout is not the exact Git worktree root."
$branch = ([string]@(& git -C $BridgeCheckout symbolic-ref --quiet --short HEAD)[-1]).Trim()
Assert-True ($LASTEXITCODE -eq 0 -and $branch -ceq "main") "Bridge checkout must be on the main branch, not detached or on another branch."
$originUrl = ([string]@(& git -C $BridgeCheckout remote get-url origin)[-1]).Trim()
Assert-True ($LASTEXITCODE -eq 0 -and (Get-CanonicalGitHubRepo $originUrl) -ceq "maxi-max-dev/max-agent-bridge") "Bridge origin is not the exact private max-agent-bridge repository."
Invoke-Checked { gh auth status --hostname github.com } "GitHub authentication failed."
$isPrivate = (gh repo view maxi-max-dev/max-agent-bridge --json isPrivate --jq '.isPrivate').Trim().ToLowerInvariant()
Assert-True ($LASTEXITCODE -eq 0 -and $isPrivate -eq "true") "The Bridge repository was not confirmed private."

$allowed = @($relativeJson, $relativeMarkdown)
Assert-AllowedWorktree $BridgeCheckout $allowed
Invoke-Checked { git -C $BridgeCheckout pull --rebase --autostash origin main } "Bridge synchronization failed. The two reports were not discarded; resolve the checkout and retry."
Assert-AllowedWorktree $BridgeCheckout $allowed

$taskPath = Join-Path $BridgeCheckout "jobs\to-4060\$job\TASK.json"
$jsonPath = Join-Path $BridgeCheckout ($relativeJson -replace '/', '\')
$markdownPath = Join-Path $BridgeCheckout ($relativeMarkdown -replace '/', '\')
Assert-SafeReportPath $BridgeCheckout $jsonPath
Assert-SafeReportPath $BridgeCheckout $markdownPath
Assert-True (Test-Path -LiteralPath $taskPath -PathType Leaf) "Current v15 TASK.json is missing."
Assert-True (Test-Path -LiteralPath $jsonPath -PathType Leaf) "Automated V15-RESULT.json is missing; run the full canary first."
foreach ($path in @($taskPath, $jsonPath)) {
  $item = Get-Item -LiteralPath $path -Force
  Assert-True (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) "A task/report path is a reparse point."
  Assert-True ($item.Length -gt 0 -and $item.Length -le 1000000) "A task/report file is empty or too large."
}
try {
  $task = Get-Content -Raw -LiteralPath $taskPath -Encoding UTF8 | ConvertFrom-Json
  $result = Get-Content -Raw -LiteralPath $jsonPath -Encoding UTF8 | ConvertFrom-Json
} catch {
  throw "TASK/result JSON could not be parsed: $($_.Exception.Message)"
}

Assert-ExactProperties $result @(
  "schemaVersion", "jobId", "canaryRunId", "generatedAtUnix", "state", "overallProductGoal",
  "productionConnected", "release", "input", "gpu", "scene", "viewerHttp", "photoAnchorHttp",
  "viewerVisual", "photoLocalizations", "workerRecovery", "security"
) "Automated V15-RESULT.json has missing or unknown top-level fields."
Assert-ExactProperties $result.release @(
  "releaseTag", "assetName", "assetSha256", "assetBytes", "controlCommit",
  "payloadManifestSha256", "payloadFileCount", "runtimeFingerprintSha256"
) "Automated result release evidence has missing or unknown fields."
Assert-ExactProperties $result.input @("kind", "bytes", "sha256", "authorPosePassedToProduct") "Automated input evidence has missing or unknown fields."
Assert-ExactProperties $result.gpu @("name", "driver", "memoryMiB", "torch", "torchCuda", "torchCudaAvailable") "GPU evidence has missing or unknown fields."
Assert-ExactProperties $result.scene @(
  "sceneId", "sceneRevisionId", "jobId", "jobAttempts", "duplicateUploadReturnedSameSceneId",
  "duplicateStartReturnedSameJobId", "registeredViews", "registeredDirections", "registeredTimeIndices",
  "colmapModelCounts", "trainingIterations", "trainingResumedFromStep", "trainingLastAttemptWallSeconds",
  "trainingLastAttemptPeakVramMiB", "oom", "checkpointBytes", "checkpointSha256", "plyBytes",
  "plySha256", "sogBytes", "sogSha256"
) "Scene evidence has missing or unknown fields."
Assert-ExactProperties $result.viewerHttp @(
  "entryHttpStatus", "headHttpStatus", "rangeHttpStatus", "rangeBytes", "invalidRangeHttpStatus",
  "fullDownloadHttpStatus", "fullDownloadBytes", "fullDownloadSha256"
) "Viewer HTTP evidence has missing or unknown fields."
Assert-ExactProperties $result.photoAnchorHttp @("verifiedAnchors", "rows") "Photo anchor HTTP evidence has missing or unknown fields."
Assert-ExactProperties $result.viewerVisual @(
  "state", "walk", "zoomInOut", "horizonLevel", "sixDirections", "threePhotoAnchors",
  "pageErrors", "viewerFps", "checkedAt", "checkedBy"
) "Viewer visual evidence has missing or unknown fields."
Assert-ExactProperties $result.workerRecovery @(
  "state", "victimJobId", "beforeAttempts", "victimAttempts", "oldWorkerPid", "newWorkerPid",
  "oldRunnerPgid", "leaseTtlSeconds", "oldLeaseExpiresUnix", "reLeasedAtUnix",
  "oldLeaseOwnerSha256", "newLeaseOwnerSha256", "leaseOwnerChanged"
) "Worker recovery evidence has missing or unknown fields."
Assert-ExactProperties $result.security @(
  "listener", "bridgeFilesWritten", "reportBoundaryValidated", "productionConnectionRequestedByCanary"
) "Security evidence has missing or unknown fields."
Assert-ExactProperties $result.security.listener @("state", "port", "addresses") "Listener evidence has missing or unknown fields."
foreach ($row in @($result.photoAnchorHttp.rows)) {
  Assert-ExactProperties $row @("anchorId", "pageHttpStatus", "manifestHttpStatus") "Photo anchor HTTP row has missing or unknown fields."
}
foreach ($photo in @($result.photoLocalizations)) {
  Assert-ExactProperties $photo @("jobId", "state", "attempts", "inputSha256", "groundTruthRead", "hardcodedPoseUsed", "registrationQuality", "anchor") "Photo localization has missing or unknown fields."
  Assert-ExactProperties $photo.anchor @("id", "sceneRevisionId", "position", "quaternion", "fov") "Photo anchor has missing or unknown fields."
  Assert-ExactProperties $photo.registrationQuality @(
    "geometricInliers", "geometricInlierRatio", "medianReprojectionPx", "maxReprojectionPx", "queryKeypoints",
    "inlierRatioDefinition", "gatePassed", "existingFramesFixed", "registrationImageList",
    "referenceFramesInIsolatedDatabase", "colmapGpuRequested", "colmapFeatureMode", "localDatabaseIsolation",
    "referenceFramesCompared", "referenceFramesWhitelisted", "maxReferenceRotationDelta",
    "maxReferencePositionDelta", "referenceGaugeTolerance", "onlyQueryAdded", "thresholds"
  ) "Photo registration quality has missing or unknown fields."
  Assert-ExactProperties $photo.registrationQuality.thresholds @(
    "minGeometricInliers", "minGeometricInlierRatio", "maxMedianReprojectionPx"
  ) "Photo registration thresholds have missing or unknown fields."
  Assert-ExactProperties $photo.registrationQuality.localDatabaseIsolation @(
    "sourceDatabaseCopied", "sourceDatabaseSha256", "baseReferenceImages", "removedNonModelImages",
    "removedOutOfModelPairRows", "onlyQueryUnregistered", "queryDatabaseImageId", "databaseImageCountAfterQuery"
  ) "Photo local database isolation has missing or unknown fields."
}

Assert-True ($task.jobId -ceq $job -and $task.state -ceq "PUBLISHED") "Current task identity/state failed."
$receiptRoot = Join-Path $BridgeCheckout "receipts\from-4060\$job"
Assert-True (Test-Path -LiteralPath $receiptRoot -PathType Container) "No v15 receipt ledger exists."
$receiptLedger = @(Get-ReceiptLedger $BridgeCheckout $receiptRoot $job)
$latestReceiptState = [string]$receiptLedger[-1].State
Assert-True ($result.schemaVersion -ceq "1.0" -and $result.jobId -ceq $job) "Automated result identity failed."
Assert-True ([string]$result.canaryRunId -match $safeId) "Canary run ID is invalid."
Assert-IntegerAtLeast $result.generatedAtUnix 1 "Canary generatedAtUnix is not a positive integer."
$initialResultState = [string]$result.state
Assert-True ($initialResultState -in @("RUNNING_PENDING_4060_AGENT_VISUAL", "LOCAL_PRODUCT_READY_FOR_NEW_INPUT")) "Result is not at a resumable visual publication state."
if ($initialResultState -ceq "RUNNING_PENDING_4060_AGENT_VISUAL") {
  Assert-True ($latestReceiptState -ceq "RUNNING") "A pending visual result cannot already have an UPLOADING/COMPLETED receipt."
} else {
  $priorVisual = $result.viewerVisual
  Assert-StrictBoolean $priorVisual.walk $true "Prior visual walk evidence is not the boolean true."
  Assert-StrictBoolean $priorVisual.zoomInOut $true "Prior visual zoom evidence is not the boolean true."
  Assert-StrictBoolean $priorVisual.horizonLevel $true "Prior visual horizon evidence is not the boolean true."
  Assert-StrictBoolean $priorVisual.sixDirections $true "Prior visual direction evidence is not the boolean true."
  Assert-StrictBoolean $priorVisual.threePhotoAnchors $true "Prior visual photo-anchor evidence is not the boolean true."
  Assert-IntegerAtLeast $priorVisual.pageErrors 0 "Prior visual page-error count is not an integer."
  $visualCheckedAt = [DateTimeOffset]::MinValue
  $visualTimestampParsed = [DateTimeOffset]::TryParseExact(
    [string]$priorVisual.checkedAt,
    "o",
    [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind,
    [ref]$visualCheckedAt
  )
  Assert-True (
    $priorVisual.state -ceq "PASS_4060_AGENT_VISUAL" -and
    [int]$priorVisual.pageErrors -eq 0 -and
    $null -eq $priorVisual.viewerFps -and $priorVisual.checkedBy -ceq "4060 Agent" -and
    $visualTimestampParsed -and $visualCheckedAt.Offset -eq [TimeSpan]::Zero
  ) "Ready result contains incomplete or altered prior visual evidence."
}
Assert-True ($result.overallProductGoal -ceq "ACTIVE_PENDING_NEW_UNSEEN_VIDEO_AND_3_REAL_PHOTOS") "Overall product goal was prematurely changed."
Assert-StrictBoolean $result.productionConnected $false "Production connection must be the boolean false."

$artifact = $task.artifact
$release = $result.release
Assert-True ($artifact.payloadManifestPath -ceq "MANIFEST.json") "TASK payload manifest path changed."
Assert-True ($task.receipt.repository -ceq "maxi-max-dev/max-agent-bridge" -and [int]$task.receipt.issueNumber -eq 16) "TASK receipt destination changed."
Assert-IntegerAtLeast $release.assetBytes 1 "Result asset byte count is not a positive integer."
Assert-IntegerAtLeast $release.payloadFileCount 1 "Result payload file count is not a positive integer."
Assert-True ($release.releaseTag -match $safeId -and $release.assetName -match $safeId) "Result release tag/asset name is invalid."
Assert-True ($release.releaseTag -ceq $artifact.releaseTag) "Result release tag does not match TASK.json."
Assert-True ($release.assetName -ceq $artifact.assetName) "Result asset name does not match TASK.json."
Assert-True ($release.assetSha256 -ceq $artifact.sha256 -and $release.assetSha256 -match $safeSha) "Result asset SHA256 does not match TASK.json."
Assert-True ([int64]$release.assetBytes -eq [int64]$artifact.bytes -and [int64]$release.assetBytes -gt 0) "Result asset byte count does not match TASK.json."
Assert-True ($release.payloadManifestSha256 -ceq $artifact.payloadManifestSha256 -and $release.payloadManifestSha256 -match $safeSha) "Result payload manifest SHA256 does not match TASK.json."
Assert-True ([int]$release.payloadFileCount -eq [int]$artifact.payloadFileCount -and [int]$release.payloadFileCount -gt 0) "Result payload file count does not match TASK.json."
Assert-True ($release.runtimeFingerprintSha256 -match $safeSha) "Runtime fingerprint SHA256 is missing."
Invoke-Checked { git -C $BridgeCheckout fetch --force origin "refs/tags/$($artifact.releaseTag):refs/tags/$($artifact.releaseTag)" } "Could not fetch the release tag."
$tagCommit = ([string]@(& git -C $BridgeCheckout rev-list -n 1 $artifact.releaseTag)[-1]).Trim()
Assert-True ($LASTEXITCODE -eq 0 -and $tagCommit -match '^[a-f0-9]{40}$') "Release tag target commit is invalid."
Assert-True ($release.controlCommit -ceq $tagCommit) "Result control commit is not the release tag target."

$gpu = $result.gpu
$safeTechnicalText = '^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,99}$'
Assert-True ([string]$gpu.name -match '(?i)RTX\s+4060' -and [string]$gpu.name -match $safeTechnicalText) "Automated result did not prove a safely encoded RTX 4060 name."
Assert-True ([string]$gpu.driver -match $safeTechnicalText) "GPU driver evidence is missing or unsafe."
Assert-IntegerAtLeast $gpu.memoryMiB 1 "GPU VRAM evidence did not pass."
Assert-StrictBoolean $gpu.torchCudaAvailable $true "CUDA availability must be the boolean true."
Assert-True (
  [string]$gpu.torch -match $safeTechnicalText -and
  [string]$gpu.torchCuda -match $safeTechnicalText
) "Torch/CUDA versions are missing or unsafe."
Assert-StrictBoolean $result.input.authorPosePassedToProduct $false "Author pose must not be passed to the product."
Assert-IntegerAtLeast $result.input.bytes 1 "Input byte evidence failed."
Assert-True ($result.input.kind -ceq "frozen-public-v11-panorama-sequence-as-mp4" -and $result.input.sha256 -match $safeSha) "Input lineage evidence failed."

$scene = $result.scene
Assert-True ($scene.sceneId -match $safeId -and $scene.sceneRevisionId -match $safeId -and $scene.jobId -match $safeId) "Scene/job identifiers are invalid."
foreach ($field in @("jobAttempts", "registeredViews", "registeredTimeIndices", "trainingIterations", "checkpointBytes", "plyBytes", "sogBytes")) {
  Assert-IntegerAtLeast $scene.$field 1 "Scene numeric evidence is not a positive integer: $field"
}
Assert-True ([int]$scene.registeredViews -ge 270) "Unknown-pose registration has fewer than 270 views."
$directions = @($scene.registeredDirections)
Assert-True ($directions.Count -ge 6 -and @($directions | Sort-Object -Unique).Count -ge 6) "Registration did not cover six distinct directions."
foreach ($direction in $directions) {
  Assert-True ([string]$direction -cin @("front", "front_right", "right", "back_right", "back", "back_left", "left", "front_left", "up")) "Registration contains an unknown direction."
}
Assert-True ([int]$scene.registeredTimeIndices -ge 30) "Registration lacks temporal coverage."
Assert-True ([int]$scene.trainingIterations -eq 7000) "The preview did not use the frozen 7k profile."
Assert-StrictBoolean $scene.oom $false "The preview OOM evidence must be the boolean false."
Assert-True ([double]$scene.trainingLastAttemptWallSeconds -gt 0 -and [int]$scene.trainingLastAttemptPeakVramMiB -gt 0) "Measured training wall-time/VRAM evidence is missing."
Assert-FiniteNumberRange $scene.trainingLastAttemptWallSeconds ([double]::Epsilon) ([double]::MaxValue) "Training wall time must be a positive finite number."
Assert-IntegerAtLeast $scene.trainingLastAttemptPeakVramMiB 1 "Training peak VRAM must be a positive integer."
if ($null -ne $scene.trainingResumedFromStep) {
  Assert-IntegerAtLeast $scene.trainingResumedFromStep 0 "Training resume step must be a non-negative integer or null."
  Assert-True ([int]$scene.trainingResumedFromStep -lt 7000) "Training resume step must be below 7000."
}
$modelNames = @($scene.colmapModelCounts.PSObject.Properties.Name)
Assert-True ($modelNames.Count -ge 1) "COLMAP model-count evidence is empty."
foreach ($modelName in $modelNames) {
  Assert-True ([string]$modelName -match $safeId) "COLMAP model ID is invalid."
  Assert-IntegerAtLeast $scene.colmapModelCounts.$modelName 1 "COLMAP model count must be positive."
}
foreach ($prefix in @("checkpoint", "ply", "sog")) {
  $bytesProperty = $prefix + "Bytes"
  $shaProperty = $prefix + "Sha256"
  Assert-True ([int64]$scene.$bytesProperty -gt 0 -and [string]$scene.$shaProperty -match $safeSha) "Local $prefix artifact size/SHA evidence failed."
}
Assert-StrictBoolean $scene.duplicateUploadReturnedSameSceneId $true "Duplicate upload idempotency evidence failed."
Assert-StrictBoolean $scene.duplicateStartReturnedSameJobId $true "Duplicate start idempotency evidence failed."

$viewer = $result.viewerHttp
foreach ($field in @("entryHttpStatus", "headHttpStatus", "rangeHttpStatus", "rangeBytes", "invalidRangeHttpStatus", "fullDownloadHttpStatus", "fullDownloadBytes")) {
  Assert-IntegerAtLeast $viewer.$field 1 "Viewer HTTP evidence is not a positive integer: $field"
}
Assert-True ([int]$viewer.entryHttpStatus -eq 200 -and [int]$viewer.headHttpStatus -eq 200 -and [int]$viewer.rangeHttpStatus -eq 206) "Viewer entry/HEAD/range HTTP checks failed."
Assert-True ([int]$viewer.invalidRangeHttpStatus -eq 416 -and [int]$viewer.fullDownloadHttpStatus -eq 200) "Viewer invalid/full range contract failed."
Assert-True ([int64]$viewer.fullDownloadBytes -eq [int64]$scene.sogBytes -and $viewer.fullDownloadSha256 -ceq $scene.sogSha256) "Viewer-streamed SOG disagrees with the runner artifact."

$anchorHttp = $result.photoAnchorHttp
$anchorRows = @($anchorHttp.rows)
Assert-IntegerAtLeast $anchorHttp.verifiedAnchors 1 "Photo anchor count is not an integer."
Assert-True ([int]$anchorHttp.verifiedAnchors -eq 3 -and $anchorRows.Count -eq 3) "Three anchor HTTP closures were not proved."
Assert-True (@($anchorRows.anchorId | Sort-Object -Unique).Count -eq 3) "Anchor HTTP IDs are not distinct."
foreach ($row in $anchorRows) {
  Assert-IntegerAtLeast $row.pageHttpStatus 1 "Photo anchor page HTTP status is not an integer."
  Assert-IntegerAtLeast $row.manifestHttpStatus 1 "Photo anchor manifest HTTP status is not an integer."
  Assert-True ($row.anchorId -match $safeId -and [int]$row.pageHttpStatus -eq 200 -and [int]$row.manifestHttpStatus -eq 200) "An anchor Viewer HTTP proof failed."
}

$photos = @($result.photoLocalizations)
Assert-True ($photos.Count -eq 3) "Exactly three truth-free photo localizations are required."
Assert-True (@($photos.jobId | Sort-Object -Unique).Count -eq 3) "Photo job IDs are not distinct."
Assert-True (@($photos.inputSha256 | Sort-Object -Unique).Count -eq 3) "Photo inputs are not genuinely distinct."
Assert-True (@($photos.anchor.id | Sort-Object -Unique).Count -eq 3) "Photo anchor IDs are not distinct."
foreach ($photo in $photos) {
  $quality = $photo.registrationQuality
  Assert-True ($photo.jobId -match $safeId -and $photo.anchor.id -match $safeId) "Photo job/anchor identifiers are unsafe."
  Assert-IntegerAtLeast $photo.attempts 1 "Photo attempt count is not a positive integer."
  foreach ($field in @("geometricInliers", "queryKeypoints", "referenceFramesInIsolatedDatabase", "referenceFramesCompared", "referenceFramesWhitelisted")) {
    Assert-IntegerAtLeast $quality.$field 1 "Photo registration numeric evidence is not a positive integer: $field"
  }
  Assert-FiniteNumberRange $quality.geometricInlierRatio 0 1 "Photo inlier ratio is not a finite number in [0,1]."
  Assert-FiniteNumberRange $quality.medianReprojectionPx 0 ([double]::MaxValue) "Photo median reprojection error is invalid."
  Assert-FiniteNumberRange $quality.maxReprojectionPx 0 ([double]::MaxValue) "Photo maximum reprojection error is invalid."
  Assert-FiniteNumberRange $quality.maxReferenceRotationDelta 0 ([double]::MaxValue) "Reference rotation delta is invalid."
  Assert-FiniteNumberRange $quality.maxReferencePositionDelta 0 ([double]::MaxValue) "Reference position delta is invalid."
  Assert-FiniteNumberRange $quality.referenceGaugeTolerance ([double]::Epsilon) ([double]::MaxValue) "Reference gauge tolerance is invalid."
  Assert-True ($photo.state -ceq "ready" -and [int]$photo.attempts -ge 1 -and $photo.inputSha256 -match $safeSha) "A photo job did not finish with valid lineage."
  Assert-StrictBoolean $photo.groundTruthRead $false "A photo localization read forbidden ground truth."
  Assert-StrictBoolean $photo.hardcodedPoseUsed $false "A photo localization used a hard-coded pose."
  Assert-True ($photo.anchor.sceneRevisionId -ceq $scene.sceneRevisionId) "A photo anchor belongs to another scene revision."
  Assert-StrictBoolean $quality.gatePassed $true "A photo localization quality gate did not pass."
  Assert-StrictBoolean $quality.existingFramesFixed $true "Existing reference frames were not held fixed."
  Assert-StrictBoolean $quality.onlyQueryAdded $true "Photo localization did not add only the query."
  Assert-StrictBoolean $quality.colmapGpuRequested $false "Photo localization must use the frozen CPU-headless COLMAP contract."
  Assert-True ($quality.colmapFeatureMode -ceq "cpu-headless") "Photo localization feature mode changed."
  Assert-True ([int]$quality.geometricInliers -ge 20 -and [double]$quality.geometricInlierRatio -ge 0.10 -and [double]$quality.medianReprojectionPx -le 3.5) "A photo localization quality threshold failed."
  Assert-True ($quality.inlierRatioDefinition -ceq "registered-3d-observations/query-keypoints") "Photo inlier-ratio semantics changed."
  $thresholds = $quality.thresholds
  Assert-IntegerAtLeast $thresholds.minGeometricInliers 1 "Minimum geometric inliers is not a positive integer."
  Assert-FiniteNumberRange $thresholds.minGeometricInlierRatio 0 1 "Minimum inlier ratio is invalid."
  Assert-FiniteNumberRange $thresholds.maxMedianReprojectionPx 0 ([double]::MaxValue) "Maximum median reprojection threshold is invalid."
  Assert-True (
    [int]$thresholds.minGeometricInliers -eq 20 -and
    [double]$thresholds.minGeometricInlierRatio -eq 0.1 -and
    [double]$thresholds.maxMedianReprojectionPx -eq 3.5
  ) "Photo localization thresholds changed from the frozen v15 contract."
  $isolation = $quality.localDatabaseIsolation
  Assert-StrictBoolean $isolation.sourceDatabaseCopied $true "Photo source database was not copied into an isolated database."
  Assert-StrictBoolean $isolation.onlyQueryUnregistered $true "Isolated database did not keep only the query unregistered."
  Assert-True ($isolation.sourceDatabaseSha256 -match $safeSha) "Isolated source database SHA256 is missing."
  Assert-IntegerAtLeast $isolation.baseReferenceImages 1 "Isolated database has no base reference images."
  Assert-IntegerAtLeast $isolation.queryDatabaseImageId 1 "Isolated query image ID is invalid."
  Assert-IntegerAtLeast $isolation.removedNonModelImages 0 "Removed non-model image count is invalid."
  Assert-IntegerAtLeast $isolation.removedOutOfModelPairRows 0 "Removed out-of-model pair count is invalid."
  Assert-IntegerAtLeast $isolation.databaseImageCountAfterQuery 2 "Isolated database image count is invalid."
  Assert-True (
    [int]$quality.referenceFramesCompared -eq [int]$quality.referenceFramesInIsolatedDatabase -and
    [int]$quality.referenceFramesWhitelisted -eq [int]$quality.referenceFramesInIsolatedDatabase -and
    [int]$isolation.baseReferenceImages -eq [int]$quality.referenceFramesInIsolatedDatabase -and
    [int]$isolation.databaseImageCountAfterQuery -eq ([int]$quality.referenceFramesInIsolatedDatabase + 1)
  ) "Photo localization did not prove the exact references-plus-one-query database boundary."
  Assert-True (
    [double]$quality.maxReferenceRotationDelta -le [double]$quality.referenceGaugeTolerance -and
    [double]$quality.maxReferencePositionDelta -le [double]$quality.referenceGaugeTolerance
  ) "Reference frames moved beyond the frozen gauge tolerance."
  $registrationImages = @($quality.registrationImageList)
  Assert-True ($registrationImages.Count -eq 1 -and [string]$registrationImages[0] -match '^query\.(jpg|jpeg|png)$') "Registration image list is not query-only."
  foreach ($vectorName in @("position", "quaternion")) {
    $expectedCount = if ($vectorName -ceq "position") { 3 } else { 4 }
    $vector = @($photo.anchor.$vectorName)
    Assert-True ($vector.Count -eq $expectedCount) "Photo anchor $vectorName has the wrong length."
    foreach ($component in $vector) {
      Assert-FiniteNumberRange $component (-[double]::MaxValue) ([double]::MaxValue) "Photo anchor $vectorName contains a non-finite number."
    }
  }
  $quaternion = @($photo.anchor.quaternion)
  $quaternionNormSquared = 0.0
  foreach ($component in $quaternion) { $quaternionNormSquared += ([double]$component * [double]$component) }
  Assert-True ([Math]::Abs([Math]::Sqrt($quaternionNormSquared) - 1.0) -le 0.001) "Photo anchor quaternion is not normalized."
  Assert-FiniteNumberRange $photo.anchor.fov 1 179 "Photo anchor FOV is invalid."
}
$httpAnchorIds = @($anchorRows.anchorId | Sort-Object)
$photoAnchorIds = @($photos.anchor.id | Sort-Object)
Assert-True ($httpAnchorIds.Count -eq $photoAnchorIds.Count) "Viewer HTTP anchors and localized-photo anchors have different counts."
for ($anchorIndex = 0; $anchorIndex -lt $photoAnchorIds.Count; $anchorIndex++) {
  Assert-True ([string]$httpAnchorIds[$anchorIndex] -ceq [string]$photoAnchorIds[$anchorIndex]) "Viewer HTTP anchors do not exactly match localized-photo anchors."
}

$recovery = $result.workerRecovery
Assert-True ($recovery.state -ceq "PASS_LEASE_RECOVERED_SAME_JOB") "Worker kill/lease-expiry recovery did not pass."
foreach ($field in @("beforeAttempts", "victimAttempts", "oldWorkerPid", "newWorkerPid", "oldRunnerPgid", "leaseTtlSeconds")) {
  Assert-IntegerAtLeast $recovery.$field 1 "Recovery evidence is not a positive integer: $field"
}
Assert-FiniteNumberRange $recovery.oldLeaseExpiresUnix 1 ([double]::MaxValue) "Old lease expiry is invalid."
Assert-FiniteNumberRange $recovery.reLeasedAtUnix 1 ([double]::MaxValue) "Re-lease time is invalid."
Assert-True ([double]$recovery.reLeasedAtUnix -ge [double]$recovery.oldLeaseExpiresUnix) "The new lease was acquired before the old 180-second lease expired."
Assert-True ($recovery.victimJobId -ceq $scene.jobId -and [int]$recovery.leaseTtlSeconds -eq 180) "Recovery did not bind the scene job and 180-second lease."
Assert-StrictBoolean $recovery.leaseOwnerChanged $true "Recovery lease-owner change evidence is not the boolean true."
Assert-True ([int]$recovery.victimAttempts -gt [int]$recovery.beforeAttempts) "Recovery did not prove a higher attempt."
Assert-True ($recovery.oldLeaseOwnerSha256 -match $safeSha -and $recovery.newLeaseOwnerSha256 -match $safeSha -and $recovery.oldLeaseOwnerSha256 -cne $recovery.newLeaseOwnerSha256) "Recovery owner hashes are invalid."

$security = $result.security
Assert-IntegerAtLeast $security.listener.port 1 "Listener port evidence is not an integer."
Assert-True ($security.listener.state -ceq "PASS_LOOPBACK_ONLY" -and [int]$security.listener.port -eq 8780) "Loopback listener evidence failed."
$listenerAddresses = @($security.listener.addresses)
Assert-True ($listenerAddresses.Count -ge 1 -and $listenerAddresses.Count -le 2) "Loopback listener evidence contains no address or too many addresses."
foreach ($address in $listenerAddresses) { Assert-True ($address -in @("127.0.0.1", "::1")) "A non-loopback listener was reported." }
Assert-StrictBoolean $security.reportBoundaryValidated $true "Report boundary validation evidence is not the boolean true."
Assert-StrictBoolean $security.productionConnectionRequestedByCanary $false "The canary requested a production connection."
$bridgeFiles = @($security.bridgeFilesWritten)
Assert-True ($bridgeFiles.Count -eq 2 -and $bridgeFiles -ccontains "V15-RESULT.json" -and $bridgeFiles -ccontains "V15-REPORT.md") "Canary wrote files outside its two-file report allowlist."

$checkedAt = if ($initialResultState -ceq "LOCAL_PRODUCT_READY_FOR_NEW_INPUT") {
  [string]$result.viewerVisual.checkedAt
} else {
  (Get-Date).ToUniversalTime().ToString("o")
}
if ($initialResultState -ceq "RUNNING_PENDING_4060_AGENT_VISUAL") {
  $result.viewerVisual = [ordered]@{
    state = "PASS_4060_AGENT_VISUAL"
    walk = $true
    zoomInOut = $true
    horizonLevel = $true
    sixDirections = $true
    threePhotoAnchors = $true
    pageErrors = 0
    viewerFps = $null
    checkedAt = $checkedAt
    checkedBy = "4060 Agent"
  }
}
$result.state = "LOCAL_PRODUCT_READY_FOR_NEW_INPUT"
$result.overallProductGoal = "ACTIVE_PENDING_NEW_UNSEEN_VIDEO_AND_3_REAL_PHOTOS"

$compactRegistration = @($photos | ForEach-Object {
  "job=$($_.jobId),inliers=$($_.registrationQuality.geometricInliers),ratio=$($_.registrationQuality.geometricInlierRatio),medianPx=$($_.registrationQuality.medianReprojectionPx)"
}) -join "; "
$jsonText = (($result | ConvertTo-Json -Depth 30) -replace "`r`n", "`n" -replace "`r", "`n")
$jsonText = ($jsonText -replace "`n*\z", "") + "`n"
$markdownText = @"
# V15 4060 Accepted Canary Report

- Canary run: ``$($result.canaryRunId)``
- State: ``LOCAL_PRODUCT_READY_FOR_NEW_INPUT``
- Overall product goal: ``ACTIVE_PENDING_NEW_UNSEEN_VIDEO_AND_3_REAL_PHOTOS``
- Production connected: ``false``
- Release: ``$($release.releaseTag)`` / ``$($release.assetName)`` / asset ``$($release.assetSha256)`` / manifest ``$($release.payloadManifestSha256)`` / control ``$($release.controlCommit)`` / runtime ``$($release.runtimeFingerprintSha256)``
- GPU: ``$($gpu.name)`` / driver ``$($gpu.driver)`` / ``$($gpu.memoryMiB)`` MiB; Torch ``$($gpu.torch)`` / CUDA ``$($gpu.torchCuda)``
- Input: ``$($result.input.kind)`` / ``$($result.input.bytes)`` bytes / ``$($result.input.sha256)``; author pose passed ``false``

## Automated gates

- Unknown-pose registration: ``$($scene.registeredViews)/450``; directions ``$($directions -join ',')``; time indices ``$($scene.registeredTimeIndices)``
- Training: ``7000`` iterations; last attempt ``$($scene.trainingLastAttemptWallSeconds)`` seconds; peak ``$($scene.trainingLastAttemptPeakVramMiB)`` MiB; OOM ``false``
- Local-only artifacts: checkpoint ``$($scene.checkpointBytes)`` bytes / ``$($scene.checkpointSha256)``; PLY ``$($scene.plyBytes)`` bytes / ``$($scene.plySha256)``; SOG ``$($scene.sogBytes)`` bytes / ``$($scene.sogSha256)``
- Viewer HTTP: entry/head/full ``200``; range ``206``; invalid range ``416``; streamed SOG bytes/SHA agree
- Idempotency: duplicate video reused scene ``true``; duplicate start reused job ``true``
- Worker recovery: killed in-flight worker; same job re-leased only after 180-second expiry; attempt increased; lease owner changed; final state ready
- Truth-free photo localizations: $compactRegistration
- Security: loopback only; no production call; two-file report allowlist passed

## 4060 Agent visual gate

- Walk in space: ``PASS``
- Zoom in and out: ``PASS``
- Horizon/orientation: ``PASS``
- Six directions understandable: ``PASS``
- Three distinct photo anchors return independently: ``PASS``
- Page/console errors during the check: ``0``
- Browser FPS: ``null`` (not measured; not fabricated)
- Checked at: ``$checkedAt``

This accepts the isolated v15 fixture canary only. The overall goal remains active until a post-release, previously unused real 360 video and three genuinely distinct real photos pass the same end-to-end product path. No video, frame, photo, SOG, PLY, checkpoint, database, weight, token, ``.env`` or work directory was uploaded.
"@
$markdownText = ($markdownText -replace "`r`n", "`n" -replace "`r", "`n")
$markdownText = ($markdownText -replace "`n*\z", "") + "`n"
Assert-SafeReportText $jsonText
Assert-SafeReportText $markdownText

Write-Utf8Atomic $jsonPath $jsonText
Write-Utf8Atomic $markdownPath $markdownText

Assert-AllowedWorktree $BridgeCheckout $allowed

$submit = Join-Path $BridgeCheckout "scripts\windows\Submit-BridgeReceipt.ps1"
Assert-True (Test-Path -LiteralPath $submit -PathType Leaf) "Submit-BridgeReceipt.ps1 is missing."
$jsonSha = (Get-FileHash -LiteralPath $jsonPath -Algorithm SHA256).Hash.ToLowerInvariant()
$markdownSha = (Get-FileHash -LiteralPath $markdownPath -Algorithm SHA256).Hash.ToLowerInvariant()
$jsonBlob = Get-CurrentBlobOid $BridgeCheckout $relativeJson
$markdownBlob = Get-CurrentBlobOid $BridgeCheckout $relativeMarkdown
$expectedReportBlobs = @{
  $relativeJson = $jsonBlob
  $relativeMarkdown = $markdownBlob
}
if ($latestReceiptState -in @("UPLOADING", "COMPLETED")) {
  Assert-ReceiptHashes $receiptLedger[-1] $jsonSha $markdownSha $latestReceiptState
}
$receiptPrefix = "receipts/from-4060/$job/"
Assert-Issue16Open
Publish-AllowedLocalAhead $BridgeCheckout $allowed $receiptPrefix $expectedReportBlobs
Assert-ReceiptLedgerOnOrigin $BridgeCheckout $receiptLedger
if ($latestReceiptState -ceq "COMPLETED") {
  $reportChanges = @(& git -C $BridgeCheckout status --porcelain=v1 --untracked-files=all -- $relativeJson $relativeMarkdown)
  Assert-True ($LASTEXITCODE -eq 0 -and $reportChanges.Count -eq 0) "A COMPLETED ledger exists, but the safe reports differ locally."
  Invoke-Checked { git -C $BridgeCheckout fetch origin main } "Could not refresh origin/main while verifying completed publication."
  $null = Assert-TrackedOnOriginMain $BridgeCheckout $relativeJson
  $null = Assert-TrackedOnOriginMain $BridgeCheckout $relativeMarkdown
  Assert-RemoteBlob $BridgeCheckout $relativeJson $jsonBlob
  Assert-RemoteBlob $BridgeCheckout $relativeMarkdown $markdownBlob
  Assert-Issue16Open
  Write-Host "LOCAL_PRODUCT_READY_FOR_NEW_INPUT was already published with exact remote hashes. Issue #16 remains open for the new-video final gate."
  $global:LASTEXITCODE = 0
  return
}
if ($latestReceiptState -ceq "RUNNING") {
  Assert-Issue16Open
  & $submit -RepoDir $BridgeCheckout -JobId $job -State "UPLOADING" -Message "All automated and explicit 4060 visual gates passed; publishing only the two redacted v15 report files." -Evidence @("result_sha256:$jsonSha", "report_sha256:$markdownSha", "state:LOCAL_PRODUCT_READY_FOR_NEW_INPUT")
  if ($LASTEXITCODE -ne 0) { throw "UPLOADING receipt failed; report files remain local and the goal stays open." }
  Invoke-Checked { git -C $BridgeCheckout fetch origin main } "UPLOADING was committed locally but origin/main could not be refreshed."
  $receiptLedger = @(Get-ReceiptLedger $BridgeCheckout $receiptRoot $job)
  $latestReceiptState = [string]$receiptLedger[-1].State
  Assert-ReceiptLedgerOnOrigin $BridgeCheckout $receiptLedger
  Assert-ReceiptHashes $receiptLedger[-1] $jsonSha $markdownSha "UPLOADING"
}

$reportChanges = @(& git -C $BridgeCheckout status --porcelain=v1 --untracked-files=all -- $relativeJson $relativeMarkdown)
if ($reportChanges.Count -gt 0) {
  Invoke-Checked { git -C $BridgeCheckout add -- $relativeJson $relativeMarkdown } "Could not stage the two safe reports."
  $staged = @(& git -C $BridgeCheckout diff --cached --name-only)
  Assert-True ($LASTEXITCODE -eq 0 -and $staged.Count -ge 1) "No safe report change was staged."
  foreach ($stagedPath in $staged) {
    Assert-True ($allowed -ccontains ([string]$stagedPath).Replace('\', '/')) "Git index contains something other than the two safe reports."
  }
  Invoke-Checked { git -C $BridgeCheckout -c user.name="4060 Agent" -c user.email="4060-agent@users.noreply.github.com" commit --only -m "result($job): accept isolated v15 canary" -- $relativeJson $relativeMarkdown } "Could not commit the two safe reports."
  & git -C $BridgeCheckout push origin HEAD:main
  if ($LASTEXITCODE -ne 0) {
    Invoke-Checked { git -C $BridgeCheckout pull --rebase origin main } "Report commit exists locally, but rebase failed."
    Invoke-Checked { git -C $BridgeCheckout push origin HEAD:main } "Report commit exists locally, but push failed again."
  }
} else {
  Invoke-Checked { git -C $BridgeCheckout ls-files --error-unmatch -- $relativeJson $relativeMarkdown } "No report changes exist, but the two reports are not both tracked."
}
Invoke-Checked { git -C $BridgeCheckout fetch origin main } "Safe reports may exist locally, but origin/main could not be refreshed."
$jsonCommit = Assert-TrackedOnOriginMain $BridgeCheckout $relativeJson
$markdownCommit = Assert-TrackedOnOriginMain $BridgeCheckout $relativeMarkdown
Assert-True ($jsonCommit -ceq $markdownCommit) "The two accepted report files are not bound to the same remote commit."
Assert-RemoteBlob $BridgeCheckout $relativeJson $jsonBlob
Assert-RemoteBlob $BridgeCheckout $relativeMarkdown $markdownBlob
Assert-True ((Get-FileHash -LiteralPath $jsonPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $jsonSha) "V15-RESULT.json changed during publication."
Assert-True ((Get-FileHash -LiteralPath $markdownPath -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $markdownSha) "V15-REPORT.md changed during publication."
if ($latestReceiptState -ne "COMPLETED") {
  Assert-Issue16Open
  & $submit -RepoDir $BridgeCheckout -JobId $job -State "COMPLETED" -Message "Isolated v15 canary accepted and reports published; the overall goal remains active for one new 360 video plus three distinct real photos." -Evidence @("result_sha256:$jsonSha", "report_sha256:$markdownSha", "report_commit:$jsonCommit", "overall:ACTIVE_PENDING_NEW_UNSEEN_VIDEO_AND_3_REAL_PHOTOS")
  if ($LASTEXITCODE -ne 0) { throw "Reports were pushed, but the COMPLETED receipt failed. Retry that receipt; do not call the overall product complete." }
}
Invoke-Checked { git -C $BridgeCheckout fetch origin main } "COMPLETED may exist locally, but origin/main could not be refreshed."
$receiptLedger = @(Get-ReceiptLedger $BridgeCheckout $receiptRoot $job)
Assert-True ($receiptLedger[-1].State -ceq "COMPLETED") "Remote receipt ledger did not reach COMPLETED."
Assert-ReceiptLedgerOnOrigin $BridgeCheckout $receiptLedger
Assert-ReceiptHashes $receiptLedger[-1] $jsonSha $markdownSha "COMPLETED"
Assert-Issue16Open
Write-Host "LOCAL_PRODUCT_READY_FOR_NEW_INPUT published. Issue #16 remains open for the new-video final gate."
$global:LASTEXITCODE = 0
} finally {
  if ($publicationMutexHeld) { $publicationMutex.ReleaseMutex() }
  $publicationMutex.Dispose()
}
