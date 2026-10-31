# UNSEEN v6 room scene and local video intake

Status: **COMPLETED**

Job: `unseen-3dgs-room-and-local-upload-2026-09-02-v6`

Completed: `2026-09-03T01:17:05Z`

## Authorization transition

The earlier sync-only audit correctly found no local v6 evidence and returned `FAILED`; that audit is preserved in `logs/sync-only-audit.json`. The user then explicitly authorized a fresh v6 execution, superseding the stale sync-only instruction, and the authorization was recorded on [Issue #6](https://github.com/maxi-max-dev/max-agent-bridge/issues/6#issuecomment-5509070845). This run stayed within the original cap: one 7k preview, zero 30k runs, zero private-video uploads, and zero production connections.

## Outcome

Both requested parts are operational on the RTX 4060 laptop:

- Room Viewer: `http://127.0.0.1:8765/?scene=./tum-room-v6.scene.json`
- Local video intake: `http://127.0.0.1:8780/`

Both servers are running and bind only to `127.0.0.1`. The Viewer is open in a visible Windows browser and reports `SOG ready`; the intake page was also opened by its Windows launcher. The intake validates MP4/MOV locally into WSL ext4 and does not start training.

## Local video intake

The four frozen inputs were installed only after their byte counts and SHA256 values matched `TASK.json`. Python compilation passed, all 5 intake tests passed, both PowerShell files parsed with zero errors, the executable forbidden-token scan returned zero hits, `ffprobe` was present, and the browser E2E passed with zero console errors. No user video was selected or uploaded.

Current state after the final service restart:

| Check | Result |
|---|---:|
| URL | `http://127.0.0.1:8780/` |
| Bind | `127.0.0.1:8780` |
| WSL PID | `563` |
| Windows launcher PID | `3088` |
| Windows loopback listener owner | `19252` |
| Windows HTTP | `200` |
| WSL HTTP | `200` |
| `trainingStartsAutomatically` | `false` |
| Browser E2E | `PASS` |

## TUM room fixture and adapter

The fixture is [TUM RGB-D `freiburg1/room`](https://cvg.cit.tum.de/data/datasets/rgbd-dataset), attributed to the Technical University of Munich and used under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). It was downloaded over HTTPS from the task's official URL, redirecting to `https://webshare.cvg.cit.tum.de/g/rgbd/dataset/freiburg1/rgbd_dataset_freiburg1_room.tgz`.

- Archive: `782,381,450` bytes; observed SHA256 `5ace47a1d2e53696bc939a84999293a04a7226958e848a609666691fd3cc38da` (observed, not claimed as pre-pinned).
- Safe extraction: `PASS`; 2,729 members / 2,726 regular files; absolute paths, parent traversal, backslashes, links, and special members rejected.
- Source truth: ground-truth trajectory 48.8991 s; valid RGB/depth/pose overlap 45.347991 s.
- Adapter: `--sample-hz 2.5 --max-frames 120 --seed 20260902`; 120 unique RGB frames, 108 train / 12 eval.
- Selected sensor coverage: 45.339663 s, or 99.9816% of the valid three-stream overlap. The full trajectory duration triggers the 120-frame cap; capped targets are then distributed across the complete valid overlap instead of truncating the first half.
- Timestamp maxima: target→RGB 17.57 ms, RGB→depth 18.45 ms, RGB→pose 4.90 ms.
- Seed: 191,183 finite colored points, bounded to 5 m and below the 200k cap.
- Anchors: `frame_00000`, `frame_00060`, `frame_00119`; rotations, positive depth, projection roundtrip, and train/eval split all passed.

Two early adapter-only preflight attempts produced 114 frames because they capped against the shorter overlap. Their incomplete output directories were removed before any training marker or GPU output existed. The corrected adapter contract then produced the final 120-frame dataset. These were not training runs.

## One-shot 7k training

The frozen standard known-pose, scale-regularized Nerfstudio `splatfacto` profile ran exactly once. It used the generated 120-frame dataset and real depth-derived sparse seed; no COLMAP and no random initialization were used.

| Field | Result |
|---|---:|
| Iterations | `7000/7000` |
| Checkpoint step | `6999` |
| Wall time | `270 s` |
| Exit code | `0` |
| OOM | `false` |
| Peak VRAM | `4,843 MiB` |
| Checkpoint bytes | `627,229,714` |
| 7k run count | `1` |
| 30k run count | `0` |

All three requested checkpoint anchors passed the inherited gate:

| Anchor | PSNR | SSIM | LPIPS |
|---|---:|---:|---:|
| `frame_00000` | 20.724 | 0.7690 | 0.2590 |
| `frame_00060` | 23.196 | 0.7827 | 0.2537 |
| `frame_00119` | 21.505 | 0.7540 | 0.2273 |
| Mean | **21.808** | **0.7685** | **0.2466** |

Thresholds were PSNR ≥18, SSIM ≥0.70, and LPIPS ≤0.40 for every anchor.

## PLY, SOG, and Viewer

- Raw PLY: 871,919 Gaussians, SH3, `216,237,505` bytes, SHA256 `f89f5ff293379b90821608bfc9ab2fa94bbaef2425c8dd75890cc7261d3e815b`.
- SOG: 871,919 Gaussians, SH1, `12,907,517` bytes, SHA256 `acd1734cfc4efe4e016ae41372d7186947e67524c30be6967a2978e1a11de2bd`.
- Raw PLY reproduced the checkpoint renders exactly at all anchors. SOG roundtrip versus raw PLY scored PSNR 31.53–35.84, SSIM 0.9607–0.9831, and LPIPS 0.0228–0.0420; structural validation passed.
- Manifest revision: `tum-freiburg1-room-v6-r001`; navigation boundary and three photo anchors were derived from real trained camera transforms.
- Browser E2E: `PASS`, sampled 234 FPS (sample only, not a benchmark), 0.1069 m bounded movement, fixed walk Y, exact XYZ/quaternion/FOV restore, and zero console errors.

Visual review: the room, desks, cabinets, and general layout are recognizable and navigable. The 7k preview and SH1 compressed SOG still show blur, soft surfaces, and some floating/merged details, so this is a truthful larger-room preview rather than a polished production reconstruction.

## Regression and safety

Final regression passed: intake 5/5, adapter 6/6, Viewer transform 2/2, safe extraction 3/3, Python compilation, Bash syntax, ShellCheck 0.11, and Node syntax checks. v4 default Viewer generation remained byte-compatible.

No production API, database, lease, token, paid API, firewall rule, port proxy, LAN/public listener, or automatic private-video training was used. The GitHub result contains only this report, structured summaries, logs, the code patch, and two non-private screenshots. It contains no TGZ, RGB/depth, source frames, video, SOG, PLY, checkpoint, work directory, `.env`, or token.

Bridge input-integrity hardening is separately proposed in [PR #7](https://github.com/maxi-max-dev/max-agent-bridge/pull/7); it adds an LF checkout contract and exact frozen-input verification so the Windows CRLF mismatch that caused the first audit is not repeated.
