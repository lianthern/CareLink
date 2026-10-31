# V9 RTX 4060 full-room canary report

**Final result: `FULL_ROOM_CANARY_ACCEPTED`.** The v9 Viewer is running now on loopback:

**http://127.0.0.1:8765/?scene=./tandt-meetingroom-v9.scene.json**

Max can try it in four steps: **(1)** open the URL, **(2)** use `+`/`−` or the mouse wheel to zoom, **(3)** walk with `WASD` and hold `Shift` for 3× sprint, **(4)** drag upward to inspect the lights, beams, and ceiling, then use any of the three photo cards to return exactly to a source camera. The Viewer and the existing loopback intake are still running; intake is `READY` at `http://127.0.0.1:8780/` and does not start training automatically.

Honest limitation: this is a one-stage 7k research canary. The center and normal walking region are coherent and visibly room-scale, but close foliage/chair edges, the straight-down view, and locations near the camera-hull boundary retain blur or floating Gaussian artifacts. SH2 compression did not finish within its 600-second limit, so the validated 6.28 MB Viewer asset uses SH1.

## Outcome

- The frozen 169 MB Hugging Face Meetingroom source and every machine/manual coverage gate passed.
- One user-authorized, corrected optimization run reached step `6999` from scratch in `300.449 s`; peak sampled VRAM was `3929 MiB`, exit code was `0`, and OOM was false.
- Thirteen held-out frames cover all 12 temporal bins. Mean metrics are PSNR `23.4887`, SSIM `0.8371`, LPIPS `0.2378`; worst values are PSNR `20.6959`, SSIM `0.8004`, LPIPS `0.2749`.
- PLY→SOG→PLY preserved all `404,711` exported Gaussians. The final SOG is SH1 because the documented SH2 attempt timed out; no silent downgrade occurred.
- v9 Chromium E2E passed with zero page/console errors. Start pitch and roll are `0°`, Y stays fixed during walking, all three anchors restore within `4e-9`, normal/sprint displacement ratio measured `3.098×`, and a two-axis route returned within `0.0061` scene units.
- Front, back, left, right, up, and down were rendered from the same center. Manual inspection confirmed usable room content in all six; the up view contains real roof beams/ceiling and visible lighting rather than an empty hole.
- The safe walkthrough is H.264, `1280×720`, `10.959 s`, and `494,813` bytes. It shows zoom in/out, normal movement, the on-screen `3×` sprint state, and look-up.

## Corrected retry provenance

The first `ns-train` process previously failed during CLI parsing after `7.352 s` and ran zero optimization steps. Its command, log, GPU samples, and result remain under `logs/first-attempt-cli-parse/`; that failure was not rewritten. After the user explicitly said to continue training, a single corrected retry was authorized in `logs/retry-authorization.json`. The retry used the `colmap` dataparser subcommand with `images_2` and `sparse_2/0`. In total there were two `ns-train` process invocations, but exactly one from-scratch optimization run and exactly 7000 optimization steps. No 15k/30k, resume, second optimization run, or automatic resolution downgrade occurred.

The final checkpoint is `296,441,362` bytes with SHA256 `c1c388deaef97c3eb4dc63801ba5fb4a28485320d02c96103250b234d99a8b24`. It remains only in WSL ext4 and was not uploaded.

## Source and input gates

- Source: exact pinned NerfBaselines Hugging Face revision, `169,378,633` bytes, SHA256 `2e1f86fd7b25314fbc0361b42f16bf77ee222ac50294777995e8ab737aee8d33`.
- Archive: exactly `376` allowed members; no absolute path, `..`, symlink, hardlink, or extra member.
- Dataset: `371` JPEGs at `980×543`; `371/371` registered images; one `PINHOLE` camera; `124,162` sparse points.
- Coverage: PCA ratio `0.456661`, hull area `55.778662`, trajectory/hull-diameter `7.531242`, all 12 bins populated.
- Manual sheet: floor in `9/12` bins and upper wall/light/beam/ceiling in `12/12`; footprint spans two planar directions.
- Dataparser split: 358 training and 13 held-out images, disjoint, with held-out coverage across all 12 bins.

## Training and export

Software was Nerfstudio `1.1.5`, PyTorch `2.1.2+cu121`, CUDA `12.1`, and an NVIDIA GeForce RTX 4060 Laptop GPU. Training used sparse 3D points, scale regularization, camera optimizer off, random initialization off, and the fixed interval-30 evaluation split.

The PLY contains `404,711` valid Gaussians (seven very-low-opacity entries were excluded by the exporter). Raw PLY SHA256 is `beaacf5d95a7ed01fcc31673cfa92059eae512901e1eca48f6922f7bc9083846`. The validated SOG SHA256 is `0106c7ce0b6e6984b6291a24b61af9f2c90dccb8b4fd08221b41913fb4017992`. The 600-second SH2 timeout and subsequent successful CPU SH1 conversion are preserved in `logs/export-v9.log`; conversion plus fallback took `994.676 s`.

## Viewer evidence

- `viewer-overview.png`: ready Viewer at the center walk pose.
- `viewer-route.png`: scene after a two-axis in-hull route and return.
- `direction-front.jpg`, `direction-back.jpg`, `direction-left.jpg`, `direction-right.jpg`, `direction-up.jpg`, `direction-down.jpg`: same-center directional coverage.
- `viewer-walkthrough-v9.mp4`: the 10.959-second user-flow recording.
- `logs/viewer-v9-e2e.json`: exact camera telemetry, movement measurements, anchor errors, and all pass/fail checks.
- `logs/evaluation.json`, `logs/export-result.json`, and `logs/viewer-manifest-validation.json`: held-out, roundtrip, and manifest evidence.

The retained v8 phase remained green before GPU work: 24/24 Python tests, 4/4 then-current schema manifests, v7 legacy Chromium E2E, and v8 regression Chromium E2E all passed. Adding v9 raised the schema set to 5/5 without altering the older manifests.

## Storage and security

Large source, COLMAP, checkpoint, PLY, roundtrip PLY, SOG, and training work remain in WSL ext4. Browser frames and temporary evidence were placed on `D:\UNSEEN\v9-work`; at final health check C: had about `5.87 GiB` free and D: `97.02 GiB` free. Moving the entire WSL distribution was not attempted because that machine-wide change needs separate coordination.

No source archive, source image set, COLMAP model, checkpoint, PLY, SOG, work directory, private media, token, or environment file is in this result. Only reports, sanitized logs, small screenshots, the safe sub-15 MB walkthrough, and code patches are returned. No production/paid API, firewall change, package installation, public listener, or LAN listener was used.
