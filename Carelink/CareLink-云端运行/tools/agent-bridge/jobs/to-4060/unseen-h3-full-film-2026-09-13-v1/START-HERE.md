# UNSEEN 完整影片制作：唯一 4060 执行入口

Job：`unseen-h3-full-film-2026-09-13-v1`。复用真实 Windows 会话 `01a098ec-6a73-7070-a239-b0d73104c896`。安装已验收，完整制作已获 Max 授权：“他做好了，你把东西都发给他开始让他生成完整吧，他可能要一段一段的来”。执行完整 110–140 秒影片，不停在 H01/H02；二者通过内部检查即继续。

先阅读本机适用 AGENTS、本 job 现有回执和本入口。权威创作合同是 `inputs/CREATIVE-CONTRACT.md`、`inputs/SHOTS.json` / `SHOTS.md`、`inputs/REFERENCES.json`、`inputs/CREATIVE-START-HERE.md`；全部沿原制作包，不重新策划。`inputs/4060-REUSE-AND-PRIVATE-BRIDGE.md` 固定既有运行时与边界。素材内旧 PACKAGE/安装文档是历史，不覆盖本 job 的派发与完整范围。

## 收到控制包后核素材

在已有 `AgentBridge-H3` checkout 中使用原接收器；不得另建 4060 执行端。接收器最后的通用“去 WSL 训练”提示不适用于此已核验 Windows H3 项目。运行时继续 `D:/H3-runtime/.venv` / `ComfyUI` / `models`，独立工作目录 `D:/H3-runtime/projects/unseen-full-v1`。

```powershell
$ErrorActionPreference = 'Stop'
$H3BridgeRoot = Join-Path $env:USERPROFILE 'AgentBridge-H3'
$H3ReceiveScript = Join-Path $H3BridgeRoot 'control/scripts/windows/Receive-BridgeJob.ps1'
$H3Results = @(& $H3ReceiveScript -JobId 'unseen-h3-full-film-2026-09-13-v1' -BridgeRoot $H3BridgeRoot)
$H3Typed = @($H3Results | Where-Object { $_.PSObject.TypeNames -contains 'UNSEEN.Bridge.ReceiveResult' })
if ($H3Typed.Count -ne 1) { throw 'Expected exactly one current typed receive result; do not select an old payload' }
$H3Received = $H3Typed[0]
if ($H3Received.JobId -cne 'unseen-h3-full-film-2026-09-13-v1' -or $H3Received.State -cne 'RECEIVED_VERIFIED') { throw 'Wrong receive identity/state' }
$H3Payload = $H3Received.PayloadRoot
$H3Project = 'D:/H3-runtime/projects/unseen-full-v1'
$H3InputsLock = Join-Path $H3Payload 'PRIVATE-INPUTS.json'
$H3Lock = Get-Content -LiteralPath $H3InputsLock -Raw -Encoding UTF8 | ConvertFrom-Json
if ($H3Lock.jobId -cne $H3Received.JobId -or $H3Lock.releaseTag -cne $H3Received.ReleaseTag -or $H3Lock.repository -cne 'maxi-max-dev/max-agent-bridge') { throw 'Private inputs identity mismatch' }
$H3Visibility = & gh repo view maxi-max-dev/max-agent-bridge --json visibility --jq .visibility
if ($LASTEXITCODE -ne 0 -or $H3Visibility -cne 'PRIVATE') { throw 'Private repository check failed' }
$H3DownloadDir = Join-Path $H3Project ('downloads/' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
New-Item -ItemType Directory -Path $H3DownloadDir -ErrorAction Stop | Out-Null
& gh release download $H3Lock.releaseTag --repo maxi-max-dev/max-agent-bridge --pattern $H3Lock.assetName --dir $H3DownloadDir
if ($LASTEXITCODE -ne 0) { throw 'Private input download failed; preserve partials' }
$H3InputReport = Join-Path $H3Project ('evidence/INPUTS-VERIFIED-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.json')
& 'D:/H3-runtime/.venv/Scripts/python.exe' -X utf8 (Join-Path $H3Payload 'inputs/verify_private_inputs.py') --manifest $H3InputsLock --archive (Join-Path $H3DownloadDir $H3Lock.assetName) --extract (Join-Path $H3Project 'media-inputs') --report $H3InputReport
if ($LASTEXITCODE -ne 0) { throw 'Private inputs failed verification; generation must not start' }
```

This prints `INPUTS-VERIFIED` only for media actually hashed on this host. Commit that resulting JSON as `results/from-4060/<job>/INPUTS-VERIFIED.json`, and retain original timestamped evidence locally. Record the exact control commit from `$H3Received.ControlCommit`. The existing receive script posts control `RECEIVED_VERIFIED` itself. Do not manually fabricate either receipt; Mac publisher verification is separate.

On resumption, reuse the existing verified project media and original typed receipt after rechecking hashes; do not rerun a completed download just because a new turn started. A corrupt existing file is retained/quarantined, never silently overwritten. Follow immutable Release asset names; signed URLs and credentials never enter manifests.

## 长流程开跑前：先修已知失锁缺口

Current `run_service.py` only waits for H3 child. Read actual current source and compare with preserved `inputs/run_service.original.txt`; if different, adapt to the real source. Preserve a timestamped original before editing. Do not change the WSL shared flock path or broaden generic Bridge scripts.

1. Supervise guard liveness concurrently with the H3 child for the whole service lifetime. EOF on guard stdout is also a loss signal: the actual WSL guard may die before the Windows `wsl.exe` wrapper exits. Keep startup timeout/error cleanup bounded. No `LOCKED` handshake means no child launch.
2. Before H3 launch capture guard identity; after launch capture H3 PID, exact command, process creation time, and descendants belonging to this launch. If guard unexpectedly exits/EOFs, fail closed: terminate only this verified H3 process tree, wait and confirm exit; never kill by global process name, stale PID, port alone or broad WSL shutdown. Prevent orphan grandchildren; on Windows an owned Job Object with kill-on-close is suitable if validated. Record any cleanup failure as failure, keep GPU work stopped.
3. On normal child exit release guard cleanly. Preserve service-exit reason, guard/child exit codes, identity evidence and source hashes. Do not relabel a guard loss as a successful render.
4. Test using isolated dummy guard/child/grandchild processes: no-lock startup; normal child exit; guard exit 0 while child active; guard nonzero exit; guard pipe EOF while wrapper remains; child-tree cleanup. Tests must never touch H3/3DGS production processes. Publish test commands and actual results, patched script and old/new hashes. Passing on Mac alone cannot stand in for Windows results.
5. Recheck current `8193` owner, GPU use and the shared queue through the existing lock entry. Do not assume old smoke success grants permanent GPU ownership. No stopping old 3DGS worker, removing locks or changing its lifecycle. If occupied, preserve progress and report `waiting_for_gpu`; do independent CPU work.

Then start only through the patched existing runner and require current LOCKED, service metadata and real `/object_info`. The existing 5/5 models and deps are reused; no reinstall/new weights, paid cloud, Seedance or rented GPU.

## 逐镜连续执行

19 H3 action shots + 17 controlled spatial/composite segments = 124.5 second planned edit. `inputs/BASE-T2V-API.json` and workflow are the exact successful installed baseline, **not** a proven image-conditioned graph. Inspect actual `MiniMaxH3ImageToVideo` node schema/source and connect its supported image input with a visibly verified reference. Do not guess node names or call pure T2V reference-conditioned. H01 may double as that real test. If reference conditioning cannot run, identify the precise missing node/capability and continue independent composition; do not randomize identities.

Before submitting each attempt freeze reference content and bytes/SHA, workflow/API, prompt, seed, params, output prefix, expected duration and local unique key `<job>/<shot>/attempt-01..03`. Save intent before POST, then response prompt_id; if response is lost, reconcile existing Comfy queue/history and filename before submitting again. A network retry is not permission to launch duplicates. Only one GPU generation at a time; existing smoke submission history stays untouched.

H01 → H02 → inspect both actual clips at the cut → remaining home H06/H07/H10/H11 → school S02/S03/S06/S07/S10/S11 → wedding W02/W03/W06/W07/W08 → elderly E01/E02. Per shot: initial attempt plus at most two targeted revisions, with the visible failure named and a changed factor recorded. Keep prior attempts. Then simplify coverage while keeping real action and story intent; if still unusable mark failed and continue independent shots. A missing/failed required shot prevents final pass.

H01/H02 boy stays standing, same clothes/table/tin/saucer, action runs forward. `cookie-b.png` seated child is an explicit counterexample; never use it as an approved first/last frame. Preserve mother/grandmother as different people. Girl identity freezes in classroom and continues through graduation/wedding/old age. E01/E02 use new apartment reading nook, not old dining table.

After each output: save source → actual full decode → sample beginning/middle/end and any action peak → agent visually inspects → write ledger → continue. Technical decode alone is not visual pass. Track rejects and accepted takes in `SHOT-LEDGER.json` using `inputs/SHOT-RECORD.example.json`. Stage upload after home/school/wedding and final review: source clips and sheets are separate private assets, hash manifest/summary in Git. Do not stop to wait for Max after the internal H01/H02 checkpoint.

For 17 spatial segments use actual generated covers and controlled space/thumbnail anchors. Normal film cuts within events; shrink to a small photo only after an event finishes. Move through human-scale home, campus and wedding spaces; whole-location shrink and same-direction horizontal slide only at the two location changes. Do not ask H3 to generate UI, shrink the room and change age in one clip. Report finite 2.5D honestly. Three spaces need internal experiences; campus cannot be one aerial zoom. All source labels, Chinese dialogue/text, phone screen replacement and concept ending are composed after generation.

Audio may use clean H3 environment, locally generated ambience and existing local voices, or clear Chinese dialogue text if no local TTS. Final must have an audio track; random speech/music is not accepted narration. No paid services. Preserve source resolution and exact crop/resample; 608×352 is not exact 16:9. Full output 1280×720/24 fps may be resampled and must be labelled in report.

## 回传与完成

Only this job's `receipts/from-4060/` and `results/from-4060/` paths; only this dedicated Issue. Original Issue22 gets one handoff link from Mac; Issue17 is untouched. Existing remote h3 heartbeat was paused at install completion: if needed, retarget/resume that existing mechanism for this authorized full job, preserving meaningful-change-only notifications. Do not create another monitor or another execution task. No receipt means published only; `RECEIVED_VERIFIED` + `INPUTS-VERIFIED` means received; real RUNNING plus submissions/output means started.

Return `STATUS.json`, `SHOT-LEDGER.json`, `REPORT.md`, input/guard verification, exact report commit, and `OUTPUT-ASSETS.json` with private asset names/bytes/SHA, source resolution, actual runtime, attempts and visual verdicts. Use append receipts via existing Submit-BridgeReceipt.ps1 for RUNNING/UPLOADING/COMPLETED or true BLOCKED/FAILED. Never include secrets or unrelated files. Preserve history.

Final required assets: `UNSEEN-H3-完整第一版.mp4`, light preview, 19 source shots/retained attempts, reproducible workflows/seeds/parameters/hashes/times, editable composition scripts, sampled frames and complete decode logs. Complete-film pass requires all 36 planned segments fulfilled, 110–140 seconds, audio, Chinese guide dialogue or text, source labels, concept-demo ending, continuity/spatial checks and actual full playback/decode. Report measured limitations; technical pass still awaits coordinator aesthetic acceptance. Report home done / school done / wedding done / final ready / genuine failure or one required user action, without repetitive status spam.
