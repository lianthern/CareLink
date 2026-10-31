[CmdletBinding()]
param(
    [switch]$ConfirmPersistentGoal,
    [switch]$SetupOnly,
    [switch]$FirstMethodOnly,
    [switch]$SkipFirstMethod,
    [switch]$LearnedMethodOnly,
    [string]$WslDistro = "Ubuntu-22.04",
    [ValidatePattern('^/home/[^/]+/.+$')]
    [string]$ProjectRoot = "/home/max/src/unseen-3dgs-sceneworker"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $ConfirmPersistentGoal) {
    throw "Read GOAL.md and ACCEPTANCE.md, then rerun with -ConfirmPersistentGoal."
}
if ($SetupOnly -and ($FirstMethodOnly -or $SkipFirstMethod -or $LearnedMethodOnly)) {
    throw "SetupOnly cannot be combined with a method-selection switch."
}
if ($LearnedMethodOnly -and ($FirstMethodOnly -or $SkipFirstMethod)) {
    throw "LearnedMethodOnly cannot be combined with another method-selection switch."
}
if ($FirstMethodOnly -and $SkipFirstMethod) {
    throw "FirstMethodOnly and SkipFirstMethod are mutually exclusive."
}
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "WSL is required. This script does not install or modify WSL."
}

$linuxDir = Join-Path (Split-Path -Parent $PSScriptRoot) "linux"
$runScript = Join-Path $linuxDir "Run-V14-Goal-Setup.sh"
$starterScript = Join-Path $linuxDir "Run-V14-Sift-Track-V1.sh"
$retrievalScript = Join-Path $linuxDir "Run-V14-Verified-Retrieval-V1.sh"
$learnedScript = Join-Path $linuxDir "Run-V14-Aliked-LightGlue-V1.sh"
if (-not (Test-Path -LiteralPath $runScript -PathType Leaf)) {
    throw "Missing v14 Linux setup launcher: $runScript"
}
if (-not (Test-Path -LiteralPath $starterScript -PathType Leaf)) {
    throw "Missing v14 SIFT track starter: $starterScript"
}
if (-not (Test-Path -LiteralPath $retrievalScript -PathType Leaf)) {
    throw "Missing v14 verified retrieval fallback: $retrievalScript"
}
if (-not (Test-Path -LiteralPath $learnedScript -PathType Leaf)) {
    throw "Missing v14 ALIKED+LightGlue method: $learnedScript"
}
$escapedRunScript = $runScript.Replace('\', '\\')
$wslRunScript = (& wsl.exe -d $WslDistro -- wslpath -u -a $escapedRunScript).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslRunScript) {
    throw "Could not translate the v14 setup launcher into WSL."
}

& wsl.exe -d $WslDistro -- bash $wslRunScript --confirm-persistent-goal --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) {
    throw "v14 goal setup failed. Preserve evidence, repair setup, and continue; do not claim the localization goal is blocked."
}

if ($SetupOnly) {
    Write-Host "v14 truth-free challenge is ready. SetupOnly was requested; no localization method was run."
    exit 0
}

if ($LearnedMethodOnly) {
    $escapedLearnedScript = $learnedScript.Replace('\', '\\')
    $wslLearnedScript = (& wsl.exe -d $WslDistro -- wslpath -u -a $escapedLearnedScript).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $wslLearnedScript) {
        throw "Could not translate the v14 ALIKED+LightGlue launcher into WSL."
    }
    & wsl.exe -d $WslDistro -- bash $wslLearnedScript --confirm-learned-local-feature --project-root $ProjectRoot
    if ($LASTEXITCODE -ne 0) {
        throw "The learned v14 method did not execute cleanly. Preserve evidence, repair or change method, and continue the active goal."
    }
    Write-Host "v14 ALIKED+LightGlue evidence is ready. Run the private final gate only if STATE.json says READY_TO_RUN; otherwise continue the active Goal."
    exit 0
}

if (-not $SkipFirstMethod) {
    $escapedStarterScript = $starterScript.Replace('\', '\\')
    $wslStarterScript = (& wsl.exe -d $WslDistro -- wslpath -u -a $escapedStarterScript).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $wslStarterScript) {
        throw "Could not translate the v14 SIFT track starter into WSL."
    }
    & wsl.exe -d $WslDistro -- bash $wslStarterScript --confirm-sift-track-v1 --project-root $ProjectRoot
    if ($LASTEXITCODE -ne 0) {
        throw "The first v14 method did not execute cleanly. Preserve its evidence, repair or change method, and continue the active goal."
    }
}

if ($FirstMethodOnly) {
    Write-Host "v14 SIFT track v1 evidence is ready. FirstMethodOnly was requested; the supplied retrieval fallback was not run."
    exit 0
}

$escapedRetrievalScript = $retrievalScript.Replace('\', '\\')
$wslRetrievalScript = (& wsl.exe -d $WslDistro -- wslpath -u -a $escapedRetrievalScript).Trim()
if ($LASTEXITCODE -ne 0 -or -not $wslRetrievalScript) {
    throw "Could not translate the v14 verified retrieval fallback into WSL."
}
& wsl.exe -d $WslDistro -- bash $wslRetrievalScript --confirm-verified-retrieval-v1 --project-root $ProjectRoot
if ($LASTEXITCODE -ne 0) {
    throw "The second v14 method did not execute cleanly. Preserve both methods' evidence, repair or change method, and continue the active goal."
}

Write-Host "Two distinct truth-free v14 methods have been measured. Inspect STATE.json and EXPERIMENTS.json, run the private final gate for an internally ready implementation, and continue with learned local features after a scored miss."
