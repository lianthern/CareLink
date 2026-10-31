# UNSEEN v7 — Public Classroom Quality Run

**Result:** `COMPLETED_WITH_LIMITATIONS` — the best 7k scene passes every frozen SfM, image-quality, SOG, and Viewer gate. The single permitted 15k resume failed in the Nerfstudio/gsplat densification callback, so 7k remains best and 30k was correctly skipped.

- **Viewer URL:** http://127.0.0.1:8765/?scene=./pexels-classroom-v7.scene.json
- **Best stage:** `7000` (checkpoint step `6999`)
- **Total wall clock:** `01:08:29` / `4109.306 s` from RECEIVED_VERIFIED receipt to final report snapshot
- **Still running:** Viewer **yes**, v6 intake **yes**; both listen only on `127.0.0.1`
- **Max should click now:** **照片 1 · 首帧**, **照片 2 · 中段**, **照片 3 · 末帧**

This is a high-quality local preview, not a production-readiness claim. The Viewer is left running for direct inspection.

## Outcome

The frozen public Pexels classroom asset completed the real Windows → loopback intake → WSL ext4 path. Deterministic extraction produced 105 unique frames covering the full 17.884533-second source. COLMAP registered all 105 frames in one model, 7k training and held-out gates passed with substantial margin, and the preferred SH2 SOG round-tripped with all 68,164 Gaussians preserved.

Visual inspection of the first, middle, and last anchor renders shows recognizable desks, chairs, floor, radiator/window wall, and continuous room geometry. The three static comparisons and the bounded-WASD E2E did not expose large paper-like tearing. Some soft Gaussian edge texture remains, as expected for the selected 7k checkpoint.

## Phase A — frozen upload

- Frozen uploader: `4111` bytes, SHA256 `3031b9fcbc0ce3bc3e54640f12dc4ba97b8cb45cc0a8d1c673b6c5ab278ed643`; PowerShell parser errors `0`.
- Intake before and after the run: `READY`, HTTP 200, bind `127.0.0.1`, `trainingStartsAutomatically=false`.
- Intake job: `local-20260903T022428Z-ce09410a`.
- Uploaded bytes: `12,273,501`; SHA256 `b4dca2e138b475d5168bde72e61fe54beab9820b90aca1b22a4fe3739ea04ce6`; duration `17.884533 s`.
- Final intake state: `UPLOADED_VALIDATED_AWAITING_EXPLICIT_PREVIEW`; training started: `false`.
- The default Windows temporary copy and `.part` file are absent after completion.

## Phase B — deterministic SfM

Two pre-GPU implementation corrections were archived rather than overwritten: creation of the log parent before extraction, and the task-permitted COLMAP 3.7 correction `BundleAdjustment.refine_principal_point=0`. The final isolated run passed:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Registered | 105 / 105 | ≥100 / 105 |
| Sparse points | 8,187 | ≥6,500 |
| Observations | 156,692 | ≥120,000 |
| Mean track length | 19.139123 | ≥10 |
| Mean reprojection | 1.035019 px | ≤1.5 px |
| Zero adjacent steps | 0 | 0 |
| Max / median step | 1.510776 | ≤2.5 |

The one camera is `SIMPLE_RADIAL`, 1280×720, `f=1070.860867`, `cx=640`, `cy=360`, `k=-0.033995`. Focal ratio is `0.836610`; both principal-point offsets are zero. All three required anchor frames are registered. The explicit split contains 95 train frames and 10 held-out frames, with all photo anchors retained in train.

## Phase C — single checkpoint lineage

| Stage | Invocation | Start → end step | Wall | Peak VRAM | OOM | Outcome |
| --- | --- | --- | ---: | ---: | --- | --- |
| 7k | one from-scratch run | 0 → 6999 | 131.610 s | 2,953 MiB | false | PASS; checkpoint written |
| 15k | one resume from the verified 7k SHA | 7000 → null | 18.172 s | 2,863 MiB | false | FAILED; no checkpoint |
| 30k | not invoked | null | null | null | null | SKIPPED by frozen gate |

7k checkpoint: `58,161,298` bytes, SHA256 `97a6fb24a8bb9dd566ebda1c33d167ce658ab0b91ff37d41f73e6eb090783baa`.

The 15k process loaded that exact checkpoint and reached the first resumed step, then Nerfstudio 1.1.5/gsplat hit a CUDA index-out-of-bounds assertion during the first resumed densification callback. It was not an OOM. The one-resume contract forbade a retry, and without a completed/passing 15k stage the 30k condition was false.

### 7k quality gates

| Set / frame | PSNR ↑ | SSIM ↑ | LPIPS ↓ | Pass |
| --- | ---: | ---: | ---: | --- |
| frame_00001 | 38.2518 | 0.982099 | 0.059991 | yes |
| frame_00053 | 41.0480 | 0.986280 | 0.046687 | yes |
| frame_00105 | 37.5197 | 0.978333 | 0.080023 | yes |
| anchor mean | 38.9398 | 0.982238 | 0.062234 | yes |
| held-out mean (10) | 40.5319 | 0.985279 | 0.052960 | yes |

## Phase D — export and Viewer

- Raw PLY retained only on WSL ext4: 68,164 Gaussians, SH3, `16,906,264` bytes, SHA256 `8511b45234f997a45ed46d1355c0f2bdcc548f6ab9e620eb264601840ca00e8b`.
- Final SOG retained only on WSL ext4: 68,164 Gaussians, preferred SH2, `2,306,212` bytes, SHA256 `669e5699137a2c6f9698212c31d1038a3e6ce094f7f49e4e0c0dc4db1cc9fa8b`.
- SH2 conversion wall time: `169.675 s`.
- SOG → PLY roundtrip: 68,164 Gaussians, SH2, count preserved; SHA256 `f75238987a2c8e83952736c64cb732f2755d059a7312cff93e5c67f683ad3e2a`.
- Browser E2E: `SOG ready`; three 320×180 safe thumbnails; three photo buttons; 0 console errors.
- Worst anchor position error: `4.7352e-10`; quaternion error: `6.7858e-10`; FOV error: `0`.
- Bounded WASD movement: `0.106245`; return to middle anchor passed at the same error scale.
- FPS sample: `240` (sample only, not a benchmark).

## Verification and safety

- Python compilation: PASS (6 v7 Python scripts).
- Processor unit tests: 8/8 PASS.
- Viewer JSON Schema validation: PASS.
- Node syntax checks: PASS.
- HTTP health: Viewer page/manifest/SOG all 200; intake READY.
- Patch dry-apply and byte-for-byte reconstruction check: PASS.
- GPU training processes were serialized; training invocations: 2, from-scratch runs: 1.
- Production connections: 0; paid API calls: 0; firewall/portproxy changes: 0; private uploads: 0.
- GitHub evidence contains no source video, source frames, source thumbnails, checkpoint, PLY, SOG, COLMAP database, work directory, `.env`, or token.

The safe GitHub image evidence is limited to the Viewer overview and three composed comparison JPEGs. Large artifacts remain local and are identified only by size/hash.

