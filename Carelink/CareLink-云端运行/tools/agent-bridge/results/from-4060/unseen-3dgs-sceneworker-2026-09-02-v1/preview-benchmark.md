# UNSEEN SceneCompiler benchmark

- Status: **COMPLETE**
- Run ID: preview-2026-09-02T021819+0000
- Profile: preview
- Record date: 2026-09-02
- Scene: [pexels-12956438-home-interior](https://www.pexels.com/video/a-long-take-video-showing-a-home-interior-design-12956438/)

> Numeric values below are measurements only. `PENDING` means the RTX 4060 Laptop run has not supplied evidence; it is not zero and not an estimate.

## Preparation host observation

- Status: **OBSERVED_NO_CUDA**
- Host: macOS 15.7.8 (24G824), arm64, Apple M4, 10-core integrated GPU
- NVIDIA tools: nvidia-smi=no, nvcc=no

## Execution host

| Field | Value |
|---|---|
| Status | OBSERVED |
| OS | Linux-6.6.87.2-microsoft-standard-WSL2-x86_64-with-glibc2.35 |
| CPU | x86_64 |
| RAM | 7.40 GiB |
| GPU | NVIDIA GeForce RTX 4060 Laptop GPU |
| GPU VRAM | 8.00 GiB |
| Power connected | PENDING |
| Discrete GPU mode | PENDING |
| NVIDIA driver | 596.49 |
| CUDA runtime | 12.1 |
| PyTorch / CUDA | 12.1 |

## Configuration

| Field | Value |
|---|---|
| Profile | preview |
| Maximum input frames | 72 |
| Maximum frame width | 1280 px |
| Requested train steps | 7000 |
| OOM fallback applied | no |
| OOM fallback notes | PENDING |

## Stage measurements

| Stage | Status | Wall time | Peak VRAM | Log |
|---|---:|---:|---:|---|
| Environment doctor | PASS | 1.861 s | 1.64 GiB | /home/max/src/unseen-3dgs-sceneworker/logs/preview-doctor-primary.log |
| Download + hash | PASS | 0.217 s | PENDING | /home/max/src/unseen-3dgs-sceneworker/logs/preview-download-primary.log |
| FFmpeg frame extraction | PASS | 0.018 s | PENDING | /home/max/src/unseen-3dgs-sceneworker/logs/preview-extract_frames-primary.log |
| COLMAP pose solve | PASS | 0.013 s | PENDING | /home/max/src/unseen-3dgs-sceneworker/logs/preview-colmap-primary.log |
| Splatfacto training | PASS | 182.536 s | 2.68 GiB | /home/max/src/unseen-3dgs-sceneworker/logs/preview-train-primary.log |
| PLY export | PASS | 18.949 s | 1.82 GiB | /home/max/src/unseen-3dgs-sceneworker/logs/preview-export_ply-primary.log |
| SOG compression | PASS | 25.262 s | 1.72 GiB | logs/preview-compress_sog-primary.log |
| Viewer smoke test | PENDING | PENDING | PENDING | PENDING |

## Result metrics

| Metric | Value |
|---|---:|
| Input frames | 72 |
| COLMAP registered / total | 72 / 72 |
| COLMAP registration ratio | 1 |
| Completed train steps | 7000 |
| PLY size | 42.11 MiB |
| SOG size | 4.45 MiB |
| Viewer FPS | PENDING |
| Viewer FPS sample window | PENDING |
| Generated-scene load time | PENDING |
| Total pipeline wall time | 2450 s |

## Three different clocks

| Clock | Status | Measured wall time | Meaning |
|---|---:|---:|---|
| One-time development | PENDING | PENDING | Environment setup and first end-to-end vertical slice; do not charge this to every scene. |
| Per-scene optimization | MEASURED | 2450 s | Frame extraction, pose solve, scene-specific Splatfacto optimization, export, and compression. |
| Generated-scene loading | PENDING | PENDING | Opening an already-generated SOG in the browser; not reconstruction time. |

## Validation

| Check | Status |
|---|---:|
| Cuda Training | PASS |
| Script Dry Run | PASS_PREPARATION_HOST |
| Static Checks | PASS_PREPARATION_HOST |
| Viewer Smoke Test | PASS_DEMO_AND_REFERENCE_SOG |

## OOM events

No event recorded. This does not mean that an RTX 4060 run has succeeded; the run is still pending.

## Notes

- Preparation host was observed to be an Apple M4 Mac without nvidia-smi or nvcc; CUDA training was not attempted there.
- Direct device smoke: PyTorch MPS was available, but a one-Gaussian gsplat render failed before rasterization because gsplat disabled its CUDA backend; see outputs/mac-mps-gsplat-smoke.log.
- Preparation evidence: the fixed download/hash/media probe and bounded frame extraction passed; a CPU-only COLMAP preflight registered 72/72 preview frames in its largest model.
- Viewer evidence: desktop/mobile controls and exact anchor restoration passed in demo mode, and the loader opened an official reference SOG; the scene-specific SOG remains pending CUDA training.
- The first numeric record must come from the RTX 4060 Laptop run. Planning ranges belong in README.md, not in measured fields.
- splat-transform 3.3.3 could not use the RTX GPU through WSL Vulkan and its CPU multi-SH SOG path reproduced upstream issue #238. The stuck attempt was interrupted after about 35 minutes; the successful preview SOG used the documented CPU workaround (-H 1, -i 2). Geometry and the 7000-step CUDA training output were unchanged.
- total_pipeline_wall_time_seconds includes the interrupted multi-SH compression attempt; the successful measured compression stage took 25.262 seconds.
