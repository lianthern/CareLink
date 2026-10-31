# UNSEEN 3DGS visual-quality handoff

- Reviewed at (UTC): `2026-09-02T03:29:38Z`
- Job ID: `unseen-3dgs-sceneworker-2026-09-02-v1`
- Run ID: `preview-2026-09-02T021819+0000`
- Execution result: pipeline `COMPLETE`; CUDA training `PASS`; visual-quality gate `FAIL`
- Recommendation: **do not start the 30k quality run until the preview failure is explained**

## Bottom line

The generated scene loads, but its visual quality is not acceptable. The review was repeated after using **Return to source frame** and `Home`, with the camera at the exported source anchor (`X 1.42`, `Y/eye height 1.62`, `Z 2.18`, `FOV 58°`). The viewer reported `SOG ready` and displayed `240 FPS`, yet the room was still not coherent: large brown/cream regions were radially smeared, splats were stretched and blurry, and surfaces merged into warped sheets.

This separates the problem from a simple loading or free-camera-position mistake. The UI FPS is only a viewer-reported instantaneous value, not a formal performance benchmark; it shows that the renderer was responsive while the rendered reconstruction itself was poor.

## Evidence and measurements

| Item | Observed value |
|---|---:|
| Input / COLMAP registered frames | `72 / 72` |
| Training | `7000` steps, CUDA pass |
| Train wall time | `182.536 s` |
| Peak training VRAM | `2,876,243,968 bytes` |
| OOM events | `0` |
| Exported PLY | `44,159,233 bytes` |
| Preview SOG | `4,665,339 bytes` |
| SOG SHA-256 | `901d501dd41d254ed047322198cb283bdf2f146a92aeab94a16e1efecad5c223` |
| Successful SOG compression | `25.262 s` |
| Whole recorded pipeline | `2450.0 s` (includes an interrupted multi-SH compression attempt of about 35 minutes) |
| Viewer/network state | SOG ready; viewer and SOG endpoints returned HTTP 200 |
| Exact-anchor visual review | **FAIL** |

No screenshot was fabricated or added to this handoff; the assessment above came from live inspection of `http://127.0.0.1:4173/viewer/` on the 4060 machine.

## Important output compromise

`splat-transform 3.3.3` could not use the RTX GPU through WSL Vulkan. Its CPU conversion hung with more than one spherical-harmonics band, matching [PlayCanvas splat-transform issue #238](https://github.com/playcanvas/splat-transform/issues/238). The completed preview SOG therefore used the documented CPU workaround `-H 1 -i 2`.

That workaround can reduce view-dependent color/material fidelity, but it is unlikely by itself to explain the severe geometric-looking smearing. The uncompressed PLY and the trained checkpoint must be inspected before blaming SOG compression.

## Root-cause hypotheses, in priority order

1. **Capture/pose quality:** the source video may have weak parallax, motion blur, rolling shutter, auto-exposure changes, or a path unsuitable for 3DGS. `72/72` registration proves COLMAP found a connected model; it does not prove sufficiently accurate camera poses or dense geometry.
2. **Preview budget and coverage:** 72 frames capped at 1280 px and 7000 steps may be too small or unevenly sampled for this long interior take.
3. **Static-scene assumption:** moving objects, reflections, lighting variation, or texture-poor walls can generate elongated/unstable Gaussians.
4. **SOG conversion:** SH1/intensity-2 compression may make appearance flatter and less stable, though it should not be treated as the only cause.
5. **Coordinate/export/viewer transform:** anchor, scale, handedness, or camera transform could be wrong. This is less likely because the exact exported source anchor was also poor, but it still needs a direct PLY/checkpoint comparison.

## Required diagnostic sequence for the next agent

1. Keep the 30k quality profile gated off. Diagnose first; do not spend another full run blindly.
2. View the raw PLY directly (for example in SuperSplat or another known-good local Gaussian-splat viewer). If the PLY is already smeared, the defect is upstream of SOG compression.
3. Render one or more training-camera views from the Nerfstudio checkpoint and compare them with the corresponding source frames. Record side-by-side evidence or quantitative image metrics where practical.
4. Check camera transforms, scene scale/orientation, COLMAP reprojection errors and track lengths, and image sharpness/parallax—not just the registered-frame count.
5. If the checkpoint/PLY is good but the SOG is bad, test a conversion that preserves more SH bands (GPU/Windows conversion, updated `splat-transform`, or another supported format such as SPZ) on a copy.
6. If the checkpoint is bad, run only a small controlled experiment first: better frame selection, sharper frames, a more suitable static sample, or corrected camera preprocessing. Change one variable at a time.
7. Only unlock the 30k quality run after a preview produces a coherent room at several training-camera anchors.

## Same-machine local artifacts

These paths are intentionally **not** uploaded to GitHub:

- Project: `/home/max/src/unseen-3dgs-sceneworker`
- Raw PLY: `/home/max/src/unseen-3dgs-sceneworker/artifacts/export/preview/splat.ply`
- Preview SOG: `/home/max/src/unseen-3dgs-sceneworker/viewer/assets/scene.sog`
- Training config: `/home/max/src/unseen-3dgs-sceneworker/artifacts/training/preview-primary/pexels-home-interior-preview-primary/splatfacto/2026-09-02_101831/config.yml`
- Checkpoint: `/home/max/src/unseen-3dgs-sceneworker/artifacts/training/preview-primary/pexels-home-interior-preview-primary/splatfacto/2026-09-02_101831/step-000006999.ckpt`
- Stage logs: `/home/max/src/unseen-3dgs-sceneworker/logs`
- Allowlisted report outbox: `/home/max/src/unseen-3dgs-sceneworker/reports/outbox`

## Environment fixes already applied

- Corrected Windows-to-WSL path conversion in the PowerShell wrapper.
- Installed `python3.10-dev` and made the WSL doctor activate the project venv.
- Updated the handoff verifier to ignore installed dependency trees such as `.venv` and `.tools/node_modules`.
- Replaced source-built PyPI `gsplat 1.4.0` with precompiled `gsplat 1.4.0+pt21cu121`.
- Used `splat-transform -H 1 -i 2` as the bounded CPU workaround for the multi-SH hang.

## Data-sharing boundary

GitHub contains only the handoff, benchmark/status JSON, checksums, and logs. Do not commit the source video, extracted frames, PLY, SOG, checkpoint, `.env`, credentials, tokens, or private media. A future agent may add sanitized screenshots or comparison metrics, but should keep all raw artifacts local.
