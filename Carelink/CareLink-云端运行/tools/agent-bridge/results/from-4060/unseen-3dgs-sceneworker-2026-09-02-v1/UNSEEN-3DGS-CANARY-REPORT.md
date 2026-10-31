# UNSEEN 3DGS 4060 canary report

- Generated at (UTC): `2026-09-02T03:02:02+00:00`
- Profile: `preview`
- Job ID: `canary-pexels-12956438-preview-v1`
- Scene revision: `unseen-pexels-home-12956438-r001`
- Worker state: `ready`
- Benchmark status: `COMPLETE`
- Measurement status: `PARTIAL`

## Execution host

- OS: `Linux-6.6.87.2-microsoft-standard-WSL2-x86_64-with-glibc2.35`
- GPU: `NVIDIA GeForce RTX 4060 Laptop GPU`
- VRAM bytes: `8585740288`
- NVIDIA driver: `596.49`
- Torch / CUDA: `2.1.2+cu121` / `12.1`

## Measured result

- Input frames: `72`
- COLMAP registered / total: `72` / `72`
- Training steps completed: `7000`
- Total pipeline seconds: `2450.0`
- PLY bytes: `44159233`
- SOG bytes: `4665339`
- SOG SHA-256: `901d501dd41d254ed047322198cb283bdf2f146a92aeab94a16e1efecad5c223`
- Viewer FPS: `PENDING`
- Generated-scene load seconds: `PENDING`
- OOM events: `0`

## Post-run visual review

- Reviewed at (UTC): `2026-09-02T03:29:38Z`
- Viewer state: `SOG ready`; viewer and SOG endpoints returned HTTP 200
- Inspection pose: exact exported source-frame anchor (`X 1.42`, eye height `1.62`, `Z 2.18`, `FOV 58°`)
- UI-reported instantaneous FPS: `240` (not a formal benchmark sample)
- Visual-quality result: **FAIL** — severe radial smearing, stretched/blurry splats, and incoherent merged surfaces remained at the source anchor.
- Gate: **do not start the 30k quality run** until raw PLY/checkpoint views separate an upstream reconstruction problem from SOG conversion or viewer-transform issues.

See `NEXT-AGENT-HANDOFF.md` and `VISUAL-QUALITY-ASSESSMENT.json` for the prioritized diagnosis plan and machine-readable review.

## Execution notes

- splat-transform 3.3.3 could not use the RTX GPU through WSL Vulkan and its CPU multi-SH SOG path reproduced upstream issue #238. The stuck attempt was interrupted after about 35 minutes; the successful preview SOG used the documented CPU workaround (-H 1, -i 2). Geometry and the 7000-step CUDA training output were unchanged.
- total_pipeline_wall_time_seconds includes the interrupted multi-SH compression attempt; the successful measured compression stage took 25.262 seconds.

## Required human/browser checks

- [x] `scene.sog` loads from `./scripts/serve_viewer.sh` on the 4060 machine.
- [x] Exact photo-anchor return works; the source-anchor render itself fails the visual-quality gate.
- [ ] WASD/joystick, fixed eye height, and boundary behavior need a complete interaction pass.
- [ ] Viewer FPS/load fields above were measured and written back; otherwise they remain PENDING.
- [ ] No source video, frames, PLY/SOG, private media, or token was copied to iCloud.

## Evidence returned

Only the adjacent allowlisted report files are returned: benchmark JSON/Markdown, worker status, doctor/dry-run logs, stage logs, and checksums. Raw media and model artifacts are deliberately excluded.

## Production statement

This report proves only the isolated fixed-Pexels canary. The production adapter remains `CONTRACT_PENDING` and default off; no production API or database was touched.
