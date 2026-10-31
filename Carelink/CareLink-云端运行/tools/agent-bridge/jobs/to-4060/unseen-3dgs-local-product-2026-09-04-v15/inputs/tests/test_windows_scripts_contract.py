from __future__ import annotations

import unittest
from pathlib import Path


INPUTS = Path(__file__).resolve().parents[1]


def find_control_repo() -> Path | None:
    for candidate in Path(__file__).resolve().parents:
        if (
            (candidate / "scripts/windows/Receive-BridgeJob.ps1").is_file()
            and (candidate / "scripts/windows/Submit-BridgeReceipt.ps1").is_file()
        ):
            return candidate
    return None


REPO = find_control_repo() or INPUTS.parent
RECEIVE = REPO / "scripts/windows/Receive-BridgeJob.ps1"
SUBMIT = REPO / "scripts/windows/Submit-BridgeReceipt.ps1"
LAUNCHER = REPO / "scripts/windows/Start-V15-LocalProduct.ps1"
HARNESS = REPO / "scripts/windows/tests/Test-V15-LauncherRuntime.ps1"
WORKFLOW = REPO / ".github/workflows/validate-bridge.yml"
START = INPUTS / "scripts/windows/Start-UNSEEN-LocalProduct.ps1"
INSTALL_TASK = INPUTS / "scripts/windows/Install-Disabled-StartupTask.ps1"
PUBLISH = INPUTS / "scripts/windows/Publish-V15-VisualAcceptance.ps1"
START_HERE = INPUTS.parent / "START-HERE.md"
CONTROL_PLANE_AVAILABLE = RECEIVE.is_file() and SUBMIT.is_file() and LAUNCHER.is_file()
control_plane_only = unittest.skipUnless(
    CONTROL_PLANE_AVAILABLE,
    "requires the private Bridge control-repository layout",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_balanced_powershell(test: unittest.TestCase, text: str) -> None:
    """Small dependency-free lexical smoke check; real PS 5.1 remains a Windows gate."""
    pairs = {")": "(", "]": "[", "}": "{"}
    stack: list[tuple[str, int]] = []
    quote: str | None = None
    line_comment = False
    index = 0
    while index < len(text):
        char = text[index]
        if line_comment:
            if char in "\r\n":
                line_comment = False
            index += 1
            continue
        if quote == "'":
            if char == "'":
                if index + 1 < len(text) and text[index + 1] == "'":
                    index += 2
                    continue
                quote = None
            index += 1
            continue
        if quote == '"':
            if char == "`":
                index += 2
                continue
            if char == '"':
                quote = None
            index += 1
            continue
        if char == "#":
            line_comment = True
        elif char in "'\"":
            quote = char
        elif char in "([{":
            stack.append((char, index))
        elif char in ")]}":
            test.assertTrue(stack, f"unexpected {char!r} at character {index}")
            opening, opening_index = stack.pop()
            test.assertEqual(pairs[char], opening, f"mismatch at {opening_index}..{index}")
        index += 1
    test.assertIsNone(quote, "unterminated PowerShell string")
    test.assertFalse(stack, f"unclosed delimiters: {stack[-5:]}")


class WindowsScriptContractTests(unittest.TestCase):
    @control_plane_only
    def test_submit_uses_ps51_safe_resolve_and_trim_steps(self) -> None:
        script = read(SUBMIT)
        for required in (
            "$topText = ([string]$topRows[-1]).Trim()",
            "$resolvedTop = (Resolve-Path -LiteralPath $topText).Path",
            "$repoRoot.Equals($topRoot, [StringComparison]::OrdinalIgnoreCase)",
            "$privacyExit = $LASTEXITCODE",
            "$privacy = ([string]$privacyRows[0]).Trim().ToLowerInvariant()",
            '$taskState -cne "PUBLISHED"',
            "$task.receipt.directory -cne $relativeDir",
            "Local main has multiple unpublished commits; refusing receipt recovery",
            "Unpublished receipt does not match this exact retry",
            "Remove-OwnedUncommittedReceipt",
        ):
            self.assertIn(required, script)
        self.assertNotIn(
            "(Resolve-Path -LiteralPath ([string]$topRows[-1]).Trim()).Path",
            script,
        )

    @control_plane_only
    def test_submit_recovers_only_its_exact_receipt_transaction(self) -> None:
        script = read(SUBMIT)
        for required in (
            "Publish-ExactReceiptCommit",
            "Get-ValidatedRemoteReceiptLedger",
            "Remove-OwnedUncommittedReceipt",
            'hash-object "--path=$RelativePath"',
            "Unpublished receipt does not match this exact retry",
            "Latest remote receipt already has state $State but different content",
            "commit.gpgsign=false",
            "rm --cached --force --ignore-unmatch -- $RelativePath",
            "Remove-Item -LiteralPath $AbsolutePath -Force",
            "Receipt publication safely resumed",
            "Local\\MaxAgentBridge-Receipt-$JobId",
            "Receipt filename state disagrees with its JSON state",
            "Receipt filename timestamp disagrees with an exact UTC createdAt",
        ):
            self.assertIn(required, script)
        self.assertNotIn("Set-Content -LiteralPath $absolutePath", script)
        ahead = script.index('$ahead = @(& git -C $RepoDir rev-list')
        mkdir = script.index("New-Item -ItemType Directory -Force -Path $absoluteDir")
        self.assertLess(ahead, mkdir)

    @control_plane_only
    def test_submit_reads_every_remote_receipt_from_one_immutable_commit(self) -> None:
        script = read(SUBMIT)
        for required in (
            "ls-tree -r --full-tree $RemoteCommit -- $prefix",
            "cat-file -t $blob",
            "cat-file -s $Blob",
            "$process.StandardOutput.BaseStream.CopyTo($memory)",
            "New-Object System.Text.UTF8Encoding($false, $true)",
            "log --format=%H $RemoteCommit -- $relative",
            'rev-parse "$commit`:$relative"',
            "Remote receipt is not an immutable append-only ledger entry",
            "Remote receipt content no longer matches its immutable commit blob",
            "Two remote receipts have indistinguishable createdAt timestamps",
            "createdAt ordering disagrees with the origin/main commit history",
            "$fileName -cnotmatch",
        ):
            self.assertIn(required, script)
        self.assertNotIn("function Get-LatestRemoteReceipt", script)
        remote_ledger = script.index(
            "$remoteLedger = @(Get-ValidatedRemoteReceiptLedger"
        )
        ahead = script.index('$ahead = @(& git -C $RepoDir rev-list')
        self.assertLess(remote_ledger, ahead)

    @control_plane_only
    def test_submit_enforces_complete_v15_state_graph_and_race_recheck(self) -> None:
        script = read(SUBMIT)
        transition_block = script[
            script.index("function Test-AllowedV15Transition") :
            script.index("function Assert-V15LedgerStateMachine")
        ]
        for exact_case in (
            '"RECEIVED_VERIFIED" { @("RUNNING", "BLOCKED", "FAILED") }',
            '"RUNNING" { @("UPLOADING", "BLOCKED", "FAILED") }',
            '"UPLOADING" { @("COMPLETED", "BLOCKED", "FAILED") }',
            '"BLOCKED" { @("RUNNING") }',
            '"FAILED" { @("RUNNING") }',
            '"COMPLETED" { @() }',
        ):
            self.assertIn(exact_case, transition_block)
        for required in (
            "The first v15 receipt must be RECEIVED_VERIFIED",
            "same-state retries must be exact idempotent no-ops",
            "A same-state v15 receipt may only be an exact idempotent duplicate",
            '$enforceV15Transitions = $JobId -ceq "unseen-3dgs-local-product-2026-09-04-v15"',
            "Assert-ProposedV15Transition $remoteLedger $receiptRecord",
            "Assert-ProposedV15Transition $concurrentLedger $ProposedReceipt",
            "Get-ValidatedRemoteReceiptLedger $Checkout $publishedRemote",
        ):
            self.assertIn(required, script)
        publish = script[
            script.index("function Publish-ExactReceiptCommit") :
            script.index("function Test-AllowedV15Transition")
        ]
        fetch = publish.index("fetch origin main")
        concurrent_ledger = publish.index("$concurrentLedger = @(", fetch)
        transition = publish.index("Assert-ProposedV15Transition", concurrent_ledger)
        rebase = publish.index("rebase --autostash $concurrentRemote", transition)
        second_push = publish.index("push origin HEAD:main", rebase)
        self.assertLess(fetch, concurrent_ledger)
        self.assertLess(concurrent_ledger, transition)
        self.assertLess(transition, rebase)
        self.assertLess(rebase, second_push)

    def test_publisher_accepts_recovered_v15_history_but_keeps_latest_gate(self) -> None:
        script = read(PUBLISH)
        transition_block = script[
            script.index("$allowedNext = switch ($previous)") :
            script.index(
                'Assert-True ($allowedNext -ccontains $current)',
                script.index("$allowedNext = switch ($previous)"),
            )
        ]
        expected = {
            "RECEIVED_VERIFIED": ("RUNNING", "BLOCKED", "FAILED"),
            "RUNNING": ("UPLOADING", "BLOCKED", "FAILED"),
            "UPLOADING": ("COMPLETED", "BLOCKED", "FAILED"),
            "BLOCKED": ("RUNNING",),
            "FAILED": ("RUNNING",),
            "COMPLETED": (),
        }
        for state, next_states in expected.items():
            rendered = ", ".join(f'"{item}"' for item in next_states)
            self.assertIn(f'"{state}" {{ @({rendered}) }}', transition_block)
            self.assertNotIn(state, next_states, "same-state ledger entries must fail")

        recovered_history = ("RECEIVED_VERIFIED", "BLOCKED", "RUNNING")
        for previous, current in zip(recovered_history, recovered_history[1:]):
            self.assertIn(current, expected[previous])
        self.assertEqual(expected["COMPLETED"], ())
        self.assertIn(
            '$ordered[-1].State -cin @("RUNNING", "UPLOADING", "COMPLETED")',
            script,
        )

    @control_plane_only
    def test_receive_binds_clean_canonical_main_to_exact_origin(self) -> None:
        script = read(RECEIVE)
        for required in (
            "Get-CanonicalGitHubSlug",
            "remote get-url origin",
            "symbolic-ref --quiet --short HEAD",
            "status --porcelain=v1 --untracked-files=all",
            "rev-parse refs/remotes/origin/main",
            "Assert-ControlCheckout $controlDir $expectedRepo $false",
            "Assert-ControlCheckout $controlDir $expectedRepo $true",
        ):
            self.assertIn(required, script)

    @control_plane_only
    def test_receive_uses_one_locked_stream_for_hash_preflight_and_safe_extract(self) -> None:
        script = read(RECEIVE)
        function = script[
            script.index("function Receive-ZipPayloadFromLockedStream") :
            script.index("function Assert-PayloadManifest")
        ]
        for required in (
            "[IO.FileShare]::None",
            "$archiveSha256.ComputeHash($archiveStream)",
            "$archiveStream.Position = 0",
            "New-Object -TypeName IO.Compression.ZipArchive -ArgumentList $archiveArguments",
            "$maximumArchiveEntries = if ($HasPayloadManifest) { $maximumPayloadFiles + 1 }",
            "[StringComparer]::OrdinalIgnoreCase",
            "ExternalAttributes",
            "$windowsNonRegular = $external -band 0x450",
            "SetEquals($zipNames)",
            "$manifestWritten -gt ($maximumManifestBytes - [int64]$manifestRead)",
            "MANIFEST.json expanded beyond its declared or safe length",
            "MANIFEST.json expanded shorter than its declared length",
            "execution.entryPath is not a payload file declared by MANIFEST.json",
            "Current TASK.json and Release tag TASK.json disagree on execution.entryPath",
            "$targetPath.StartsWith($extractPrefix, [StringComparison]::OrdinalIgnoreCase)",
            "$parentPath.Equals($extractRootFull, [StringComparison]::OrdinalIgnoreCase)",
            "[IO.FileMode]::CreateNew",
            "ZIP member expanded beyond its declared length",
            "ZIP member expanded shorter than its declared length",
            "$archive.Dispose()",
            "$archiveStream.Dispose()",
        ):
            self.assertIn(required, function)
        for required in (
            "$maximumPayloadFiles = 4096",
            "$maximumArchiveEntryBytes = [int64](32 * 1MB)",
            "$maximumExpandedArchiveBytes = [int64](128 * 1MB)",
            "reserved Windows device name",
            "$runId = \"$stamp-$([guid]::NewGuid().ToString('N'))\"",
            "no old run was reused",
        ):
            self.assertIn(required, script)
        self.assertNotIn("Expand-Archive", script)
        self.assertNotIn("[IO.Compression.ZipFile]::OpenRead", script)
        opened = function.index("$archiveStream = [IO.File]::Open")
        hashed = function.index("$archiveSha256.ComputeHash($archiveStream)", opened)
        archive = function.index("New-Object -TypeName IO.Compression.ZipArchive", hashed)
        preflight = function.index("$windowsNonRegular = $external -band 0x450", archive)
        extracted = function.index("[IO.FileMode]::CreateNew", preflight)
        returned = function.index("AssetSha256 = $actualSha", extracted)
        archive_disposed = function.index("$archive.Dispose()", returned)
        stream_disposed = function.index("$archiveStream.Dispose()", archive_disposed)
        self.assertLess(opened, hashed)
        self.assertLess(hashed, archive)
        self.assertLess(archive, preflight)
        self.assertLess(preflight, extracted)
        self.assertLess(extracted, returned)
        self.assertLess(returned, archive_disposed)
        self.assertLess(archive_disposed, stream_disposed)

    @control_plane_only
    def test_receive_rejects_reparse_points_for_every_control_and_run_directory(self) -> None:
        script = read(RECEIVE)
        for required in (
            "function Assert-PlainDirectory",
            "function Ensure-PlainDirectory",
            "[IO.FileAttributes]::ReparsePoint",
            'Ensure-PlainDirectory $BridgeRoot "Bridge root"',
            'Assert-PlainDirectory $controlDir "Bridge control directory"',
            'Ensure-PlainDirectory $jobsRoot "Bridge jobs directory"',
            'Ensure-PlainDirectory $runParent "Bridge job receive directory"',
            'Assert-PlainDirectory $runRoot "Bridge receive run directory"',
            'Assert-PlainDirectory $downloadDir "Bridge download directory"',
            'Assert-PlainDirectory $extractDir "Bridge unpacked directory"',
            "Downloaded asset must not be a symlink or reparse point",
        ):
            self.assertIn(required, script)
        create_run = script.index("New-Item -ItemType Directory -Path $runRoot")
        verify_run = script.index('Assert-PlainDirectory $runRoot "Bridge receive run directory"')
        download = script.index("gh release download", verify_run)
        self.assertLess(create_run, verify_run)
        self.assertLess(verify_run, download)

    @control_plane_only
    def test_receive_binds_complete_head_task_blob_to_release_tag(self) -> None:
        script = read(RECEIVE)
        for required in (
            '$headTaskSpec = "HEAD`:$taskRelativePath"',
            '$tagTaskSpec = "$controlCommit`:$taskRelativePath"',
            "$headTaskBlobOutput = & git -C $controlDir rev-parse $headTaskSpec",
            "$tagTaskBlobOutput = & git -C $controlDir rev-parse $tagTaskSpec",
            "$headTaskBlob -cne $tagTaskBlob",
            "exact same TASK.json Git blob",
            '$workingTaskBlobOutput = & git -C $controlDir hash-object "--path=$taskRelativePath" -- $taskPath',
            "$workingTaskBlob -cne $headTaskBlob",
            "Checked-out TASK.json bytes do not match",
            "$tagTaskOutput = & git -C $controlDir show $tagTaskSpec",
        ):
            self.assertIn(required, script)
        head_blob = script.index("$headTaskBlobOutput =")
        tag_blob = script.index("$tagTaskBlobOutput =", head_blob)
        compare = script.index("$headTaskBlob -cne $tagTaskBlob", tag_blob)
        working_blob = script.index("$workingTaskBlobOutput =", compare)
        parse_tag = script.index("$tagTaskOutput =", working_blob)
        receive_zip = script.index("$zipEvidence = Receive-ZipPayloadFromLockedStream", parse_tag)
        self.assertLess(head_blob, tag_blob)
        self.assertLess(tag_blob, compare)
        self.assertLess(compare, working_blob)
        self.assertLess(working_blob, parse_tag)
        self.assertLess(parse_tag, receive_zip)

    @control_plane_only
    def test_receive_emits_one_typed_exact_run_result_only_after_receipt(self) -> None:
        script = read(RECEIVE)
        submit = script.index('& $submitScript -RepoDir $controlDir -JobId $JobId -State "RECEIVED_VERIFIED"')
        result = script.index('$receiveResult = [pscustomobject][ordered]@{')
        self.assertLess(submit, result)
        for required in (
            "RunRoot = $runRoot",
            "PayloadRoot = $extractDir",
            "EntryPath = $entryPath",
            "ReleaseTag = $releaseTag",
            "AssetSha256 = $actualSha",
            "ControlCommit = $controlCommit",
            "PayloadManifestSha256 = $resultManifestSha",
            '$receiveResult.PSObject.TypeNames.Insert(0, "UNSEEN.Bridge.ReceiveResult")',
            "Write-Output $receiveResult",
        ):
            self.assertIn(required, script[result:])

    @control_plane_only
    def test_v15_launcher_never_scans_or_falls_back_to_an_old_run(self) -> None:
        script = read(LAUNCHER)
        for required in (
            '$expectedType = "UNSEEN.Bridge.ReceiveResult"',
            "$receiveOutput = @(& $receiveScript -BridgeRoot $BridgeRoot -JobId $JobId)",
            "$receiveResults.Count -ne 1",
            "refusing to scan or reuse any prior payload",
            "$received.RunRoot",
            "$received.PayloadRoot",
            '$expectedPayloadRoot = [IO.Path]::GetFullPath((Join-Path $runRoot "unpacked"))',
            '$expectedEntryPath = [IO.Path]::GetFullPath((Join-Path $payloadRoot "START-HERE.md"))',
            '$receiptPath = Join-Path $payloadRoot ".bridge-receipt.json"',
            "Typed receiver result disagrees with the exact payload receipt",
            "& $startScript @startParameters",
            "Write-Output $received",
        ):
            self.assertIn(required, script)
        for forbidden in (
            "Get-ChildItem $runParent",
            "Sort-Object Name",
            "Select-Object -First 1",
        ):
            self.assertNotIn(forbidden, script)
        receive = script.index("$receiveOutput = @(& $receiveScript")
        validate = script.index("$receiveResults.Count -ne 1", receive)
        start = script.index("& $startScript @startParameters", validate)
        self.assertLess(receive, validate)
        self.assertLess(validate, start)

    @control_plane_only
    def test_windows_ci_runs_ps51_parser_and_launcher_runtime_harness(self) -> None:
        workflow = read(WORKFLOW)
        harness = read(HARNESS)
        for required in (
            "runs-on: windows-latest",
            "shell: powershell",
            '$PSVersionTable.PSVersion.Minor -ne 1',
            '$PSVersionTable.PSEdition -ne "Desktop"',
            "Test-V15-LauncherRuntime.ps1",
        ):
            self.assertIn(required, workflow)
        for required in (
            'Write-FakeReceiver "success"',
            'Assert-FailedWithoutStarter "throw"',
            'Assert-FailedWithoutStarter "zero"',
            'Assert-FailedWithoutStarter "two"',
            "V15_LAUNCHER_RUNTIME_PASS",
        ):
            self.assertIn(required, harness)
        assert_balanced_powershell(self, harness)

    def test_start_here_empty_machine_entry_bootstraps_and_clears_old_binding(self) -> None:
        document = read(START_HERE)
        clear = document.index("Remove-Variable Payload, LaunchOutput, LaunchResult")
        launch = document.index('Start-V15-LocalProduct.ps1')
        bootstrap = document.index("-Install -BootstrapDependencies -OpenBrowser", launch)
        self.assertLess(clear, launch)
        self.assertLess(launch, bootstrap)
        entry_block = document[document.index("```powershell") : document.index("```", document.index("```powershell") + 3)]
        self.assertNotIn("Sort-Object Name", entry_block)
        self.assertNotIn("Select-Object -First 1", entry_block)

    def test_start_always_verifies_payload_then_runs_fingerprinted_ext4_scripts(self) -> None:
        script = read(START)
        receipt = script.index("$verifiedReceipt = Read-VerifiedBridgeReceipt")
        manifest = script.index("$payloadVerification = Assert-CompletePayload")
        installed = script.index("Assert-InstalledRuntime $Distro")
        doctor = script.index("bash /home/max/src/unseen-local-product/app/doctor-local-product.sh")
        self.assertLess(receipt, manifest)
        self.assertLess(manifest, installed)
        self.assertLess(installed, doctor)
        self.assertNotIn('bash "$wslLinux/doctor-local-product.sh"', script)
        self.assertNotIn('bash "$wslLinux/bootstrap-dependencies.sh"', script)
        for required in (
            "release-evidence.json",
            "Installed runtime fingerprint mismatch",
            "/proc/[0-9]*/cmdline",
            "supervisor|runner",
            "Global\\UNSEEN-v15-local-product-start",
            "Assert-NoOrphanedRuntime",
            "System.Threading.Mutex",
            "Multiple owned $role processes exist",
        ):
            self.assertIn(required, script)

    def test_start_uses_verified_new_stopper_before_replacing_code(self) -> None:
        script = read(START)
        stop = script.index('bash "$wslLinux/stop-local-product.sh"')
        install = script.index('bash "$wslLinux/install-local-product.sh"')
        self.assertLess(stop, install)
        self.assertIn("Owned UNSEEN processes remain after the verified stop boundary", script)

    def test_scheduler_refuses_implicit_replace_and_rolls_back_failures(self) -> None:
        script = read(INSTALL_TASK)
        for required in (
            "[switch]$ReplaceExisting",
            "already exists. It was not changed",
            "Export-ScheduledTask",
            "Disable-ScheduledTask",
            "Unregister-ScheduledTask",
            "Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Xml $previousXml",
            "New-ScheduledTaskSettingsSet -Disable",
            "$installed.Settings.Enabled",
            "$installedActions[0].Arguments -cne $arguments",
            "MSFT_TaskLogonTrigger",
            "$installedTriggers[0].UserId -ine $currentUser",
            'Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName',
            "Task Scheduler did not restore the exact exported original XML",
        ):
            self.assertIn(required, script)

    def test_modified_scripts_have_balanced_delimiters(self) -> None:
        scripts = [START, INSTALL_TASK, PUBLISH]
        if CONTROL_PLANE_AVAILABLE:
            scripts = [RECEIVE, SUBMIT, LAUNCHER, HARNESS, *scripts]
        for path in scripts:
            with self.subTest(path=path.name):
                assert_balanced_powershell(self, read(path))


if __name__ == "__main__":
    unittest.main()
